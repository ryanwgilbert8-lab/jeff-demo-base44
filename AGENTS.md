# Jeff — Base44 Dev Environment

## What this app is
Node 22 + Postgres. `server.js` (zero-dep except `pg`) serves `public/index.html`, handles
auth (`/api/auth/*`), the employer HRIS feed (`POST /api/hris/feed`, `X-HRIS-Secret` header),
per-user profile (`/api/me`), and the financial brain (`POST /api/jeff`, Claude server-side
with HR data injected from Postgres). Client is a single static page with no build step.

## Running
- `docker compose -f docker-compose.base44.yml up -d` — starts `db` (postgres:16-alpine,
  volume `dbdata`), then one-shot `migrate` (npm ci + `node lib/migrate.js`: idempotent
  schema + seed from `data/employer.json` + demo users), then `web`.
- `web` uses `node:22-alpine` with the repo bind-mounted; command runs `npm ci` then
  `node --watch server.js` (auto-restarts on server changes). `index.html` is re-read from
  disk on every request — HTML edits need no restart. `lib/*` changes restart via `--watch`.
- `node_modules` is installed into the bind mount at container start from the committed
  `package-lock.json` — regenerate the lockfile (`npm install --package-lock-only`) whenever
  `package.json` dependencies change.

## Secrets
- `ANTHROPIC_API_KEY` (optional at boot): enables live AI replies in `/api/jeff`. Without it
  the client runs in scripted mode. Get it from https://console.anthropic.com/settings/keys.
- Delivered via `/run/base44/app.env` (platform-managed, outside the repo).

## Health
- `GET /api/health` → `{"ai": bool, "db": bool}`; 503 when the DB is unreachable. Compose
  healthchecks both `db` (pg_isready) and `web` (this endpoint).

## Auth + tenant isolation
- Password auth (scrypt) with httpOnly session cookie `jeff_session`, 30-day sessions.
- Every user-scoped route resolves the user via `auth.userFromReq` — data is joined through
  the user's own `employee_id`, so users can't read other employees' HR records.
- Signup links a user to an HRIS-fed employee by matching email.
- Seeded demo accounts: `maya@jeff.demo`, `jordan@jeff.demo`, `priya@jeff.demo`,
  password `jeff-demo-2026` (`DEMO_PASSWORD` env overrides). The sign-in card shows a
  credentials hint — remove before real deployment.
- Frontend gates everything behind the session: boot calls `/api/me`; no session →
  sign-in overlay. A signed-in user sees only their own persona card (`paintControls`
  filters to `S.key`), with HR data from their own record — the old public
  `/api/employer` endpoint was removed on purpose.

## HRIS feed
- `POST /api/hris/feed` with `X-HRIS-Secret: <employers.feed_secret>` upserts employees by
  `(employer_id, hr_id)`. Feed secrets are per-employer, generated at seed time — read them
  from the `employers` table (no admin UI yet).
- `GET /api/me` returns `{ user, persona, hr }`; `persona` maps to the scripted demo flow
  (`P` object in `index.html`), `hr` is the raw HRIS record shown in the controls panel.

## Verify it works
1. `curl -s localhost:3000/api/health` → `{"ai":true,"db":true}` (ai depends on the key).
2. Login: `curl -s -c /tmp/cj -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"maya@jeff.demo","password":"jeff-demo-2026"}'`.
3. `curl -s -b /tmp/cj localhost:3000/api/me` → own persona + HR data; without the cookie → 401.
4. `POST /api/jeff` with the cookie returns Claude JSON; exchanges land in `messages`.
5. In the preview: sign-in gate → log in as a demo account → persona card + HR feed rows render.

## Notes
- The guided demo flow is still scripted per persona template; real Claude replies power
  free-text turns via `/api/jeff`.
- `data/employer.json` is seed/demo data; production records come through `/api/hris/feed`.
- `JEFF_MODEL` env var controls the Anthropic model (default `claude-haiku-4-5-20251001`).
