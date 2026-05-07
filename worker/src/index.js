/**
 * sleep-song-token — tiny Cloudflare Worker that:
 *   1. Holds the Sonos OAuth client_secret and proxies the token-exchange
 *      step (the only step that requires the secret).
 *   2. Proxies all Sonos Cloud Control API calls so the browser can talk
 *      to Sonos despite the Sonos API not exposing CORS headers.
 *
 * The user's Sonos OAuth bearer token is sent through this Worker on every
 * API call. The Worker doesn't store it; it just forwards it to Sonos and
 * relays the response with CORS headers attached.
 *
 * Endpoints:
 *   POST /token        body: { grant_type: 'authorization_code', code, redirect_uri }
 *                       or:  { grant_type: 'refresh_token',     refresh_token }
 *   ANY  /api/...      proxied to https://api.ws.sonos.com/control/api/v1/...
 *                       (Authorization: Bearer ... must be supplied by the client)
 *   OPTIONS *          (CORS preflight)
 *
 * Required environment variables (set as encrypted secrets):
 *   SONOS_CLIENT_ID
 *   SONOS_CLIENT_SECRET
 *
 * Optional environment variables:
 *   ALLOWED_ORIGIN     default: https://jigarmadia.github.io
 *                      (comma-separate to allow multiple)
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const SONOS_API_BASE  = 'https://api.ws.sonos.com/control/api/v1';
const DEFAULT_ALLOWED_ORIGIN = 'https://jigarmadia.github.io';

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(origin, allowed) {
  const ok = allowed.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin':  ok,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '600',
    'Vary': 'Origin',
  };
}

function json(body, init, cors) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...(init && init.headers), ...cors, 'Content-Type': 'application/json' },
  });
}

async function handleToken(request, env, cors) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, { status: 405 }, cors);
  }
  const clientId     = env.SONOS_CLIENT_ID;
  const clientSecret = env.SONOS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: 'worker not configured: missing SONOS_CLIENT_ID / SONOS_CLIENT_SECRET' },
                { status: 500 }, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid json' }, { status: 400 }, cors); }

  const params = new URLSearchParams();
  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.redirect_uri) {
      return json({ error: 'missing code or redirect_uri' }, { status: 400 }, cors);
    }
    params.set('grant_type',   'authorization_code');
    params.set('code',         body.code);
    params.set('redirect_uri', body.redirect_uri);
  } else if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) {
      return json({ error: 'missing refresh_token' }, { status: 400 }, cors);
    }
    params.set('grant_type',    'refresh_token');
    params.set('refresh_token', body.refresh_token);
  } else {
    return json({ error: 'unsupported grant_type' }, { status: 400 }, cors);
  }

  const basic = btoa(`${clientId}:${clientSecret}`);
  let upstream;
  try {
    upstream = await fetch(SONOS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Accept':        'application/json',
      },
      body: params,
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, { status: 502 }, cors);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}

async function handleApiProxy(request, url, cors) {
  // /api/foo/bar?x=y  ->  https://api.ws.sonos.com/control/api/v1/foo/bar?x=y
  const subPath = url.pathname.replace(/^\/api/, '');
  if (!subPath || !subPath.startsWith('/')) {
    return json({ error: 'invalid api path' }, { status: 400 }, cors);
  }
  const target = `${SONOS_API_BASE}${subPath}${url.search}`;

  const auth = request.headers.get('Authorization');
  if (!auth) {
    return json({ error: 'missing Authorization header' }, { status: 401 }, cors);
  }

  const init = {
    method: request.method,
    headers: {
      'Authorization': auth,
      'Accept':        'application/json',
    },
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
    init.body = await request.text();
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e) }, { status: 502 }, cors);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const allowed = parseAllowedOrigins(env);
    const origin  = request.headers.get('Origin') || '';
    const cors    = corsHeaders(origin, allowed);
    const url     = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/token') {
      return handleToken(request, env, cors);
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApiProxy(request, url, cors);
    }
    return json({ error: 'not found' }, { status: 404 }, cors);
  },
};