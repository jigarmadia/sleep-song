# sleep-song-token

A ~60-line Cloudflare Worker that holds the Sonos OAuth `client_secret`
and does **only** the Sonos token-exchange step. The browser app (the
GitHub Pages site) never sees the secret. Free tier is more than
enough for personal use.

## What it exposes

`POST /token` with a JSON body:

```json
{ "grant_type": "authorization_code", "code": "…", "redirect_uri": "https://jigarmadia.github.io/sleep-song/" }
```
or
```json
{ "grant_type": "refresh_token", "refresh_token": "…" }
```

The Worker forwards the request to `https://api.sonos.com/login/v3/oauth/access`
with HTTP Basic auth (`client_id:client_secret`) attached, and returns
Sonos's JSON response. CORS is allow-listed to the GitHub Pages origin.

## Deploy — option A: Wrangler CLI (recommended)

From the repo root:

```bash
cd worker
npm install -g wrangler            # if you don't already have it
wrangler login                     # opens browser → authorize
wrangler deploy                    # deploys the Worker to your account
wrangler secret put SONOS_CLIENT_ID
# (paste the Key from your Sonos integration when prompted)
wrangler secret put SONOS_CLIENT_SECRET
# (paste the Secret from your Sonos integration when prompted)
```

The `wrangler deploy` output will print the Worker URL, e.g.:

```
https://sleep-song-token.<your-cloudflare-subdomain>.workers.dev
```

Send that URL to me — I'll bake it into the app.

## Deploy — option B: Cloudflare dashboard (no CLI)

1. Cloudflare → **Workers & Pages** → **Create application** → **Create Worker**.
2. Name it `sleep-song-token` (or anything; the URL is yours forever).
3. In the editor, replace the contents with [`src/index.js`](src/index.js) from this repo.
4. **Save and deploy**.
5. Open the new Worker → **Settings → Variables and Secrets** →
   add two **encrypted** vars:
   - `SONOS_CLIENT_ID`     = the Sonos integration's Key
   - `SONOS_CLIENT_SECRET` = the Sonos integration's Secret
6. Click **Deploy** again so the new env vars take effect.

The Worker URL is shown at the top of the Worker's page.

## Verifying CORS

```bash
curl -sS -X OPTIONS "https://sleep-song-token.<sub>.workers.dev/token" \
  -H "Origin: https://jigarmadia.github.io" -i | head
```

You should see:

```
HTTP/2 204
access-control-allow-origin: https://jigarmadia.github.io
```

## Allowing additional origins (optional)

By default the Worker only accepts requests from
`https://jigarmadia.github.io`. To allow more (e.g. local dev):

- Wrangler: edit `wrangler.toml` to add a `[vars]` block with
  `ALLOWED_ORIGIN = "https://jigarmadia.github.io,http://localhost:5173"`
  and re-deploy.
- Dashboard: add a (plain, non-encrypted) variable `ALLOWED_ORIGIN`
  with the comma-separated list, then deploy.

## Why a Worker and not a backend?

Sonos's OAuth uses the classic authorization-code grant, and the
token-exchange step requires HTTP Basic auth with the `client_secret`.
Without a Worker, the secret would have to live in `app.js` and be
visible to anyone viewing source. The Worker is a 60-line "shim" that
keeps the secret server-side without us actually running a server we
have to maintain.