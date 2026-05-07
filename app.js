/* ==========================================================================
   sleep-song
   Pure client-side Spotify PKCE → play one track on a Sonos (Spotify Connect)
   speaker in one tap, with track-repeat. No backend.
   ========================================================================== */

(() => {
  'use strict';

  // ---------- Config ----------
  const CLIENT_ID  = '03f28a9a95cd414e8ccdad845f50dbe4';
  const TRACK_URI  = 'spotify:track:3HC9bA5wmZsz0wtrCIt3I6';
  const TRACK_ID   = TRACK_URI.split(':').pop();
  const SCOPES     = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
  ].join(' ');

  // Always derive the redirect URI from the page's own URL (without query/hash).
  // This is what we ask the user to register in their Spotify dashboard.
  const REDIRECT_URI = (() => {
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    // Spotify requires an exact match. Trailing-slash sensitive.
    return u.toString();
  })();

  const AUTH_URL  = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API       = 'https://api.spotify.com/v1';

  const LS = {
    tokens:    'ss.tokens',     // { access_token, refresh_token, expires_at }
    device:    'ss.device',     // { id, name, type }
    setupDone: 'ss.setupDone',  // '1' once redirect URI step acked
    verifier:  'ss.pkce.v',     // PKCE code verifier (transient)
    authState: 'ss.pkce.s',     // PKCE state (transient)
  };

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  // ---------- PKCE ----------
  function randomString(len = 64) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return [...arr].map(b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  }
  async function sha256(input) {
    const data = new TextEncoder().encode(input);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  }
  function base64url(bytes) {
    let s = btoa(String.fromCharCode(...bytes));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function challenge(verifier) {
    return base64url(await sha256(verifier));
  }

  // ---------- Token storage / refresh ----------
  function loadTokens() {
    try { return JSON.parse(localStorage.getItem(LS.tokens) || 'null'); }
    catch { return null; }
  }
  function saveTokens(t) {
    localStorage.setItem(LS.tokens, JSON.stringify(t));
  }
  function clearTokens() {
    localStorage.removeItem(LS.tokens);
  }

  let refreshTimer = null;
  function scheduleRefresh(tokens) {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!tokens || !tokens.expires_at) return;
    // Refresh 60s before expiry, with min 5s.
    const ms = Math.max(5_000, tokens.expires_at - Date.now() - 60_000);
    refreshTimer = setTimeout(() => { refreshAccessToken().catch(() => {}); }, ms);
  }

  async function exchangeCodeForTokens(code, verifier) {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      code_verifier: verifier,
    });
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`token exchange failed: ${res.status} ${txt}`);
    }
    const j = await res.json();
    const tokens = {
      access_token:  j.access_token,
      refresh_token: j.refresh_token,
      expires_at:    Date.now() + (j.expires_in * 1000),
    };
    saveTokens(tokens);
    scheduleRefresh(tokens);
    return tokens;
  }

  async function refreshAccessToken() {
    const tokens = loadTokens();
    if (!tokens || !tokens.refresh_token) throw new Error('no refresh token');
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id:     CLIENT_ID,
    });
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text();
      // If the refresh token is invalid, force re-auth.
      if (res.status === 400 || res.status === 401) clearTokens();
      throw new Error(`refresh failed: ${res.status} ${txt}`);
    }
    const j = await res.json();
    const updated = {
      access_token:  j.access_token,
      // Spotify may rotate the refresh token; keep the new one if provided.
      refresh_token: j.refresh_token || tokens.refresh_token,
      expires_at:    Date.now() + (j.expires_in * 1000),
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

  // ---------- Spotify API ----------
  async function spotify(method, path, { query, body, retry = true } = {}) {
    const token = await getValidToken();
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const init = {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url.toString(), init);
    if (res.status === 401 && retry) {
      // Token may have been revoked or rotated; try one refresh + retry.
      try { await refreshAccessToken(); }
      catch { clearTokens(); throw new Error('session expired'); }
      return spotify(method, path, { query, body, retry: false });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || text || res.statusText;
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- Auth flow ----------
  async function startLogin() {
    const verifier = randomString(64);
    const state    = randomString(16);
    sessionStorage.setItem(LS.verifier,  verifier);
    sessionStorage.setItem(LS.authState, state);
    const codeChallenge = await challenge(verifier);
    const params = new URLSearchParams({
      client_id:             CLIENT_ID,
      response_type:         'code',
      redirect_uri:          REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge:        codeChallenge,
      state,
      scope:                 SCOPES,
    });
    window.location.assign(`${AUTH_URL}?${params.toString()}`);
  }

  async function handleCallbackIfPresent() {
    const url = new URL(window.location.href);
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (!code && !error) return false;

    // Clear query string from URL bar so refreshes don't re-trigger.
    window.history.replaceState({}, '', url.pathname);

    if (error) {
      setSetupError(`Spotify auth error: ${error}`);
      return true;
    }

    const expectedState = sessionStorage.getItem(LS.authState);
    const verifier      = sessionStorage.getItem(LS.verifier);
    sessionStorage.removeItem(LS.authState);
    sessionStorage.removeItem(LS.verifier);

    if (!verifier || !expectedState || state !== expectedState) {
      setSetupError('auth state mismatch — please try again');
      return true;
    }

    try {
      await exchangeCodeForTokens(code, verifier);
    } catch (e) {
      setSetupError(`token exchange failed: ${e.message}`);
      return true;
    }
    return true;
  }

  // ---------- Setup wizard ----------
  function setSetupError(msg) {
    const el = $('#setup-error');
    if (!el) return;
    if (!msg) { el.textContent = ''; hide(el); return; }
    el.textContent = msg;
    show(el);
  }

  function showStep(n) {
    document.querySelectorAll('#setup .step').forEach((s) => {
      s.classList.toggle('hidden', Number(s.dataset.step) !== n);
    });
  }

  function isLikelySonos(d) {
    // Spotify Connect doesn't have a dedicated "sonos" type, but Sonos speakers
    // typically expose themselves as "Speaker" type with "Sonos" or the room
    // name. We badge anything that looks like a speaker / contains "sonos".
    const name = (d.name || '').toLowerCase();
    const type = (d.type || '').toLowerCase();
    if (name.includes('sonos')) return true;
    if (type === 'speaker' || type === 'avr' || type === 'stb') return true;
    return false;
  }

  async function loadDevices() {
    const list = $('#device-list');
    list.innerHTML = '<div class="loading">Loading devices…</div>';
    setSetupError('');
    let data;
    try {
      data = await spotify('GET', '/me/player/devices');
    } catch (e) {
      list.innerHTML = '';
      setSetupError(`couldn't load devices: ${e.message}`);
      return;
    }
    const devices = (data && data.devices) || [];
    if (devices.length === 0) {
      list.innerHTML = `
        <div class="device empty">
          No Spotify Connect devices found. Open Spotify on your Sonos
          (or play something briefly) and tap Refresh.
        </div>`;
      return;
    }
    // Sort: likely-Sonos / speakers first.
    devices.sort((a, b) => Number(isLikelySonos(b)) - Number(isLikelySonos(a)));
    list.innerHTML = '';
    devices.forEach((d) => {
      const sonosish = isLikelySonos(d);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'device';
      btn.innerHTML = `
        <div style="flex:1; min-width:0;">
          <div class="name">${escapeHtml(d.name)}</div>
          <div class="meta">${escapeHtml(d.type || 'device')}${d.is_active ? ' · active' : ''}</div>
        </div>
        <span class="badge ${sonosish ? '' : 'other'}">${sonosish ? 'speaker' : d.type || ''}</span>
      `;
      btn.addEventListener('click', () => {
        localStorage.setItem(LS.device, JSON.stringify({
          id: d.id, name: d.name, type: d.type,
        }));
        renderMain();
      });
      list.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
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
    const icons = { play: '#icon-play', pause: '#icon-pause', spin: '#icon-spin' };
    Object.values(icons).forEach((sel) => hide($(sel)));
    show($(icons[which]));
  }

  function setPlayingUI(playing) {
    isPlaying = playing;
    const tap = $('#tap');
    tap.classList.toggle('playing', playing);
    tap.setAttribute('aria-label', playing ? 'Pause sleep song' : 'Play sleep song');
    setIcon(playing ? 'pause' : 'play');
    $('#status').textContent = playing ? 'playing · loops forever' : 'tap to play';
  }

  async function syncStateFromSpotify() {
    try {
      const state = await spotify('GET', '/me/player');
      if (!state || !state.item) { setPlayingUI(false); return; }
      const sameTrack  = state.item.id === TRACK_ID;
      const sameDevice = state.device && state.device.id === currentDeviceId();
      setPlayingUI(Boolean(state.is_playing && sameTrack && sameDevice));
    } catch {
      setPlayingUI(false);
    }
  }

  function currentDevice() {
    try { return JSON.parse(localStorage.getItem(LS.device) || 'null'); }
    catch { return null; }
  }
  function currentDeviceId() {
    const d = currentDevice();
    return d && d.id;
  }

  async function play() {
    const dev = currentDevice();
    if (!dev) throw new Error('no device selected');

    // Start playback of the specific track on the chosen device.
    // Including device_id on /play also transfers playback to that device.
    await spotify('PUT', '/me/player/play', {
      query: { device_id: dev.id },
      body:  { uris: [TRACK_URI] },
    });
    // Set repeat to track. Best-effort — don't fail the play if this errors.
    try {
      await spotify('PUT', '/me/player/repeat', {
        query: { state: 'track', device_id: dev.id },
      });
    } catch (e) {
      console.warn('repeat failed:', e);
    }
  }

  async function pause() {
    const dev = currentDevice();
    if (!dev) return;
    try {
      await spotify('PUT', '/me/player/pause', { query: { device_id: dev.id } });
    } catch (e) {
      // 403 "Player command failed: Restriction violated" can happen if
      // already paused; swallow.
      if (e.status !== 403 && e.status !== 404) throw e;
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
      // Restore previous icon state.
      setPlayingUI(isPlaying);
      let msg = e.message || 'something went wrong';
      if (/404/.test(msg) || /NO_ACTIVE_DEVICE/i.test(msg)) {
        msg = "device isn't reachable — open Spotify on the Sonos briefly, then tap again";
      }
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
    if (step === 3) loadDevices();
  }

  function renderMain() {
    hide($('#setup')); hide($('#loader'));
    show($('#main'));
    const dev = currentDevice();
    $('#device-pill').textContent = dev ? `▸ ${dev.name}` : 'no speaker';
    setPlayingUI(false);
    syncStateFromSpotify();
  }

  function renderLoader(msg = '…') {
    hide($('#setup')); hide($('#main'));
    show($('#loader'));
    $('#loader .loading').textContent = msg;
  }

  async function decideRoute() {
    const tokens = loadTokens();
    if (tokens) scheduleRefresh(tokens);

    const dev = currentDevice();
    const setupDone = localStorage.getItem(LS.setupDone) === '1';

    if (!setupDone)             return renderSetup(1);
    if (!tokens)                return renderSetup(2);
    if (!dev)                   return renderSetup(3);
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
        // Fallback: select the code text.
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
    $('#connect-spotify').addEventListener('click', () => {
      startLogin().catch((e) => setSetupError(e.message));
    });

    // Step 3
    $('#refresh-devices').addEventListener('click', loadDevices);

    // Main
    $('#tap').addEventListener('click', onTap);
    $('#change-device').addEventListener('click', () => {
      localStorage.removeItem(LS.device);
      renderSetup(3);
    });
    $('#reset-app').addEventListener('click', () => {
      if (!confirm('Reset Sleep Song? You will need to reconnect Spotify.')) return;
      [LS.tokens, LS.device, LS.setupDone].forEach((k) => localStorage.removeItem(k));
      window.location.reload();
    });

    // Re-sync when returning to the tab.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && loadTokens() && currentDevice()) {
        syncStateFromSpotify();
      }
    });
  }

  // ---------- Boot ----------
  (async function boot() {
    wire();
    try {
      const handled = await handleCallbackIfPresent();
      if (handled && loadTokens()) {
        // Auth just completed → if setup was done and we have a device, go straight to main.
        const dev = currentDevice();
        if (dev) return renderMain();
        return renderSetup(3);
      }
    } catch (e) {
      console.error(e);
    }
    decideRoute();
  })();
})();
