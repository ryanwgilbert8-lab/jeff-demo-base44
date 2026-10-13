// Jeff app server: static client + auth + per-tenant HRIS feed + the financial brain.
// Data flow: employers push employee records to POST /api/hris/feed (secret-authenticated);
// employees sign in; /api/me serves only their own HR record; /api/jeff runs the AI brain
// with that authoritative data injected server-side and persists the conversation.
const http = require("http");
const fs = require("fs");
const path = require("path");
const pool = require("./lib/db");
const ai = require("./lib/ai");
const auth = require("./lib/auth");
const { migrate } = require("./lib/migrate");

const PORT = process.env.PORT || 3000;
const HTML_PATH = path.join(__dirname, "public", "index.html");
const STYLE = `You are Jeff, the voice of a money platform called Jeff that actually runs people's money for them, talking live with someone in a product demo. Think of the family member everyone wishes they had managing their money: warm, direct, remembers what matters to them, protective of their future, and willing to push back on a bad idea once, kindly, before respecting their call. You never lecture. Your reply is spoken aloud: 1 to 3 short sentences, no lists, no markdown, no emoji. Write money like "$4,500". Only use facts in the person's data below. Never state something as fact that the person hasn't confirmed. Never invent accounts.`;

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, "application/json", typeof obj === "string" ? obj : JSON.stringify(obj));

async function readBody(req, limit = 1e6) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Body too large");
  }
  return body ? JSON.parse(body) : {};
}

/* ---------- HRIS feed ---------- */
// Employers (or their HRIS/payroll system, or an aggregator like Finch) push employee
// records here, authenticated by the employer's feed secret in the X-HRIS-Secret header.
async function handleFeed(req, res) {
  const secret = req.headers["x-hris-secret"];
  if (!secret) return json(res, 401, { error: "Missing X-HRIS-Secret header" });
  const { rows: [employer] } = await pool.query("SELECT id, name FROM employers WHERE feed_secret = $1", [secret]);
  if (!employer) return json(res, 401, { error: "Unknown feed secret" });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const list = Array.isArray(body.employees) ? body.employees : null;
  if (!list) return json(res, 400, { error: "Body must be { employees: [...] }" });
  let upserted = 0;
  for (const emp of list) {
    if (!emp || !emp.hrId) continue;
    await pool.query(
      `INSERT INTO employees(employer_id, hr_id, email, persona_key, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employer_id, hr_id) DO UPDATE
         SET email = EXCLUDED.email, persona_key = EXCLUDED.persona_key,
             data = EXCLUDED.data, updated_at = now()`,
      [employer.id, String(emp.hrId).slice(0, 100), emp.email || null, emp.personaKey || null, JSON.stringify(emp)]
    );
    upserted++;
  }
  return json(res, 200, { ok: true, employer: employer.name, upserted });
}

/* ---------- Auth ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleSignup(req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 100) || null;
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Enter a valid email address" });
  if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters" });
  const { rows: [existing] } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (existing) return json(res, 409, { error: "That email already has an account. Try signing in." });
  // Link to an HRIS-fed employee record by email, when the employer has pushed one.
  const { rows: [employee] } = await pool.query(
    "SELECT id FROM employees WHERE lower(email) = $1 ORDER BY updated_at DESC LIMIT 1", [email]
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users(email, password_hash, name, employee_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [email, auth.hashPassword(password), name, employee ? employee.id : null]
  );
  await auth.createSession(res, user.id);
  return json(res, 200, { ok: true });
}

async function handleLogin(req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const { rows: [user] } = await pool.query(
    "SELECT id, password_hash FROM users WHERE lower(email) = $1", [email]
  );
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return json(res, 401, { error: "Wrong email or password" });
  }
  await auth.createSession(res, user.id);
  return json(res, 200, { ok: true });
}

async function handleLogout(req, res) {
  await auth.destroySession(req, res);
  return json(res, 200, { ok: true });
}

// Only ever returns the signed-in user's own record — per-user isolation.
async function handleMe(req, res, user) {
  return json(res, 200, {
    user: { id: user.id, email: user.email, name: user.name },
    persona: user.persona_key || null,
    hr: user.hr_data || null
  });
}

/* ---------- Financial brain ---------- */
// Server-authoritative: the employer's HR data is injected from Postgres here (the client
// cannot fabricate it), and every exchange is persisted for the signed-in user.
async function handleJeff(req, res, user) {
  if (!ai.enabled()) return json(res, 503, {});
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, {}); }
  const prompt = String(body.prompt || "").slice(0, 40000).trim();
  if (!prompt) return json(res, 400, {});
  const { rows: [conv] } = await pool.query(
    `INSERT INTO conversations(user_id) VALUES ($1) RETURNING id`, [user.id]
  );
  const hrBlock = user.hr_data
    ? `EMPLOYER HR DATA (authoritative, from ${user.hr_data.employer || "the employer"}'s HRIS feed)\n${JSON.stringify(user.hr_data, null, 1)}\n\n`
    : "";
  const text = await ai.complete({ system: STYLE, prompt: hrBlock + prompt });
  if (!text) return json(res, 502, {});
  await pool.query(
    "INSERT INTO messages(conversation_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)",
    [conv.id, prompt.slice(0, 8000), text.slice(0, 8000)]
  );
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  const out = match ? match[0] : "{}";
  try { JSON.parse(out); } catch { return json(res, 200, "{}"); }
  return json(res, 200, out);
}

/* ---------- Health: real responsiveness of app + database ---------- */
async function handleHealth(req, res) {
  let db = false;
  try { await pool.query("SELECT 1"); db = true; } catch (e) { console.error("DB health check failed:", e.message); }
  const code = db ? 200 : 503;
  return json(res, code, { ai: ai.enabled(), db });
}

/* ---------- Router ---------- */
const ROUTES = [
  ["GET", /^\/api\/health$/, handleHealth, false],
  ["POST", /^\/api\/auth\/signup$/, handleSignup, false],
  ["POST", /^\/api\/auth\/login$/, handleLogin, false],
  ["POST", /^\/api\/auth\/logout$/, handleLogout, false],
  ["GET", /^\/api\/me$/, handleMe, true],
  ["POST", /^\/api\/hris\/feed$/, handleFeed, false],
  ["POST", /^\/api\/jeff$/, handleJeff, true]
];

http.createServer(async (req, res) => {
  try {
    for (const [method, re, handler, needsUser] of ROUTES) {
      if (req.method !== method || !re.test(req.url.split("?")[0])) continue;
      let user = null;
      if (needsUser) {
        user = await auth.userFromReq(req);
        if (!user) return json(res, 401, { error: "Sign in required" });
      }
      return await handler(req, res, user);
    }
    if (req.method === "GET") {
      // Static app: read fresh on every request so edits show without a restart.
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(HTML_PATH));
    }
    return json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(`Error handling ${req.method} ${req.url}:`, e.message);
    return json(res, 500, { error: "Something went wrong" });
  }
}).listen(PORT, "0.0.0.0", async () => {
  console.log(`Jeff app running on port ${PORT}`);
  try { await migrate(); } catch (e) { console.error("Boot migration failed:", e.message); }
});
