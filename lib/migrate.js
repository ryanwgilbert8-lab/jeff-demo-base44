// Schema migration + seed. Idempotent: safe to run on every boot.
// Seeds employers/employees from data/employer.json (the demo HRIS feed) and creates
// demo employee accounts so the guided experience works out of the box.
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
      [email, auth.hashPassword(DEMO_PASSWORD), emp.employer, employee.id]
    );
  }
}

async function run() {
  await migrate();
  await seed();
  await pool.end();
}

if (require.main === module) {
  run().then(() => { console.log("Migration + seed complete"); process.exit(0); }).catch(e => {
    console.error("Migration failed:", e.message);
    process.exit(1);
  });
}

module.exports = { migrate, seed, DEMO_PASSWORD };
