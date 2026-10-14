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
const team = require("./lib/team");
const plaid = require("./lib/plaid");
const live = require("./lib/profile");
const { migrate, seedOrRemoveDemoUsers } = require("./lib/migrate");

const PORT = process.env.PORT || 3000;
const HTML_PATH = path.join(__dirname, "public", "index.html");
const STYLE = `You are Jeff, a money coach that comes with someone's job as a benefit from their employer. Think of the family member everyone wishes they had managing their money: warm, direct, remembers what matters to them, protective of their future, and willing to push back on a bad idea once, kindly, before respecting their call. You never lecture. You can see their linked accounts (read-only) and the plan you agreed together. You cannot move money, open accounts or change payroll yourself: when something needs doing, say exactly what to set up and where. Your reply is spoken aloud: 1 to 3 short sentences, no lists, no markdown, no emoji. Write money like "$4,500". Only use facts in the person's data below. Never state something as fact that the person hasn't confirmed. Never invent accounts.`;

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
  const firstName = String(body.firstName || "").trim().slice(0, 60) || null;
  const teamCode = team.normalize(body.teamCode);
  if (!firstName) return json(res, 400, { error: "Add your first name" });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Enter a valid email address" });
  if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters" });
  const { rows: [existing] } = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [email]);
  if (existing) return json(res, 409, { error: "That email already has an account. Try signing in." });
  if (teamCode) {
    const problem = await team.codeProblem(teamCode);
    if (problem) return json(res, 400, { error: problem });
  }
  // Link to an HRIS-fed employee record by email, when the employer has pushed one.
  const { rows: [employee] } = await pool.query(
    "SELECT id FROM employees WHERE lower(email) = $1 ORDER BY updated_at DESC LIMIT 1", [email]
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users(email, password_hash, name, first_name, employee_id) VALUES ($1, $2, $3, $3, $4) RETURNING id",
    [email, auth.hashPassword(password), firstName, employee ? employee.id : null]
  );
  if (teamCode) {
    const problem = await team.redeem(user.id, teamCode);
    if (problem) console.error("Team code failed after sign-up check:", problem);
  }
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
  const hr = user.hr_data || null;
  const matchPct = hr?.benefits?.retirement?.matchPct ?? (user.employer_id ? Number(user.match_pct) : null);
  return json(res, 200, {
    user: { id: user.id, email: user.email, firstName: user.first_name || user.name || null, isAdmin: !!user.is_admin },
    employer: user.employer_name ? {
      name: user.employer_name,
      matchPct,
      k401Provider: user.k401_provider || null,
      payFrequency: hr?.payFrequency || user.pay_frequency || null
    } : null,
    cohort: user.cohort || null,
    answers: user.answers || {},
    hr
  });
}

// Join an employer after sign-up (or switch to a new one) with a team code.
async function handleJoin(req, res, user) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const problem = await team.redeem(user.id, body.code);
  if (problem) return json(res, 400, { error: problem });
  return json(res, 200, { ok: true });
}

