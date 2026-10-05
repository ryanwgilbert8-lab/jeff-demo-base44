# Jeff Demo — Base44 Dev Environment

## What this app is
Single-page Node.js demo: `server.js` serves `public/index.html` and proxies AI replies through the Anthropic API (`POST /api/jeff`). No npm dependencies — uses only Node 18+ built-ins (`http`, `fs`, `path`, global `fetch`).

## Running
- `docker compose -f docker-compose.base44.yml up -d` — starts the app on port 3000.
- Container uses `node:22-alpine` with the repo bind-mounted; `node --watch server.js` auto-restarts on `server.js` changes.
- `index.html` is read once at server startup via `fs.readFileSync`, so edits to it require a container restart (`docker compose restart web`) or `reload_preview`.

## Secrets
- `ANTHROPIC_API_KEY` (optional): enables live AI replies. Without it the demo runs in scripted mode — all buttons still work. Get it from https://console.anthropic.com/settings/keys.
- Delivered via `/run/base44/app.env` (platform-managed, outside the repo).

## Health
- `GET /api/health` → `{"ai": true|false}` indicates whether the API key is present.

## Notes
- All data is fake. No real accounts, no money movement.
- `JEFF_MODEL` env var controls which Anthropic model is used (defaults to `claude-haiku-4-5-20251001`).
