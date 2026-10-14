// Session-cookie auth with scrypt password hashing. Every session is scoped to one user;
// all user data is fetched through userFromReq, so per-user isolation is enforced server-side.
const crypto = require("crypto");
const pool = require("./db");

const COOKIE = "jeff_session";
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), salt, 64);
  const c = Buffer.from(hash, "hex");
  return c.length === h.length && crypto.timingSafeEqual(h, c);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns the signed-in user joined with their linked HRIS employee record, or null.
async function userFromReq(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.first_name, u.employee_id, u.cohort, u.answers,
            e.persona_key, e.data AS hr_data,
            emp.id AS employer_id, emp.name AS employer_name, emp.match_pct, emp.k401_provider, emp.pay_frequency
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN employers emp ON emp.id = COALESCE(u.employer_id, e.employer_id)
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  const user = rows[0] || null;
  if (user) user.is_admin = isAdmin(user.email);
  return user;
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')",
    [token, userId]
  );
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  return token;
}

async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Admins (who can set up employers and team codes) are listed in the ADMIN_EMAILS secret.
function isAdmin(email) {
  const list = String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(String(email || "").toLowerCase());
}

module.exports = { COOKIE, isAdmin, hashPassword, verifyPassword, parseCookies, userFromReq, createSession, destroySession };