// Saves what the user has told Jeff (merged into their stored answers).
async function handleAnswers(req, res, user) {
  let body;
  try { body = await readBody(req, 50000); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (!body || typeof body.answers !== "object" || Array.isArray(body.answers)) return json(res, 400, { error: "Body must be { answers: {...} }" });
  const clean = {};
  for (const [k, v] of Object.entries(body.answers).slice(0, 50)) {
    if (/^[a-zA-Z0-9_]{1,40}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)) clean[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  const { rows: [row] } = await pool.query("UPDATE users SET answers = answers || $1::jsonb WHERE id = $2 RETURNING answers", [JSON.stringify(clean), user.id]);
  return json(res, 200, { answers: row.answers });
}

/* ---------- Banks (Plaid, read-only) ---------- */
async function bankStatus(userId) {
  const [{ rows: items }, { rows: accounts }, { rows: [tx] }] = await Promise.all([
    pool.query("SELECT id, institution_name AS institution, status, synced_at AS \"syncedAt\" FROM plaid_items WHERE user_id = $1 ORDER BY created_at", [userId]),
    pool.query(`SELECT id, plaid_item_id AS "itemId", name, mask, institution, kind, subtype, balance::float, apr::float, min_payment::float AS "minPayment"
                  FROM accounts WHERE user_id = $1 ORDER BY institution, kind, name`, [userId]),
    pool.query("SELECT count(*)::int AS n, min(date) AS since FROM transactions WHERE user_id = $1", [userId]),
  ]);
  return { enabled: plaid.enabled(), env: plaid.env(), items, accounts, transactions: tx.n, since: tx.since };
}
async function handleBank(req, res, user) { return json(res, 200, await bankStatus(user.id)); }

async function handleLinkToken(req, res, user) {
  if (!plaid.enabled()) return json(res, 503, { error: "Bank connections aren't switched on yet." });
  try { return json(res, 200, { linkToken: await plaid.createLinkToken(user.id) }); }
  catch (e) { console.error("link token:", e.message); return json(res, 502, { error: "Couldn't start the bank connection. Try again." }); }
}

async function handleExchange(req, res, user) {
  if (!plaid.enabled()) return json(res, 503, { error: "Bank connections aren't switched on yet." });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (!body.publicToken) return json(res, 400, { error: "Missing publicToken" });
  try {
    const itemId = await plaid.exchange(user.id, String(body.publicToken), body.institution);
    try { await plaid.syncItem(itemId); } catch (e) { console.error("first sync:", e.message); }
    return json(res, 200, await bankStatus(user.id));
  } catch (e) {
    console.error("exchange:", e.message);
    return json(res, 502, { error: "Couldn't finish connecting that bank. Try again." });
  }
}

async function handleBankSync(req, res, user) {
  const r = await plaid.syncUser(user.id);
  return json(res, 200, { ...(await bankStatus(user.id)), errors: r.errors });
}

async function handleBankRemove(req, res, user) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const ok = await plaid.removeItem(user.id, Number(body.id));
  return ok ? json(res, 200, await bankStatus(user.id)) : json(res, 404, { error: "Not found" });
}

// Plaid tells us when new transactions are ready. Verified, then we pull them.
async function handlePlaidWebhook(req, res) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) return json(res, 413, {}); }
  let ok = false;
  try { ok = await plaid.verifyWebhook(raw, req.headers["plaid-verification"]); } catch (e) { console.error("webhook verify:", e.message); }
  if (!ok) return json(res, 401, { error: "unverified" });
  const body = JSON.parse(raw);
  const { rows: [item] } = await pool.query("SELECT id FROM plaid_items WHERE item_id = $1", [String(body.item_id || "")]);
  if (item) {
    if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") plaid.syncItem(item.id).catch(e => console.error("webhook sync:", e.message));
    if (body.webhook_type === "ITEM" && ["ERROR", "PENDING_EXPIRATION", "PENDING_DISCONNECT"].includes(body.webhook_code)) {
      await pool.query("UPDATE plaid_items SET status = 'needs_relink' WHERE id = $1", [item.id]);
    }
  }
  return json(res, 200, { ok: true });
}

/* ---------- The real-data experience ---------- */
async function handleLiveProfile(req, res, user) { return json(res, 200, await live.profile(user)); }

async function handleLivePlan(req, res, user) {
  let body;
  try { body = await readBody(req, 200000); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  const living = Array.isArray(body.living) ? body.living.slice(0, 60).map(l => ({ key: String(l.key || "").slice(0, 40), name: String(l.name || "").slice(0, 80), amt: Number(l.amt) || 0, type: ["fixed", "need", "want"].includes(l.type) ? l.type : "want" })) : [];
  const ans = body.ans && typeof body.ans === "object" ? body.ans : {};
  const pay = Number(body.pay) > 0 && Number(body.pay) < 100000 ? Number(body.pay) : null;
  return json(res, 200, await live.plan(user, { living, ans, pay }));
}

async function handleLiveState(req, res, user) {
  let body;
  try { body = await readBody(req, 300000); } catch { return json(res, 400, { error: "Invalid JSON" }); }
  if (!body || typeof body.state !== "object" || Array.isArray(body.state)) return json(res, 400, { error: "Body must be { state: {...} }" });
  await live.saveState(user.id, body.state);
  return json(res, 200, { ok: true });
}

/* ---------- Admin: employers and team codes ---------- */
async function adminOnly(req, res, user, fn) {
  if (!user.is_admin) return json(res, 403, { error: "Admins only" });
  let body = {};
  if (req.method === "POST") { try { body = await readBody(req); } catch { return json(res, 400, { error: "Invalid JSON" }); } }
  const out = await fn(body);
  return json(res, out && out.error ? 400 : 200, out);
}
const handleAdminOverview = (req, res, user) => adminOnly(req, res, user, () => team.overview());
const handleAdminEmployer = (req, res, user) => adminOnly(req, res, user, b => team.createEmployer(b));
const handleAdminCode = (req, res, user) => adminOnly(req, res, user, b => team.createCode(b));

// Sample HR records for the /demo personas. Fake data, safe to serve publicly.
function handleDemoHr(req, res) {
  const feed = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "employer.json"), "utf8"));
  return json(res, 200, feed.employees || {});
}

/* ---------- Financial brain: custom plan builder ---------- */
// The money engine decides the moves and every number in them. The brain personalizes the
// words (and can add up to two advice-only moves); it never changes the numbers.
const PLAN_STYLE = STYLE + `

You are now DESIGNING this person's plan, not chatting. Keep every dollar amount, percent and date exactly as given in the candidate moves. You get their authoritative HR record (if any), their confirmed answers from the conversation, their agreed money numbers, and the candidate plan moves the platform can execute. Personalize the plan: keep the machinery, make every word and every choice fit this exact person. Ground every line in their real numbers. Never invent accounts, employers, rates, or numbers that are not in the data. Say lines are spoken aloud: 1 to 3 short sentences, no lists, no markdown, no emoji. Write money like "$4,500".`;

