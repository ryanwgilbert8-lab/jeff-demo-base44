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

## Two modes
- `/` is the real app for real people. `/demo` is the investor demo: three sample personas
  (the `P` object), presenter controls, no sign-in, sample HR data from `GET /api/demo/hr`.
- In the page, `LIVE` decides the mode; `bootLive()` / `bootDemo()` start each one. Live mode
  adds `body.live`, which hides the presenter controls.

## Auth + tenant isolation
- Password auth (scrypt) with httpOnly session cookie `jeff_session`, 30-day sessions.
- Every user-scoped route resolves the user via `auth.userFromReq`, which also joins their
  employer. Data is always scoped to the signed-in user.
- Sign-up takes first name, email, password and an optional team code. A team code links the
  user to an employer and cohort (`lib/team.js`); they can also join later via `POST /api/me/join`.
  Signup still links to an HRIS-fed employee by matching email when one exists.
- Admins are the emails in the `ADMIN_EMAILS` secret. They get an Admin screen to add companies
  (name, 401(k) match %, provider, pay schedule) and make team codes (`/api/admin/*`).
- The old demo accounts (`*@jeff.demo`, published password) are deleted on boot unless
  `SEED_DEMO_USERS=1`, along with their sample companies if nothing real uses them.
- `GET /api/me` returns `{ user: {id, email, firstName, isAdmin}, employer, cohort, answers, hr }`.
- `POST /api/me/answers` merges what the user has told Jeff into `users.answers`.

## Real users: banks, profile and plan
- Banks connect through Plaid (`lib/plaid.js`, REST, no SDK), read-only. Secrets: `PLAID_CLIENT_ID`,
  `PLAID_SECRET`, `PLAID_ENV` (sandbox | production), optional `PLAID_WEBHOOK_URL`. Access tokens are
  AES-256-GCM encrypted (`TOKEN_ENCRYPTION_KEY`, or derived from `PLAID_SECRET`). Tables: `plaid_items`,
  `accounts`, `transactions`. Routes: `GET /api/bank`, `POST /api/bank/{link-token,exchange,sync,remove}`,
  `POST /api/plaid/webhook` (JWT-verified).
- `lib/engine/` is the money engine (pure functions, tests in `test/`, run `npm test`). Every number
  Jeff states for real users comes from it: paycheck detection (base vs commission), cost of living
  from transactions, the plan, the commission split, debt payoff, safe to spend.
- `lib/profile.js` turns a user's real data into the same shape as the demo personas (`P.live` in the
  page): accounts, lead, paycheck, living costs with trims, questions, and plan moves. Routes:
  `GET /api/live/profile`, `POST /api/live/plan` (moves from the engine for the agreed living costs and
  answers), `POST /api/live/state` (saves answers, living costs, decisions; returning users resume at home).
- In the page, real-user behavior lives in the "Real accounts drive the same screens" section. It wraps
  demo functions (`askIncome`, `buildPlan`, `resolveTo`, `applyApproved`, `presentMove`, `authorize`,
  `home`) and falls back to the demo when `!p().live`. Jeff can't move money for real users: nothing is
  simulated, and moves are described as transfers to set up in their own bank.

## HRIS feed
- `POST /api/hris/feed` with `X-HRIS-Secret: <employers.feed_secret>` upserts employees by
  `(employer_id, hr_id)`. Feed secrets are per-employer, generated at seed time — read them
  from the `employers` table (no admin UI yet).

## Custom plan building
- `POST /api/plan` (auth): client posts candidate moves + confirmed money numbers; Claude
  personalizes (keep/drop/rewrite say/why/detail, up to 2 custom advice moves). Server
  sanitizes: ids must match candidates, `safe` can't be dropped, extras capped at 2; result
  stored in `plans`. Client caches it in `S.aiPlan` (cleared by `resetPersona`) and merges
  it in `plan()` — machinery (allocs, ROI, payday sim) is untouched: extras carry no
  alloc/transfer/value, so they render and can be approved but don't move money.
- The client's first plan move may be a brain-authored custom move (e.g. net-pay rhythm);
  that's expected, not a bug.

## Verify it works
1. `curl -s localhost:3000/api/health` → `{"ai":true,"db":true}` (ai depends on the key).
2. Sign up: `curl -s -c /tmp/cj -X POST localhost:3000/api/auth/signup -H 'Content-Type: application/json' -d '{"firstName":"Test","email":"test@example.com","password":"long-enough-1"}'`.
3. `curl -s -b /tmp/cj localhost:3000/api/me` → your own profile; without the cookie → 401.
4. `POST /api/jeff` with the cookie returns Claude JSON; exchanges land in `messages`.
5. In the preview: `/` shows the sign-in card; create an account and land on the welcome screen.
   `/demo` shows the sample-data demo with controls and no sign-in.

## Notes
- The guided demo flow is still scripted per persona template; real Claude replies power
  free-text turns via `/api/jeff`.
- `data/employer.json` is seed/demo data; production records come through `/api/hris/feed`.
- `JEFF_MODEL` env var controls the Anthropic model (default `claude-haiku-4-5-20251001`).
