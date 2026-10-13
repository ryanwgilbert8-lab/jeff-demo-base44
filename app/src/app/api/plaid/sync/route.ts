import { getUser, supabaseAdmin } from "@/lib/supabase/server";
import { syncItem } from "@/lib/plaid";

export const runtime = "nodejs";

/** Re-pulls all of the user's banks. Transactions can take a minute to appear after linking. */
export async function POST() {
  const user = await getUser();
  if (!user) return Response.json({ error: "signed_out" }, { status: 401 });
  const { data: items } = await supabaseAdmin().from("plaid_items").select("id").eq("user_id", user.id);
  let transactions = 0, accounts = 0;
  for (const i of items ?? []) {
    const r = await syncItem(i.id);
    transactions += r.transactions;
    accounts += r.accounts;
  }
  return Response.json({ accounts, transactions });
}
