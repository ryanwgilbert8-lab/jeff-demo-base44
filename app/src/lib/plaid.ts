import "server-only";
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products, type AccountBase, type Transaction as PlaidTxn } from "plaid";
import { env } from "@/lib/env";
import { decrypt } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { AccountKind } from "@/lib/engine";

let client: PlaidApi | null = null;
export function plaid(): PlaidApi {
  if (client) return client;
  const environment = process.env.PLAID_ENV === "production" ? "production" : "sandbox";
  client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[environment],
    baseOptions: { headers: { "PLAID-CLIENT-ID": env("PLAID_CLIENT_ID"), "PLAID-SECRET": env("PLAID_SECRET") } },
  }));
  return client;
}

export async function createLinkToken(userId: string) {
  const { data } = await plaid().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "Jeff",
    language: "en",
    country_codes: [CountryCode.Us],
    products: [Products.Transactions],
    // APRs and minimum payments for cards and loans, when the bank supports it.
    optional_products: [Products.Liabilities],
    transactions: { days_requested: 180 },
    webhook: process.env.PLAID_WEBHOOK_URL || undefined,
  });
  return data.link_token;
}

function kindOf(a: AccountBase): AccountKind {
  switch (a.type) {
    case "depository": return a.subtype === "savings" || a.subtype === "money market" || a.subtype === "cd" ? "savings" : "checking";
    case "credit": return "credit";
    case "loan": return "loan";
    case "investment": return "investment";
    default: return "other";
  }
}

const balanceOf = (a: AccountBase) => Math.abs(a.balances.current ?? a.balances.available ?? 0);

/** Pulls accounts, liabilities and new transactions for one Plaid item into the database. */
export async function syncItem(itemRowId: string) {
  const db = supabaseAdmin();
  const { data: item, error } = await db.from("plaid_items").select("*").eq("id", itemRowId).single();
  if (error || !item) throw new Error("Plaid item not found");
  const token = decrypt(item.access_token_enc);
  const api = plaid();

  // Accounts + rates
  const { data: acc } = await api.accountsGet({ access_token: token });
  const rates = new Map<string, { apr: number | null; min: number | null }>();
  try {
    const { data: liab } = await api.liabilitiesGet({ access_token: token });
    for (const c of liab.liabilities.credit ?? []) {
      const purchase = c.aprs.find(r => r.apr_type === "purchase_apr") ?? c.aprs[0];
      if (c.account_id) rates.set(c.account_id, { apr: purchase ? purchase.apr_percentage / 100 : null, min: c.minimum_payment_amount });
    }
    for (const s of liab.liabilities.student ?? []) {
      if (s.account_id) rates.set(s.account_id, { apr: s.interest_rate_percentage / 100, min: s.minimum_payment_amount });
    }
  } catch {
    // Liabilities is optional; the engine assumes a typical card APR when it's missing.
  }

  const rows = acc.accounts.map(a => ({
    user_id: item.user_id,
    plaid_item_id: item.id,
    plaid_account_id: a.account_id,
    name: a.official_name || a.name,
    mask: a.mask,
    institution: item.institution_name,
    kind: kindOf(a),
    balance: balanceOf(a),
    apr: rates.get(a.account_id)?.apr ?? null,
    min_payment: rates.get(a.account_id)?.min ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { data: saved, error: accErr } = await db.from("accounts").upsert(rows, { onConflict: "plaid_account_id" }).select("id, plaid_account_id");
  if (accErr) throw accErr;
  const accountId = new Map((saved ?? []).map(r => [r.plaid_account_id, r.id]));

  // Transactions (cursor-based, resumable)
  let cursor: string | undefined = item.sync_cursor ?? undefined;
  const added: PlaidTxn[] = [];
  const removed: string[] = [];
  for (let page = 0; page < 50; page++) {
    const { data } = await api.transactionsSync({ access_token: token, cursor, count: 500 });
    added.push(...data.added, ...data.modified);
    removed.push(...data.removed.map(r => r.transaction_id).filter((x): x is string => !!x));
    cursor = data.next_cursor;
    if (!data.has_more) break;
  }

  const txRows = added
    .filter(t => accountId.has(t.account_id))
    .map(t => ({
      user_id: item.user_id,
      account_id: accountId.get(t.account_id)!,
      plaid_transaction_id: t.transaction_id,
      date: t.date,
      name: t.name,
      merchant_name: t.merchant_name ?? null,
      amount: t.amount,
      category_primary: t.personal_finance_category?.primary ?? null,
      category_detailed: t.personal_finance_category?.detailed ?? null,
      pending: t.pending,
    }));
  for (let i = 0; i < txRows.length; i += 500) {
    const { error: e } = await db.from("transactions").upsert(txRows.slice(i, i + 500), { onConflict: "plaid_transaction_id" });
    if (e) throw e;
  }
  if (removed.length) await db.from("transactions").delete().in("plaid_transaction_id", removed);
  await db.from("plaid_items").update({ sync_cursor: cursor, status: "ok" }).eq("id", item.id);
  return { accounts: rows.length, transactions: txRows.length };
}
