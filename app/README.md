# Jeff app

The production app: a money coach that employers give their sales reps (SDR, BDR and other entry-level sales classes) as a benefit. The demo that sold the idea lives in `../public`.

**Milestone 1 (this):** the rep's side, read-only. Jeff connects to banks through Plaid, plans the month on base pay, gives every commission check a job, and talks it through. Jeff never moves money; for every "yes" it tells the rep exactly what to do.

## How it works

| Piece | Where |
|---|---|
| Money engine: pure, tested, no I/O | `src/lib/engine/` |
| Database schema, row-level security, invite and employer-stats functions | `supabase/migrations/` |
| Plaid link, sync, verified webhook | `src/lib/plaid.ts`, `src/app/api/plaid/` |
| Jeff (Claude): prompt, facts, streaming route | `src/lib/jeff.ts`, `src/app/api/jeff/route.ts` |
| Screens: join, connect, income, living, plan, home | `src/app/*/page.tsx` |

**Numbers come from the engine, words from Jeff.** The engine works out safe to spend, the paycheck split, the commission split, debt payoff and the cushion. Claude gets those as a FACTS block and is told to cite only those numbers. Change the math in the engine, never in the prompt.

**What makes it a sales product:**
- Income detection splits each payroll deposit into base and commission (`income.ts`). The plan is built on base only. Ramps and draws are modeled, including recoverable draws.
- A commission waterfall (`routeCommission` in `plan.ts`), in order: tax set-aside if withholding falls short, covering any gap where base doesn't pay the bills, the draw set-aside, 10% for the rep, the starter cushion, high-interest debt, the full three-month cushion, then a Roth IRA and savings.
- The withholding gap: commissions are withheld at a flat 22% federal, and the engine compares that with the rep's real bracket at OTE. For most SDRs (OTE under about $120k) the two match and Jeff says so.

**Privacy model.** Reps can only read their own rows (RLS). Plaid access tokens are AES-256-GCM encrypted, and only the server, using the service role, can read them. Employers never query rep tables; `employer_cohort_stats()` returns cohort totals and nothing at all for groups under 10.

## Run it locally

```bash
cd app
cp .env.example .env.local     # fill in Supabase, Plaid sandbox, Anthropic, encryption key
npm install
npm run dev                    # http://localhost:3000
npm test                       # engine tests
npm run typecheck
```

Database: apply `supabase/migrations/*.sql`, then `supabase/seed.sql` for a test employer and the invite code `ACME-SDR-27` (Supabase CLI: `supabase db push`, or paste into the SQL editor).

In Supabase Auth settings, set the Site URL and add `<your-url>/auth/callback` to the redirect URLs.

Plaid sandbox: in Link, choose any bank and sign in as `user_transactions_dynamic` (any password) for realistic recurring paychecks and spending. Transactions can take up to a minute to show; use **Refresh**.

## Before real users

- [ ] Plaid production access (their security questionnaire), then set `PLAID_ENV=production` and the webhook URL.
- [ ] Legal review of the advice boundary: budgeting and debt guidance versus investment advice (RIA questions), plus terms and privacy policy. Jeff's prompt already stays away from specific securities.
- [ ] Generate typed Supabase client types (`supabase gen types typescript`) and replace the untyped rows in `src/lib/data.ts`.
- [ ] Rate limiting on `/api/jeff`, plus error monitoring.
- [ ] Review the tax constants in `engine/tax.ts` and the Roth limit in `engine/plan.ts` every January.

## Next milestones

2. Employer side: admin login, invite a class, the cohort dashboard and ROI tracker (aggregates only).
3. Payroll and HR data through Finch: real paystubs, 401(k) match and contribution, commission statements.
4. Proactive Jeff: commission-landed and overspend notifications (Plaid webhooks to email or push).
5. Moving money (only after the legal and partner decisions).
