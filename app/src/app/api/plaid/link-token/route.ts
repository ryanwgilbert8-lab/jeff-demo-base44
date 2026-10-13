import { getUser } from "@/lib/supabase/server";
import { createLinkToken } from "@/lib/plaid";

export const runtime = "nodejs";

export async function POST() {
  const user = await getUser();
  if (!user) return Response.json({ error: "signed_out" }, { status: 401 });
  return Response.json({ link_token: await createLinkToken(user.id) });
}
