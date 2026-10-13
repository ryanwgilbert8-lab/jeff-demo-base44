import { z } from "zod";
import { getUser, supabaseAdmin } from "@/lib/supabase/server";
import { plaid, syncItem } from "@/lib/plaid";
import { encrypt } from "@/lib/crypto";

export const runtime = "nodejs";

const Body = z.object({ public_token: z.string().min(1), institution: z.string().max(200).nullish() });

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return Response.json({ error: "signed_out" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });

  const { data } = await plaid().itemPublicTokenExchange({ public_token: parsed.data.public_token });
  const db = supabaseAdmin();
  const { data: item, error } = await db.from("plaid_items")
    .upsert({ user_id: user.id, item_id: data.item_id, access_token_enc: encrypt(data.access_token), institution_name: parsed.data.institution ?? null }, { onConflict: "item_id" })
    .select("id").single();
  if (error || !item) return Response.json({ error: "save_failed" }, { status: 500 });

  await db.from("audit_log").insert({ user_id: user.id, actor: "user", action: "connected_bank", payload: { institution: parsed.data.institution ?? null } });
  const result = await syncItem(item.id);
  return Response.json(result);
}
