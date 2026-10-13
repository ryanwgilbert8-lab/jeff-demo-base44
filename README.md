# Jeff — AI financial assistant for employees

B2B2C product: employers connect their HR/payroll system, employees sign in, and Jeff
(a Claude-powered financial brain) builds and runs a money plan using data the employer
already has — salary, pay schedule, 401(k) match, health plan — so nobody re-types it.

## Stack
- **Server**: Node 22 (built-ins + `pg`), `server.js` + `lib/` modules:
  - `lib/db.js` — Postgres pool (`DATABASE_URL`)
  - `lib/auth.js` — session-cookie auth, scrypt password hashing
  - `lib/ai.js` — Anthropic API client (the financial brain)
  - `lib/migrate.js` — idempotent schema migration + demo seed
- **Client**: `public/index.html` (single page, no build step), read fresh on every request.
- **Database**: Postgres 16 (compose service `db`, volume `dbdata`).

## Data model
`employers` (feed secret) → `employees` (HRIS records) → linked `users` →
`conversations`/`messages` (per-user, isolated). All user-scoped queries go through
`auth.userFromReq`, so one user can never read another's data.

## Auth
- `POST /api/auth/signup` `{email, password, name}` — auto-links to an HRIS-fed employee
  record when the email matches one.
- `POST /api/auth/login` / `POST /api/auth/logout` — 30-day httpOnly session cookie.
- `GET /api/me` — own profile + own HR record only.

## HRIS / payroll feed
Employers (or their HRIS/payroll system, or an aggregator like Finch) push employee
records to:

```
POST /api/hris/feed
X-HRIS-Secret: <employer feed_secret>
{ "employees": [{ "hrId": "BL-1077", "email": "...", "salary": 71000, "pay": 2250,
                  "payFrequency": "biweekly on Fridays", "benefits": { ... } }] }
```

Secrets are per-employer and stored in the `employers` table (fetch them from the DB
until an admin UI exists). Employee records are upserted by `(employer, hrId)`.
`data/employer.json` is the seed feed used by `lib/migrate.js` at boot.

## Financial brain
`POST /api/jeff` (session required): the client sends its task prompt; the server injects
the signed-in user's authoritative HR data from Postgres, calls Claude
(`ANTHROPIC_API_KEY`, model via `JEFF_MODEL`), persists both sides of the exchange, and
returns the JSON the client flow expects. Without a key the app runs in scripted mode.

## Secrets
- `ANTHROPIC_API_KEY` — Anthropic key for the brain (https://console.anthropic.com/settings/keys).
  Optional at boot; required for live AI replies.
- Delivered via `/run/base44/app.env` (platform-managed, outside the repo).

## Running (Base44 dev environment)
```
docker compose -f docker-compose.base44.yml up -d
```
Services: `db` (Postgres, healthchecked) → `migrate` (one-shot: `npm ci` + `node lib/migrate.js`) →
`web` (`npm ci` + `node --watch server.js` on port 3000, healthchecked via `/api/health`,
which reports `{ ai, db }` and fails when the database is unreachable).

## Demo accounts (seeded)
`maya@jeff.demo`, `jordan@jeff.demo`, `priya@jeff.demo` — password `jeff-demo-2026`
(override with `DEMO_PASSWORD` before seeding). **Remove the credentials hint in the
sign-in card and rotate these before any real deployment.**

## Not yet production (known gaps)
- No SSO (Okta/Entra) — password auth with sessions only.
- HRIS integration is a generic push API, not certified Workday/ADP/Gusto connectors.
- No employer-facing admin UI (feed secrets are read from the DB directly).
- No rate limiting, audit logging, or compliance/liability review — required before
  handling real employee financial data.
