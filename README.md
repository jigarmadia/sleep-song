# sleep-song

A single-page web app that plays a saved Sonos Favorite on infinite repeat
with one tap. Designed for an iPhone / Android home-screen icon —
full-screen, dark, no browser chrome.

Talks directly to the Sonos Cloud Control API, so the speaker doesn't
need to be an active Spotify Connect target — works even if the Sonos
has been idle for hours.

## Architecture

```
┌──────────────────────┐    ┌──────────────────────────┐    ┌──────────────┐
│ GitHub Pages (HTML+JS)│───▶│ Cloudflare Worker        │───▶│ Sonos OAuth  │
│ (this repo)          │    │ (holds client_secret)    │    │              │
│                      │    │ POST /token              │    └──────────────┘
└──────────┬───────────┘    └──────────────────────────┘
           │
           │ Bearer token
           ▼
┌──────────────────────────┐
│ Sonos Control API        │   /v1/groups/{id}/favorites
│ (api.ws.sonos.com)       │
└──────────────────────────┘
```

The Cloudflare Worker is the only piece of "server" code — it exists
solely to keep the Sonos `client_secret` out of the public browser
bundle. It does ~3 things: validate the request, attach Basic auth,
forward to Sonos's token endpoint.

## Repo layout

- [index.html](index.html), [app.js](app.js), [styles.css](styles.css) — the static site (deploys to GitHub Pages).
- [worker/](worker/) — the Cloudflare Worker source + deploy instructions.
- [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — auto-deploy the static site to Pages on push to `main`.

## How it works

1. **Setup wizard** (first launch)
   1. Register the page URL as a Redirect URI in your
      [Sonos developer integration](https://developer.sonos.com/).
   2. PKCE-style OAuth login (state-protected) → redirect → token
      exchange via the Worker.
   3. Pick the Sonos group (one or more speakers playing together).
   4. Pick the Sonos Favorite for your sleep song.
2. **Main screen** — one big tap target.
   - Tap to start: `POST /v1/groups/{groupId}/favorites` with
     `playOnCompletion: true, playModes.repeatOne: true`.
   - Tap to pause: `POST /v1/groups/{groupId}/playback/pause`.
3. **Tokens** auto-refresh in the background ~2 min before expiry, plus
   on-demand when an API call returns 401.

## Setup checklist (first-time install)

1. **Create a Sonos integration** at <https://developer.sonos.com/> →
   *Integrations → New Integration*. Add the Pages URL
   (`https://jigarmadia.github.io/sleep-song/`) as a Redirect URI.
   Copy down the **Key** and **Secret**.
2. **Save your sleep-song track as a Sonos Favorite** in the Sonos app
   (long-press the track → *Add to Sonos Favorites*).
3. **Deploy the Worker**: see [worker/README.md](worker/README.md).
   Note the Worker URL.
4. **Plug the values into [app.js](app.js)**:
   - `SONOS_CLIENT_ID` ← the Sonos integration's *Key*.
   - `WORKER_URL`       ← the Worker URL from step 3.
   The *Secret* lives only in the Worker as an encrypted env var.
5. Push to `main`. GitHub Actions deploys to Pages automatically.

## Add to home screen

iOS Safari → Share → *Add to Home Screen*. The app is tagged with
`apple-mobile-web-app-capable` and a manifest, so it launches full-screen.

## Why a Cloudflare Worker?

Sonos's OAuth uses the classic authorization-code grant: the
token-exchange step needs HTTP Basic auth with `client_id:client_secret`.
There's no PKCE option that keeps it pure-client. The Worker is the
smallest possible "server" — ~60 lines, free tier, holds the secret in
encrypted env vars, allow-listed by origin.