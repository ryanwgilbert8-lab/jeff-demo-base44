// Schema migration + seed. Idempotent: safe to run on every boot.
// Real users sign up on their own and join an employer with a team code. The old demo HRIS
// accounts (maya@jeff.demo etc., with a published password) are only created when
// SEED_DEMO_USERS=1; otherwise they are removed so nobody can sign in with them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("./db");
const auth = require("./auth");

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "jeff-demo-2026";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employers (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  feed_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers(id),
  hr_id TEXT NOT NULL,
  email TEXT,
  persona_key TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employer_id, hr_id)
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  employee_id INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Employers set up by an admin, and the team codes reps use to join them.
ALTER TABLE employers ADD COLUMN IF NOT EXISTS match_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS k401_provider TEXT;
ALTER TABLE employers ADD COLUMN IF NOT EXISTS pay_frequency TEXT;
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  cohort TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_id INTEGER REFERENCES employers(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cohort TEXT;
-- What the user has told Jeff (income confirmed, 401(k) answers, etc.), kept across visits.
ALTER TABLE users ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}';

-- Bank data from Plaid. Access tokens are encrypted (AES-256-GCM) before they're stored.
CREATE TABLE IF NOT EXISTS plaid_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT UNIQUE NOT NULL,
  access_token_enc TEXT NOT NULL,
  institution_name TEXT,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_item_id INTEGER NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  plaid_account_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  mask TEXT,
  institution TEXT,
  kind TEXT NOT NULL,          -- checking | savings | credit | loan | investment | other
  subtype TEXT,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0,  -- cash held, or amount owed for credit/loan
  apr NUMERIC(6,4),
  min_payment NUMERIC(12,2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT UNIQUE NOT NULL,
  date DATE NOT NULL,
  name TEXT NOT NULL,
  merchant_name TEXT,
  amount NUMERIC(14,2) NOT NULL,  -- Plaid's sign: positive = money out
  category_primary TEXT,
  category_detailed TEXT,
  pending BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, date DESC);

-- Where a real user is in their plan: answers, agreed living costs, decisions on each move.
CREATE TABLE IF NOT EXISTS live_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

async function seed() {
  const feedPath = path.join(__dirname, "..", "data", "employer.json");
  if (!fs.existsSync(feedPath)) return;
  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  for (const [key, emp] of Object.entries(feed.employees || {})) {
    const email = `${key}@jeff.demo`;
    const { rows: [employer] } = await pool.query(
      `INSERT INTO employers(name, feed_secret) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [emp.employer, crypto.randomBytes(24).toString("hex")]
    );
    const { rows: [employee] } = await pool.query(
      `INSERT INTO employees(employer_id, hr_id, email, persona_key, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employer_id, hr_id) DO UPDATE
         SET email = EXCLUDED.email, persona_key = EXCLUDED.persona_key,
             data = EXCLUDED.data, updated_at = now()
       RETURNING id`,
      [employer.id, emp.hrId, email, key, JSON.stringify(emp)]
    );
    await pool.query(
      `INSERT INTO users(email, password_hash, name, employee_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET employee_id = EXCLUDED.employee_id`,
      [email, auth.hashPassword(DEMO_PASSWORD), key[0].toUpperCase() + key.slice(1), employee.id]
    );
  }
}

// Demo accounts share a published password, so they only exist when explicitly asked for.
async function seedOrRemoveDemoUsers() {
  if (process.env.SEED_DEMO_USERS === "1") return seed();
  await pool.query("DELETE FROM users WHERE email LIKE '%@jeff.demo'");
  // The sample companies behind them go too, unless a real person or team code now uses one.
  const feedPath = path.join(__dirname, "..", "data", "employer.json");
  if (!fs.existsSync(feedPath)) return;
  const names = [...new Set(Object.values(JSON.parse(fs.readFileSync(feedPath, "utf8")).employees || {}).map(e => e.employer))];
  const { rows } = await pool.query(
    `SELECT e.id FROM employers e
      WHERE e.name = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employer_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM users u JOIN employees m ON m.id = u.employee_id WHERE m.employer_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM invite_codes c WHERE c.employer_id = e.id)`, [names]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  await pool.query("DELETE FROM employees WHERE employer_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM employers WHERE id = ANY($1)", [ids]);
}

async function run() {
  await migrate();
  await seedOrRemoveDemoUsers();
  await pool.end();
}

if (require.main === module) {
  run().then(() => { console.log("Migration + seed complete"); process.exit(0); }).catch(e => {
    console.error("Migration failed:", e.message);
    process.exit(1);
  });
}

module.exports = { migrate, seed, seedOrRemoveDemoUsers, DEMO_PASSWORD };
