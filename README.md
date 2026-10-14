# Jeff

Jeff, the money coach employers give their sales reps. Deployed on Base44 from this repo: one web page (`public/index.html`) plus a small Node server (`server.js`).

- **`/`**: the real app. Reps sign in with an emailed link and join their company's team with a code. Bank connection is the next step being built.
- **`/demo`**: the investor demo with sample data and the presenter controls.

## Setup (Base44 secrets)
- `ANTHROPIC_API_KEY`: live AI replies for Jeff. Without it, Jeff runs in scripted mode.
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: optional. They default to the Jeff Supabase project.

In Supabase, under **Authentication > URL Configuration**, set **Site URL** to the app's Base44 address and add the same address to **Redirect URLs**, or sign-in links won't come back to the app.

Database tables and security rules: `app/supabase/migrations/`. Test team code: `ACME-SDR-27`.

## Presenting the demo
- Open `/demo`, pick a persona in the right-hand panel, then hand over the phone view.
- "Play the next 30 days" runs a month of Jeff reaching out.
- Press H to hide the panel.

The demo's data is all fake. No real accounts are connected and no money moves.

## `app/`
An earlier Next.js version of the production app. It's not deployed; its money engine (`app/src/lib/engine/`) gets reused here as the real numbers come in.
