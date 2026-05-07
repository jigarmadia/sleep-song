/**
 * sleep-song-token — tiny Cloudflare Worker that holds the Sonos OAuth
 * client_secret and proxies the token-exchange step. The browser app
 * never sees the secret.
 *
 * Endpoints:
 *   POST /token  body: { grant_type: 'authorization_code', code, redirect_uri }
 *                  or:  { grant_type: 'refresh_token',     refresh_token }
 *   OPTIONS /token   (CORS preflight)
 *
 * Required environment variables (set as encrypted secrets):
 *   SONOS_CLIENT_ID
 *   SONOS_CLIENT_SECRET
 *
 * Optional environment variables:
 *   ALLOWED_ORIGIN   default: https://jigarmadia.github.io
 *                    (comma-separate to allow multiple)
 */

const SONOS_TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
const DEFAULT_ALLOWED_ORIGIN = 'https://jigarmadia.github.io';

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function corsHeaders(origin, allowed) {
  const ok = allowed.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin':  ok,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request, env) {
    const allowed = parseAllowedOrigins(env);
    const origin  = request.headers.get('Origin') || '';
    const cors    = corsHeaders(origin, allowed);
    const url     = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname !== '/token') {
      return json({ error: 'not found' }, { status: 404 }, cors);
    }
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
      return json({ error: 'upstream fetch failed', detail: String(e) },
                  { status: 502 }, cors);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    });
  },
};