async function handlePlan(req, res, user) {
  if (!ai.enabled()) return json(res, 503, {});
  let body;
  try { body = await readBody(req, 2e6); } catch { return json(res, 400, {}); }
  const moves = Array.isArray(body.moves) ? body.moves.filter(m => m && m.id) .slice(0, 20) : [];
  if (!moves.length) return json(res, 400, {});
  const n = v => (isFinite(v) ? Math.round(v) : 0);
  const prompt = `PERSON'S HR RECORD (authoritative)
${user.hr_data ? JSON.stringify(user.hr_data, null, 1) : "(none — rely on their confirmed answers)"}

CONFIRMED ANSWERS
${JSON.stringify(body.answers || {}, null, 1)}

MONEY CONFIRMED IN CONVERSATION
Take-home: $${n(body.takeHomeM)}/mo · pay $${n(body.pay)} per paycheck
Agreed monthly living: $${n(body.livingM)} (bills $${n(body.billsM)}, spending $${n(body.spendM)})
Pool available each paycheck for the plan: $${n(body.poolM)}

CANDIDATE MOVES
${JSON.stringify(moves.map(m => ({ id: m.id, kind: m.kind, title: m.title, detail: m.detail })), null, 1)}

TASK
Build this person's plan. For each candidate move: decide keep (true/false — drop moves that don't fit their situation) and rewrite say, why and detail personalized to their real numbers, answers and employer data. You may add up to 2 extra custom moves (advice only — no opening accounts, no transfers) with insertBefore set to a candidate id ("safe" puts it near the end). NEVER drop the move with id "safe". Order stays as listed. Return only JSON, no code fences:
{"intro": string, "moves": [{"id": string, "keep": boolean, "say": string, "why": string, "detail": string}], "extra": [{"title": string, "detail": string, "say": string, "why": string, "insertBefore": string}]}`;
  const text = await ai.complete({ system: PLAN_STYLE, prompt, maxTokens: 1600 });
  if (!text) return json(res, 502, {});
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) return json(res, 502, {});
  let plan;
  try { plan = JSON.parse(match[0]); } catch { return json(res, 502, {}); }
  // Sanitize against the client's actual machinery: only known ids, and "safe" is never dropped.
  const ids = new Set(moves.map(m => m.id));
  plan.moves = (Array.isArray(plan.moves) ? plan.moves : []).filter(m => m && ids.has(m.id));
  if (moves.some(m => m.id === "safe")) {
    const safe = plan.moves.find(m => m.id === "safe");
    if (safe) safe.keep = true; else plan.moves.push({ id: "safe", keep: true });
  }
  plan.extra = (Array.isArray(plan.extra) ? plan.extra : []).filter(x => x && x.title && x.say).slice(0, 2);
  await pool.query("INSERT INTO plans(user_id, data) VALUES ($1, $2)", [user.id, JSON.stringify(plan)]);
  return json(res, 200, plan);
}

/* ---------- Financial brain: chat ---------- */
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
  ["POST", /^\/api\/me\/join$/, handleJoin, true],
  ["POST", /^\/api\/me\/answers$/, handleAnswers, true],
  ["GET", /^\/api\/admin\/overview$/, handleAdminOverview, true],
  ["POST", /^\/api\/admin\/employers$/, handleAdminEmployer, true],
  ["POST", /^\/api\/admin\/codes$/, handleAdminCode, true],
  ["GET", /^\/api\/demo\/hr$/, handleDemoHr, false],
  ["GET", /^\/api\/bank$/, handleBank, true],
  ["POST", /^\/api\/bank\/link-token$/, handleLinkToken, true],
  ["POST", /^\/api\/bank\/exchange$/, handleExchange, true],
  ["POST", /^\/api\/bank\/sync$/, handleBankSync, true],
  ["POST", /^\/api\/bank\/remove$/, handleBankRemove, true],
  ["POST", /^\/api\/plaid\/webhook$/, handlePlaidWebhook, false],
  ["GET", /^\/api\/live\/profile$/, handleLiveProfile, true],
  ["POST", /^\/api\/live\/plan$/, handleLivePlan, true],
  ["POST", /^\/api\/live\/state$/, handleLiveState, true],
  ["POST", /^\/api\/hris\/feed$/, handleFeed, false],
  ["POST", /^\/api\/jeff$/, handleJeff, true],
  ["POST", /^\/api\/plan$/, handlePlan, true]
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
  try { await migrate(); await seedOrRemoveDemoUsers(); } catch (e) { console.error("Boot migration failed:", e.message); }
});
