/* ==========================================================================
   sleep-song — Sonos edition
   Single-tap play of a saved Sonos Favorite (one-track Spotify favorite),
   on infinite repeat. Talks to the Sonos Cloud Control API directly, so
   the speaker doesn't need to be an active Spotify Connect target — works
   even if the Sonos has been idle for hours.

   Auth: Sonos OAuth authorization-code grant. Token-exchange (which needs
   the client_secret) is proxied through a tiny Cloudflare Worker; the
   browser never sees the secret.
   ========================================================================== */

(() => {
  'use strict';

  // ---------- Config (filled in once Sonos integration + Worker exist) ----------
  // Public Sonos integration "Key". Safe to commit. Set when you create the
  // integration at https://developer.sonos.com/.
  const SONOS_CLIENT_ID = '__SONOS_CLIENT_ID__';

  // The Cloudflare Worker URL deployed from /worker. Looks like
  // https://sleep-song-token.<your-subdomain>.workers.dev
  const WORKER_URL = '__WORKER_URL__';

  // The track we want to wake up to. Stored only in setup notes / README;
  // the actual playback target is the Sonos Favorite the user has saved
  // for this track (Sonos API plays containers/favorites, not raw URIs).
  const TRACK_URI = 'spotify:track:3HC9bA5wmZsz0wtrCIt3I6';

  const SONOS_SCOPES   = 'playback-control-all';
  const SONOS_AUTH_URL = 'https://api.sonos.com/login/v3/oauth';
  const SONOS_API      = 'https://api.ws.sonos.com/control/api/v1';

  // Always derive redirect URI from the page URL so the same code works
  // for any deploy target (local file, Pages, custom domain).
  const REDIRECT_URI = (() => {
    const u = new URL(window.location.href);
    u.search = ''; u.hash = '';
    return u.toString();
  })();

  // ---------- Storage keys ----------
  const LS = {
    setupDone: 'ss.setupDone',          // '1' once the redirect URI step is acked
    tokens:    'ss.sonos.tokens',       // { access_token, refresh_token, expires_at }
    household: 'ss.sonos.household',    // { id }
    group:     'ss.sonos.group',        // { id, name }
    favorite:  'ss.sonos.favorite',     // { id, name }
    authState: 'ss.sonos.authState',    // transient OAuth state (sessionStorage)
  };

  // ---------- DOM helpers ----------
  const $    = (sel) => document.querySelector(sel);
  const $$   = (sel) => Array.from(document.querySelectorAll(sel));
  const show = (el)  => el && el.classList.remove('hidden');
  const hide = (el)  => el && el.classList.add('hidden');

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- Tokens ----------
  function loadTokens()   { try { return JSON.parse(localStorage.getItem(LS.tokens) || 'null'); } catch { return null; } }
  function saveTokens(t)  { localStorage.setItem(LS.tokens, JSON.stringify(t)); }
  function clearTokens()  { localStorage.removeItem(LS.tokens); }

  let refreshTimer = null;
  function scheduleRefresh(tokens) {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!tokens || !tokens.expires_at) return;
    // Refresh 2 minutes before expiry; never sooner than 5 s.
    const ms = Math.max(5_000, tokens.expires_at - Date.now() - 120_000);
    refreshTimer = setTimeout(() => { refreshAccessToken().catch(() => {}); }, ms);
  }

  async function workerExchange(payload) {
    if (!WORKER_URL || WORKER_URL.startsWith('__')) {
      throw new Error('Worker URL not configured. Edit app.js: WORKER_URL.');
    }
    const res = await fetch(`${WORKER_URL}/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error_description || data.error || data.detail)) || text || res.statusText;
      throw new Error(`token endpoint ${res.status}: ${msg}`);
    }
    return data;
  }

  async function exchangeCodeForTokens(code) {
    const j = await workerExchange({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    const tokens = {
      access_token:  j.access_token,
      refresh_token: j.refresh_token,
      expires_at:    Date.now() + ((j.expires_in || 86400) * 1000),
    };
    saveTokens(tokens);
    scheduleRefresh(tokens);
    return tokens;
  }

  async function refreshAccessToken() {
    const tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) throw new Error('no refresh token');
    let j;
    try {
      j = await workerExchange({
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
      });
    } catch (e) {
      // If refresh fails permanently, force re-auth.
      if (/\b(400|401)\b/.test(e.message)) clearTokens();
      throw e;
    }
    const updated = {
      access_token:  j.access_token,
      refresh_token: j.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + ((j.expires_in || 86400) * 1000),
    };
    saveTokens(updated);
    scheduleRefresh(updated);
    return updated;
  }

  async function getValidToken() {
    let tokens = loadTokens();
    if (!tokens) throw new Error('not authenticated');
    if (Date.now() > (tokens.expires_at - 30_000)) {
      tokens = await refreshAccessToken();
    }
    return tokens.access_token;
  }

  // ---------- Sonos API ----------
  async function sonos(method, path, { body, retry = true } = {}) {
    const token = await getValidToken();
    const init = {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(SONOS_API + path, init);
    if (res.status === 401 && retry) {
      try { await refreshAccessToken(); }
      catch { clearTokens(); throw new Error('session expired'); }
      return sonos(method, path, { body, retry: false });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.errorCode || data.reason || data.message)) || text || res.statusText;
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      err.data   = data;
      throw err;
    }
    return data;
  }

  async function listHouseholds()                  { return sonos('GET', `/households`); }
  async function listGroups(hh)                    { return sonos('GET', `/households/${encodeURIComponent(hh)}/groups`); }
  async function listFavorites(hh)                 { return sonos('GET', `/households/${encodeURIComponent(hh)}/favorites`); }
  async function getPlaybackStatus(groupId)        { return sonos('GET', `/groups/${encodeURIComponent(groupId)}/playback`); }
  async function loadFavorite(groupId, favoriteId) {
    return sonos('POST', `/groups/${encodeURIComponent(groupId)}/favorites`, {
      body: {
        favoriteId,
        action: 'REPLACE',
        playOnCompletion: true,
        playModes: { repeat: false, repeatOne: true, shuffle: false, crossfade: false },
      },
    });
  }
  async function pausePlayback(groupId) { return sonos('POST', `/groups/${encodeURIComponent(groupId)}/playback/pause`); }
  async function resumePlayback(groupId){ return sonos('POST', `/groups/${encodeURIComponent(groupId)}/playback/play`); }

  // ---------- Auth flow ----------
  function randomString(len = 32) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return [...arr].map((b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  }

  function startLogin() {
    if (!SONOS_CLIENT_ID || SONOS_CLIENT_ID.startsWith('__')) {
      setSetupError('Sonos client ID not configured. Edit app.js: SONOS_CLIENT_ID.');
      return;
    }
    const state = randomString(24);
    sessionStorage.setItem(LS.authState, state);
    const params = new URLSearchParams({
      client_id:     SONOS_CLIENT_ID,
      response_type: 'code',
      state,
      scope:         SONOS_SCOPES,
      redirect_uri:  REDIRECT_URI,
    });
    window.location.assign(`${SONOS_AUTH_URL}?${params.toString()}`);
  }

  async function handleCallbackIfPresent() {
    const url   = new URL(window.location.href);
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (!code && !error) return false;

    window.history.replaceState({}, '', url.pathname);

    if (error) {
      setSetupError(`Sonos auth error: ${error}`);
      return true;
    }

    const expected = sessionStorage.getItem(LS.authState);
    sessionStorage.removeItem(LS.authState);
    if (!expected || state !== expected) {
      setSetupError('auth state mismatch — please try again');
      return true;
    }

    try { await exchangeCodeForTokens(code); }
    catch (e) { setSetupError(`token exchange failed: ${e.message}`); return true; }
    return true;
  }

  // ---------- Wizard ----------
  function setSetupError(msg) {
    const el = $('#setup-error');
    if (!msg) { el.textContent = ''; hide(el); return; }
    el.textContent = msg;
    show(el);
  }

  function showStep(n) {
    $$('#setup .step').forEach((s) => {
      s.classList.toggle('hidden', Number(s.dataset.step) !== n);
    });
  }

  function loadHousehold() { try { return JSON.parse(localStorage.getItem(LS.household) || 'null'); } catch { return null; } }
  function loadGroup()     { try { return JSON.parse(localStorage.getItem(LS.group)     || 'null'); } catch { return null; } }
  function loadFavoriteRef(){ try { return JSON.parse(localStorage.getItem(LS.favorite) || 'null'); } catch { return null; } }

  // Step 3: pick group (auto-detect household).
  async function loadGroupsStep() {
    const list = $('#group-list');
    list.innerHTML = '<div class="loading">Loading speakers…</div>';
    setSetupError('');
    try {
      let hh = loadHousehold();
      if (!hh) {
        const households = await listHouseholds();
        const arr = (households && households.households) || [];
        if (arr.length === 0) throw new Error('no Sonos households on this account');
        hh = { id: arr[0].id };
        localStorage.setItem(LS.household, JSON.stringify(hh));
      }
      const groupsResp = await listGroups(hh.id);
      const groups = (groupsResp && groupsResp.groups) || [];
      list.innerHTML = '';
      if (groups.length === 0) {
        list.innerHTML = `<div class="device empty">No groups in this household. Make sure your speakers are powered on.</div>`;
        return;
      }
      groups.forEach((g) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'device';
        btn.innerHTML = `
          <div style="flex:1; min-width:0;">
            <div class="name">${escapeHtml(g.name)}</div>
            <div class="meta">${escapeHtml((g.playerIds || []).length + ' player(s)')}</div>
          </div>
          <span class="badge">group</span>`;
        btn.addEventListener('click', () => {
          localStorage.setItem(LS.group, JSON.stringify({ id: g.id, name: g.name }));
          renderSetup(4);
        });
        list.appendChild(btn);
      });
    } catch (e) {
      list.innerHTML = '';
      setSetupError(`couldn't load groups: ${e.message}`);
    }
  }

  // Step 4: pick favorite.
  async function loadFavoritesStep() {
    const list = $('#favorite-list');
    list.innerHTML = '<div class="loading">Loading your Sonos Favorites…</div>';
    setSetupError('');
    try {
      const hh = loadHousehold();
      if (!hh) { renderSetup(3); return; }
      const resp = await listFavorites(hh.id);
      const favs = (resp && resp.items) || [];
      list.innerHTML = '';
      if (favs.length === 0) {
        list.innerHTML = `
          <div class="device empty">
            No Sonos Favorites yet. In the Sonos app, find your sleep song,
            long-press it and choose <em>Add to Sonos Favorites</em>, then tap Refresh.
          </div>`;
        return;
      }
      favs.forEach((f) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'device';
        btn.innerHTML = `
          <div style="flex:1; min-width:0;">
            <div class="name">${escapeHtml(f.name || 'Untitled favorite')}</div>
            <div class="meta">${escapeHtml(f.description || (f.service && f.service.name) || 'favorite')}</div>
          </div>
          <span class="badge">favorite</span>`;
        btn.addEventListener('click', () => {
          localStorage.setItem(LS.favorite, JSON.stringify({ id: f.id, name: f.name }));
          renderMain();
        });
        list.appendChild(btn);
      });
    } catch (e) {
      list.innerHTML = '';
      setSetupError(`couldn't load favorites: ${e.message}`);
    }
  }

  // ---------- Main screen ----------
  let isPlaying = false;
  let busy      = false;

  function setMainError(msg) {
    const el = $('#main-error');
    if (!msg) { el.textContent = ''; hide(el); return; }
    el.textContent = msg;
    show(el);
  }

  function setIcon(which) {
    const map = { play: '#icon-play', pause: '#icon-pause', spin: '#icon-spin' };
    Object.values(map).forEach((sel) => hide($(sel)));
    show($(map[which]));
  }

  function setPlayingUI(playing) {
    isPlaying = playing;
    const tap = $('#tap');
    tap.classList.toggle('playing', playing);
    tap.setAttribute('aria-label', playing ? 'Pause sleep song' : 'Play sleep song');
    setIcon(playing ? 'pause' : 'play');
    $('#status').textContent = playing ? 'playing · loops forever' : 'tap to play';
  }

  async function syncStateFromSonos() {
    const g = loadGroup();
    if (!g) { setPlayingUI(false); return; }
    try {
      const status = await getPlaybackStatus(g.id);
      const state = status && status.playbackState;
      setPlayingUI(state === 'PLAYBACK_STATE_PLAYING' || state === 'PLAYBACK_STATE_BUFFERING');
    } catch {
      setPlayingUI(false);
    }
  }

  async function play() {
    const g = loadGroup();
    const f = loadFavoriteRef();
    if (!g) throw new Error('no speaker selected');
    if (!f) throw new Error('no favorite selected');
    await loadFavorite(g.id, f.id);
  }

  async function pause() {
    const g = loadGroup();
    if (!g) return;
    try { await pausePlayback(g.id); }
    catch (e) {
      // Sonos returns 410/409 when nothing is playing — swallow.
      if (e.status !== 409 && e.status !== 410 && e.status !== 404) throw e;
    }
  }

  async function onTap() {
    if (busy) return;
    busy = true;
    setMainError('');
    setIcon('spin');
    try {
      if (isPlaying) {
        await pause();
        setPlayingUI(false);
      } else {
        await play();
        setPlayingUI(true);
      }
    } catch (e) {
      console.error(e);
      setPlayingUI(isPlaying);
      let msg = e.message || 'something went wrong';
      if (e.status === 410) msg = 'group is gone — pick a different speaker in setup';
      setMainError(msg);
    } finally {
      busy = false;
    }
  }

  // ---------- Routing / render ----------
  function renderSetup(step) {
    $('#redirect-uri').textContent = REDIRECT_URI;
    hide($('#main')); hide($('#loader'));
    show($('#setup'));
    showStep(step);
    if (step === 3) loadGroupsStep();
    if (step === 4) loadFavoritesStep();
  }

  function renderMain() {
    hide($('#setup')); hide($('#loader'));
    show($('#main'));
    const g = loadGroup();
    const f = loadFavoriteRef();
    $('#device-pill').textContent =
      (g ? `▸ ${g.name}` : 'no speaker') + (f ? ` · ${f.name}` : '');
    setPlayingUI(false);
    syncStateFromSonos();
  }

  function decideRoute() {
    const tokens     = loadTokens();
    const setupDone  = localStorage.getItem(LS.setupDone) === '1';
    const group      = loadGroup();
    const favorite   = loadFavoriteRef();
    if (tokens) scheduleRefresh(tokens);
    if (!setupDone)        return renderSetup(1);
    if (!tokens)           return renderSetup(2);
    if (!group)            return renderSetup(3);
    if (!favorite)         return renderSetup(4);
    return renderMain();
  }

  // ---------- Wire up ----------
  function wire() {
    // Step 1
    $('#copy-redirect').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(REDIRECT_URI);
        const b = $('#copy-redirect');
        const prev = b.textContent;
        b.textContent = 'Copied!';
        setTimeout(() => (b.textContent = prev), 1200);
      } catch {
        const range = document.createRange();
        range.selectNodeContents($('#redirect-uri'));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
      }
    });
    $('#step1-done').addEventListener('click', () => {
      localStorage.setItem(LS.setupDone, '1');
      renderSetup(2);
    });

    // Step 2
    $('#connect-sonos').addEventListener('click', () => {
      try { startLogin(); }
      catch (e) { setSetupError(e.message); }
    });

    // Step 3
    $('#refresh-groups').addEventListener('click', loadGroupsStep);

    // Step 4
    $('#refresh-favorites').addEventListener('click', loadFavoritesStep);

    // Main
    $('#tap').addEventListener('click', onTap);
    $('#change-speaker').addEventListener('click', () => {
      localStorage.removeItem(LS.group);
      renderSetup(3);
    });
    $('#change-favorite').addEventListener('click', () => {
      localStorage.removeItem(LS.favorite);
      renderSetup(4);
    });
    $('#reset-app').addEventListener('click', () => {
      if (!confirm('Reset Sleep Song? You will need to reconnect Sonos.')) return;
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
      window.location.reload();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && loadTokens() && loadGroup()) syncStateFromSonos();
    });
  }

  // ---------- Boot ----------
  (async function boot() {
    wire();
    try {
      const handled = await handleCallbackIfPresent();
      if (handled && loadTokens()) {
        if (!loadGroup()) return renderSetup(3);
        if (!loadFavoriteRef()) return renderSetup(4);
        return renderMain();
      }
    } catch (e) {
      console.error(e);
    }
    decideRoute();
  })();
})();