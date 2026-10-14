// Jeff on his own, for real: after each bank sync, look at what actually happened and write
// a notice when it's worth speaking up (payday, a commission, spending creeping past what was
// agreed, a planned transfer that didn't happen). Notices show up in the app on next open.
const pool = require("./db");
const E = require("./engine");
const { loadData, agreedPlan } = require("./profile");
const { fmt } = E;

const DAY = 864e5;
const daysAgo = iso => Math.floor((Date.now() - new Date(iso + "T12:00:00Z").getTime()) / DAY);
const dayName = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long" });

async function add(userId, key, kind, body) {
  const r = await pool.query("INSERT INTO notices(user_id, key, kind, body) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO NOTHING RETURNING id", [userId, key, kind, body]);
  return r.rowCount;
}

/** Checks one user's latest data and records anything new. Returns how many notices were added. */
async function checkUser(userId) {
  const { rows: [user] } = await pool.query(
    `SELECT u.*, e.data AS hr_data FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = $1`, [userId]);
  if (!user) return 0;
  const data = await loadData(userId);
  const st = data.state;
  if (!st || !st.plan) return 0; // nothing to watch until they've agreed a plan
  const detected = E.detectIncome(data.txns);
  const { plan, comp } = agreedPlan(user, { ...data, detected });
  const routes = Array.isArray(st.routes) ? st.routes : [];
  // Only judge what happened after the plan was agreed.
  const planned = String(st.plannedAt || data.stateUpdatedAt?.toISOString?.() || E.toISO(new Date())).slice(0, 10);
  const afterPlan = d => d.date >= planned;
  let added = 0;

  for (const d of (detected?.deposits || []).filter(afterPlan)) {
    const age = daysAgo(d.date);
    if (age > 4) continue; // only fresh news, never a backlog
    if (d.base > 0) {
      const todo = routes.length ? ` ${age === 0 ? "Today's" : "This paycheck's"} transfers: ${routes.map(r => `${fmt(r.amt)} to ${r.to}`).join(", ")}.` : "";
      added += await add(userId, `pay:${d.date}`, "payday", `Payday. ${fmt(d.base)} landed ${age === 0 ? "today" : dayName(d.date)}.${todo}`);
    }
    if (d.commission > 0) {
      const cardDebt = E.sum(plan.debts.map(x => x.balance));
      const split = E.routeCommission(plan, d.commission, { cushionBalance: plan.cushion.current, cardDebt }, comp);
      added += await add(userId, `comm:${d.date}`, "commission",
        `Your ${fmt(d.commission)} commission landed. Here's its job: ${split.map(x => `${fmt(x.amount)} ${E.BUCKET_LABEL[x.bucket].toLowerCase()}`).join(", ")}. The ${fmt(split.find(x => x.bucket === "yours")?.amount || 0)} is yours, no questions.`);
    }
  }

  // Spending creep: a flexible category running well past the pace agreed, counted from the
  // later of the start of the month and the day the plan was agreed, after at least a week.
  const now = new Date(), todayIso = E.toISO(now), month = todayIso.slice(0, 7);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const from = planned > month + "-01" ? planned : month + "-01";
  const days = E.daysBetween(from, todayIso) + 1;
  if (days >= 7) {
    const spent = new Map();
    for (const t of data.txns) {
      if (t.amount <= 0 || t.pending || t.date < from) continue;
      const b = E.bucketFor(t); if (b && b.kind === "want") spent.set(b.key, (spent.get(b.key) || 0) + t.amount);
    }
    for (const item of st.living || []) {
      if (item.type !== "want" || !item.key) continue;
      const agreed = Number(item.amt) || 0, sofar = spent.get(item.key) || 0;
      const allowed = (agreed * days) / daysInMonth;
      if (agreed > 0 && sofar > allowed * 1.25 && sofar - allowed > 30) {
        added += await add(userId, `creep:${item.key}:${month}`, "creep",
          `${item.name} is at ${fmt(sofar)} over the last ${days} days. That's ahead of the ${fmt(agreed)} a month we agreed on. Want to ease off for a bit, or should I find the difference somewhere else?`);
      }
    }
  }

  // A planned transfer that didn't happen after payday (only if they said they'd set them up).
  if (st.autoRun && routes.length) {
    const checkingIds = new Set(data.accounts.filter(a => a.kind === "checking").map(a => String(a.id)));
    for (const d of (detected?.deposits || []).filter(x => x.base > 0 && afterPlan(x))) {
      const age = daysAgo(d.date);
      if (age < 3 || age > 7) continue;
      const window = data.txns.filter(t => checkingIds.has(t.accountId) && t.amount > 0 && t.date >= d.date && E.daysBetween(d.date, t.date) <= 3);
      for (const r of routes) {
        const hit = window.some(t => Math.abs(t.amount - r.amt) <= Math.max(5, r.amt * 0.2) && /TRANSFER_OUT|LOAN_PAYMENTS/.test(t.categoryPrimary || ""));
        if (!hit) added += await add(userId, `missing:${r.label}:${d.date}`, "missing",
          `I didn't see the ${fmt(r.amt)} ${r.label.toLowerCase()} transfer after ${dayName(d.date)}'s paycheck. If it's not set up as automatic yet, that's the one thing to do this week.`);
      }
    }
  }
  return added;
}

async function forUser(userId, { unreadOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, body, created_at AS "createdAt", read_at IS NOT NULL AS read FROM notices
      WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 30`, [userId]);
  return rows;
}

async function markRead(userId) {
  await pool.query("UPDATE notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
}

module.exports = { checkUser, forUser, markRead };
