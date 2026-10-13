import "server-only";
import { computeSnapshot, type Finances } from "@/lib/data";
import { supabaseAdmin } from "@/lib/supabase/server";

/** Writes the engine's current moves. Keeps the user's yes/no on moves that still apply. */
export async function refreshRecommendations(f: Finances) {
  const snap = computeSnapshot(f);
  if (!snap) return;
  const db = supabaseAdmin();
  const recs = snap.plan.recommendations;
  if (recs.length) {
    await db.from("recommendations").upsert(
      recs.map(r => ({ user_id: f.user.id, kind: r.kind, title: r.title, detail: r.detail, why: r.why, value_10y: r.value10y })),
      { onConflict: "user_id,kind" },
    );
  }
  const kinds = recs.map(r => r.kind);
  const stale = db.from("recommendations").delete().eq("user_id", f.user.id).eq("status", "pending");
  await (kinds.length ? stale.not("kind", "in", `(${kinds.join(",")})`) : stale);
  await db.from("audit_log").insert({ user_id: f.user.id, actor: "jeff", action: "plan_built", payload: { kinds, surplus: snap.plan.surplusPerPaycheck } });
}
