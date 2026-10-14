import { computeSnapshot, guardStep, loadFinances } from "@/lib/data";
import { finishPlan } from "@/app/actions";
import { BUCKET_LABEL, fmt } from "@/lib/engine";
import { Steps } from "@/components/Steps";
import { MoveCard, type Move } from "@/components/MoveCard";

// Recommendation order follows the engine: match, cushion, debt, then the commission rules.
const ORDER = ["match", "hysa", "cushion", "cards", "commission_split", "tax_reserve", "draw_reserve", "roth"];

export default async function PlanPage() {
  await guardStep("plan", "done");
  const f = await loadFinances();
  const snap = computeSnapshot(f);
  const { data } = await f.supabase.from("recommendations").select("id, kind, title, detail, why, value_10y, status").eq("user_id", f.user.id);
  const moves = (data ?? []).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)) as (Move & { kind: string })[];
  const undecided = moves.filter(m => m.status === "pending").length;
  const done = f.profile.onboarding_step === "done";

  return (
    <>
      <div className="pad">
        {!done && <Steps at="plan" />}
        <h1 className="title">Your plan</h1>
        {snap && (
          <p className="lead">
            Each <span className="num">{fmt(snap.plan.income.netPerPaycheck)}</span> paycheck:{" "}
            {snap.plan.allocations.map((a, i) => <span key={a.bucket}>{i ? ", " : ""}{BUCKET_LABEL[a.bucket].toLowerCase()} <b className="num">{fmt(a.perPaycheck)}</b></span>)}.
            Commission is on top, and every check gets split the day it lands.
          </p>
        )}
        {snap?.plan.notes.map(n => <p key={n} className="hint">{n}</p>)}
        {moves.map(m => <MoveCard key={m.id} m={m} />)}
        <p className="small">Jeff tells you exactly what to do for each yes. Nothing moves without you.</p>
      </div>
      {!done && (
        <form action={finishPlan} className="footer">
          <button className="primary">{undecided ? `Start my plan (${undecided} still open)` : "Start my plan"}</button>
        </form>
      )}
    </>
  );
}
