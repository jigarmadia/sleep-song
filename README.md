# sleep-song

A single-page web app that plays one specific Spotify track on a Sonos speaker
in one tap, on infinite repeat. Designed for an iPhone / Android home-screen
icon — full-screen, dark, no browser chrome.

Pure client-side. No backend. Spotify PKCE OAuth. Sonos speakers come from
the Spotify Connect device list (the speaker just needs Spotify enabled in
the Sonos app once).

## How it works

1. **Setup wizard** (first launch)
   - Step 1: Copy the page's URL and paste it as a Redirect URI in the
     Spotify dashboard for client `be0930de575a43c6a42c1c2f14fe8223`.
   - Step 2: PKCE login.
   - Step 3: Pick a Sonos speaker from `GET /me/player/devices`.
2. **Main screen**: one big tap target. Tap once to play
   `spotify:track:3HC9bA5wmZsz0wtrCIt3I6` on the saved device with
   `repeat=track`. Tap again to pause.
3. **Tokens** auto-refresh in the background (60 s before expiry, plus on
   401), so the session effectively never expires until the refresh token
   is revoked.

## Add to home screen

iOS Safari → Share → *Add to Home Screen*. The app is tagged with
`apple-mobile-web-app-capable` and a manifest, so it launches full-screen.

## Deploy

`main` → GitHub Pages, via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

After the first deploy, register the resulting Pages URL as a Redirect URI
in the Spotify dashboard (exact match, trailing slash matters).

## Files

- [index.html](index.html) — markup, setup wizard, main screen.
- [styles.css](styles.css) — dark night-time aesthetic.
- [app.js](app.js) — PKCE, token refresh, Spotify Web API calls.
- [manifest.webmanifest](manifest.webmanifest) — PWA / home-screen metadata.
- [icon.svg](icon.svg) — crescent-moon icon.
