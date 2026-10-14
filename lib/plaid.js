// Plaid: read-only bank connections. Talks to Plaid's REST API directly (no SDK).
// Secrets: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox | production).
// Access tokens are encrypted with AES-256-GCM. The key is TOKEN_ENCRYPTION_KEY if set
// (32 bytes, base64), otherwise derived from PLAID_SECRET, so a copy of the database alone
// can't be used to read anyone's bank data.
const crypto = require("crypto");
const pool = require("./db");

const env = () => (process.env.PLAID_ENV === "production" ? "production" : "sandbox");
// PLAID_BASE_URL is only for local testing against a fake Plaid server.
const BASE = () => process.env.PLAID_BASE_URL || `https://${env()}.plaid.com`;
const enabled = () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

class PlaidError extends Error {
  constructor(status, body) {
    super(`Plaid ${status}: ${body.error_code || ""} ${body.error_message || ""}`.trim());
    this.code = body.error_code;
    this.type = body.error_type;
  }
}

async function call(path, body) {
  const r = await fetch(BASE() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PlaidError(r.status, j);
  return j;
}

/* ---------- token encryption ---------- */
function key() {
  if (process.env.TOKEN_ENCRYPTION_KEY) {
    const k = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "base64");
    if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64");
    return k;
  }
  return Buffer.from(crypto.hkdfSync("sha256", process.env.PLAID_SECRET, "jeff", "plaid-access-token-v1", 32));
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data].map(x => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}
function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(".");
  if (v !== "v1") throw new Error("Unknown token format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/* ---------- linking ---------- */
async function createLinkToken(userId) {
  const j = await call("/link/token/create", {
    user: { client_user_id: String(userId) },
    client_name: "Jeff",
    language: "en",
    country_codes: ["US"],
    products: ["transactions"],
    // Card APRs and minimum payments, when the bank supports it.
    optional_products: ["liabilities"],
    transactions: { days_requested: 180 },
    webhook: process.env.PLAID_WEBHOOK_URL || undefined,
  });
  return j.link_token;
}

async function exchange(userId, publicToken, institution) {
  const j = await call("/item/public_token/exchange", { public_token: publicToken });
  const { rows: [item] } = await pool.query(
    `INSERT INTO plaid_items(user_id, item_id, access_token_enc, institution_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, status = 'ok'
     RETURNING id`,
    [userId, j.item_id, encrypt(j.access_token), String(institution || "").slice(0, 120) || null]
  );
  return item.id;
}

/* ---------- syncing ---------- */
function kindOf(a) {
  if (a.type === "depository") return ["savings", "money market", "cd"].includes(a.subtype) ? "savings" : "checking";
  if (a.type === "credit") return "credit";
  if (a.type === "loan") return "loan";
  if (a.type === "investment") return "investment";
  return "other";
}

/** Pulls accounts, card/loan rates and new transactions for one connected bank. */
async function syncItem(itemRowId) {
  const { rows: [item] } = await pool.query("SELECT * FROM plaid_items WHERE id = $1", [itemRowId]);
  if (!item) throw new Error("Bank connection not found");
  const token = decrypt(item.access_token_enc);
  try {
    const acc = await call("/accounts/get", { access_token: token });
    const rates = new Map();
    try {
      const l = (await call("/liabilities/get", { access_token: token })).liabilities || {};
      for (const c of l.credit || []) {
        const apr = (c.aprs || []).find(r => r.apr_type === "purchase_apr") || (c.aprs || [])[0];
        if (c.account_id) rates.set(c.account_id, { apr: apr ? apr.apr_percentage / 100 : null, min: c.minimum_payment_amount });
      }
      for (const s of l.student || []) if (s.account_id) rates.set(s.account_id, { apr: s.interest_rate_percentage / 100, min: s.minimum_payment_amount });
      for (const m of l.mortgage || []) if (m.account_id) rates.set(m.account_id, { apr: (m.interest_rate?.percentage ?? null) === null ? null : m.interest_rate.percentage / 100, min: m.next_monthly_payment });
    } catch {
      // Liabilities is optional; the engine assumes a typical card APR when it's missing.
    }
    const ids = new Map();
    for (const a of acc.accounts) {
      const r = rates.get(a.account_id) || {};
      const { rows: [row] } = await pool.query(
        `INSERT INTO accounts(user_id, plaid_item_id, plaid_account_id, name, mask, institution, kind, subtype, balance, apr, min_payment, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name, mask = EXCLUDED.mask, kind = EXCLUDED.kind, subtype = EXCLUDED.subtype,
           balance = EXCLUDED.balance, apr = COALESCE(EXCLUDED.apr, accounts.apr), min_payment = COALESCE(EXCLUDED.min_payment, accounts.min_payment), updated_at = now()
         RETURNING id`,
        [item.user_id, item.id, a.account_id, a.official_name || a.name, a.mask, item.institution_name, kindOf(a), a.subtype,
         Math.abs(a.balances.current ?? a.balances.available ?? 0), r.apr ?? null, r.min ?? null]
      );
      ids.set(a.account_id, row.id);
    }

    let cursor = item.sync_cursor || undefined, added = 0;
    for (let page = 0; page < 50; page++) {
      const j = await call("/transactions/sync", { access_token: token, cursor, count: 500 });
      for (const t of [...j.added, ...j.modified]) {
        if (!ids.has(t.account_id)) continue;
        await pool.query(
          `INSERT INTO transactions(user_id, account_id, plaid_transaction_id, date, name, merchant_name, amount, category_primary, category_detailed, pending)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (plaid_transaction_id) DO UPDATE SET date = EXCLUDED.date, name = EXCLUDED.name, merchant_name = EXCLUDED.merchant_name,
             amount = EXCLUDED.amount, category_primary = EXCLUDED.category_primary, category_detailed = EXCLUDED.category_detailed, pending = EXCLUDED.pending`,
          [item.user_id, ids.get(t.account_id), t.transaction_id, t.date, t.name || t.merchant_name || "Transaction", t.merchant_name || null, t.amount,
           t.personal_finance_category?.primary || null, t.personal_finance_category?.detailed || null, !!t.pending]
        );
        added++;
      }
      const removed = (j.removed || []).map(r => r.transaction_id).filter(Boolean);
      if (removed.length) await pool.query("DELETE FROM transactions WHERE plaid_transaction_id = ANY($1)", [removed]);
      cursor = j.next_cursor;
      if (!j.has_more) break;
    }
    await pool.query("UPDATE plaid_items SET sync_cursor = $1, status = 'ok', synced_at = now() WHERE id = $2", [cursor, item.id]);
    // New data: see if there's anything Jeff should speak up about.
    try { await require("./watch").checkUser(item.user_id); } catch (e) { console.error("watch:", e.message); }
    return { accounts: acc.accounts.length, transactions: added };
  } catch (e) {
    if (e.code === "ITEM_LOGIN_REQUIRED") await pool.query("UPDATE plaid_items SET status = 'needs_relink' WHERE id = $1", [item.id]);
    throw e;
  }
}

async function syncUser(userId) {
  const { rows } = await pool.query("SELECT id FROM plaid_items WHERE user_id = $1", [userId]);
  const out = { accounts: 0, transactions: 0, errors: 0 };
  for (const r of rows) {
    try { const x = await syncItem(r.id); out.accounts += x.accounts; out.transactions += x.transactions; }
    catch (e) { out.errors++; console.error("Plaid sync failed:", e.message); }
  }
  return out;
}

/** Background refresh: re-syncs banks not synced in the last few hours (webhooks are the fast path). */
async function syncStale(hours = 6) {
  if (!enabled()) return;
  const { rows } = await pool.query("SELECT id FROM plaid_items WHERE status = 'ok' AND (synced_at IS NULL OR synced_at < now() - make_interval(hours => $1)) ORDER BY synced_at NULLS FIRST LIMIT 200", [hours]);
  for (const r of rows) {
    try { await syncItem(r.id); } catch (e) { console.error("background sync:", e.message); }
  }
}

async function removeItem(userId, itemRowId) {
  const { rows: [item] } = await pool.query("SELECT * FROM plaid_items WHERE id = $1 AND user_id = $2", [itemRowId, userId]);
  if (!item) return false;
  try { await call("/item/remove", { access_token: decrypt(item.access_token_enc) }); } catch (e) { console.error("Plaid item/remove:", e.message); }
  await pool.query("DELETE FROM plaid_items WHERE id = $1", [item.id]);
  return true;
}

/* ---------- webhooks ---------- */
const keyCache = new Map();
/** Checks the Plaid-Verification JWT (ES256) covers exactly this body and is fresh. */
async function verifyWebhook(raw, jwt) {
  if (!jwt) return false;
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return false;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== "ES256" || !header.kid) return false;
  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    jwk = (await call("/webhook_verification_key/get", { key_id: header.kid })).key;
    keyCache.set(header.kid, jwk);
  }
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: jwk, format: "jwk", dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  if (!ok) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (Math.abs(Date.now() / 1000 - claims.iat) > 300) return false;
  return claims.request_body_sha256 === crypto.createHash("sha256").update(raw).digest("hex");
}

module.exports = { enabled, env, createLinkToken, exchange, syncItem, syncUser, syncStale, removeItem, verifyWebhook, encrypt, decrypt };
