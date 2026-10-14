// Employers, team codes and the admin tools to set them up.
// A rep joins their employer by entering a team code at sign-up (or later). The code
// decides which employer's benefits (401(k) match, provider) Jeff plans around.
const crypto = require("crypto");
const pool = require("./db");

const normalize = code => String(code || "").trim().toUpperCase().replace(/\s+/g, "");

/** Attaches a user to the employer behind a team code. Returns an error message, or null on success. */
async function redeem(userId, rawCode) {
  const code = normalize(rawCode);
  if (!code) return "Enter the team code from your welcome email.";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [inv] } = await client.query("SELECT * FROM invite_codes WHERE code = $1 FOR UPDATE", [code]);
    if (!inv) { await client.query("ROLLBACK"); return "We don't recognize that team code. Check the welcome email from your company."; }
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) { await client.query("ROLLBACK"); return "That team code has expired. Ask your manager for a new one."; }
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) { await client.query("ROLLBACK"); return "That team code has been used up. Ask your manager for a new one."; }
    await client.query("UPDATE invite_codes SET uses = uses + 1 WHERE code = $1", [code]);
    await client.query("UPDATE users SET employer_id = $1, cohort = $2 WHERE id = $3", [inv.employer_id, inv.cohort, userId]);
    await client.query("COMMIT");
    return null;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Checks a code without using it, so sign-up can fail before the account is created. */
async function codeProblem(rawCode) {
  const code = normalize(rawCode);
  const { rows: [inv] } = await pool.query("SELECT expires_at, max_uses, uses FROM invite_codes WHERE code = $1", [code]);
  if (!inv) return "We don't recognize that team code. Check the welcome email from your company, or leave it blank.";
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return "That team code has expired. Ask your manager for a new one.";
  if (inv.max_uses !== null && inv.uses >= inv.max_uses) return "That team code has been used up. Ask your manager for a new one.";
  return null;
}

/* ---------- Admin ---------- */
async function overview() {
  const { rows: employers } = await pool.query(
    `SELECT e.id, e.name, e.match_pct, e.k401_provider, e.pay_frequency,
            (SELECT count(*)::int FROM users u WHERE u.employer_id = e.id) AS members,
            COALESCE((SELECT json_agg(json_build_object('code', c.code, 'cohort', c.cohort, 'uses', c.uses, 'maxUses', c.max_uses, 'expiresAt', c.expires_at) ORDER BY c.created_at DESC)
                        FROM invite_codes c WHERE c.employer_id = e.id), '[]') AS codes
       FROM employers e ORDER BY e.created_at DESC`
  );
  const { rows: [counts] } = await pool.query("SELECT count(*)::int AS users, count(*) FILTER (WHERE employer_id IS NULL)::int AS without_employer FROM users");
  return { employers, ...counts };
}

async function createEmployer({ name, matchPct, k401Provider, payFrequency }) {
  name = String(name || "").trim().slice(0, 120);
  const match = Number(matchPct);
  if (!name) return { error: "Give the company a name." };
  if (!Number.isFinite(match) || match < 0 || match > 25) return { error: "401(k) match should be a percent between 0 and 25." };
  const { rows: [row] } = await pool.query(
    `INSERT INTO employers(name, feed_secret, match_pct, k401_provider, pay_frequency) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET match_pct = EXCLUDED.match_pct, k401_provider = EXCLUDED.k401_provider, pay_frequency = EXCLUDED.pay_frequency
     RETURNING id`,
    [name, crypto.randomBytes(24).toString("hex"), match, String(k401Provider || "").trim().slice(0, 80) || null, String(payFrequency || "").trim().slice(0, 40) || null]
  );
  return { id: row.id };
}

async function createCode({ employerId, cohort, maxUses, expiresInDays }) {
  const { rows: [emp] } = await pool.query("SELECT id, name FROM employers WHERE id = $1", [Number(employerId)]);
  if (!emp) return { error: "Pick a company first." };
  const prefix = emp.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "TEAM";
  const max = maxUses === "" || maxUses === null || maxUses === undefined ? null : Math.max(1, Math.min(100000, Number(maxUses) | 0));
  const days = Number(expiresInDays) > 0 ? Math.min(3650, Number(expiresInDays)) : null;
  for (let i = 0; i < 5; i++) {
    const code = `${prefix}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const r = await pool.query(
      `INSERT INTO invite_codes(code, employer_id, cohort, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
       ON CONFLICT DO NOTHING RETURNING code`,
      [code, emp.id, String(cohort || "").trim().slice(0, 120) || null, max, days]
    );
    if (r.rows[0]) return { code };
  }
  return { error: "Couldn't make a unique code. Try again." };
}

module.exports = { normalize, redeem, codeProblem, overview, createEmployer, createCode };
