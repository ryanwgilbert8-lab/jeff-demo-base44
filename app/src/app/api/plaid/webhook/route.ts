import { createHash, verify, type JsonWebKey } from "node:crypto";
import { plaid, syncItem } from "@/lib/plaid";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const keyCache = new Map<string, JsonWebKey>();
const b64url = (s: string) => Buffer.from(s, "base64url");

/** Verifies the Plaid-Verification JWT (ES256) and that it covers this exact body. */
async function verified(raw: string, jwt: string | null): Promise<boolean> {
  if (!jwt) return false;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  const header = JSON.parse(b64url(h).toString());
  if (header.alg !== "ES256" || !header.kid) return false;

  let jwk = keyCache.get(header.kid);
  if (!jwk) {
    const { data } = await plaid().webhookVerificationKeyGet({ key_id: header.kid });
    jwk = data.key as unknown as JsonWebKey;
    keyCache.set(header.kid, jwk);
  }
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: jwk, format: "jwk", dsaEncoding: "ieee-p1363" }, b64url(s));
  if (!ok) return false;
  const claims = JSON.parse(b64url(p).toString());
  if (Math.abs(Date.now() / 1000 - claims.iat) > 300) return false;
  return claims.request_body_sha256 === createHash("sha256").update(raw).digest("hex");
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!(await verified(raw, req.headers.get("plaid-verification")))) return Response.json({ error: "unverified" }, { status: 401 });

  const body = JSON.parse(raw) as { webhook_type?: string; webhook_code?: string; item_id?: string };
  const db = supabaseAdmin();
  const { data: item } = await db.from("plaid_items").select("id").eq("item_id", body.item_id ?? "").maybeSingle();
  if (!item) return Response.json({ ok: true });

  if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") await syncItem(item.id);
  if (body.webhook_type === "ITEM" && ["ERROR", "PENDING_EXPIRATION", "PENDING_DISCONNECT"].includes(body.webhook_code ?? "")) {
    await db.from("plaid_items").update({ status: "needs_relink" }).eq("id", item.id);
  }
  return Response.json({ ok: true });
}
