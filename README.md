# Jeff demo

Interactive investor demo for Jeff. One web page (`public/index.html`) plus a tiny Node server (`server.js`).

## B2B2C model
Jeff is sold to employers and given to their employees. The employer's HR/payroll system provides each employee's salary, pay schedule and benefits through a feed (`data/employer.json`, served at `GET /api/employer`), so Jeff already knows salary, 401(k) match and health-plan details at sign-in instead of asking.

## Run it
- `npm start`, then open http://localhost:3000
- For live AI replies, set `ANTHROPIC_API_KEY`. Without it, Jeff runs in scripted mode (all buttons still work).

## Presenting
- Pick a persona in the right-hand panel, then hand over the phone view.
- "Play the next 30 days" runs a month of Jeff reaching out.
- Press H to hide the panel.

All data is fake. No real accounts are connected and no money moves.
