import Link from "next/link";
import { computeSnapshot, guardStep, loadFinances } from "@/lib/data";
import { signOut } from "@/app/actions";
import { BUCKET_LABEL, type Bucket, fmt, routeCommission, sum } from "@/lib/engine";
import { JeffChat } from "@/components/JeffChat";
import { RefreshBanks } from "@/components/RefreshBanks";

const COLOR: Record<Bucket, string> = {
  living: "var(--line)", cushion: "var(--mint)", cards: "var(--flag)", roth: "var(--jeff2)", savings: "var(--gold)",
  tax_reserve: "#8FA198", draw_reserve: "#B58A3C", base_gap: "#6B7C74", yours: "#5BB8E0",
};
const day = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function SplitBar({ rows }: { rows: { bucket: Bucket; amount: number }[] }) {
  const total = sum(rows.map(r => r.amount)) || 1;
  return (
    <>
      <div className="bar">{rows.map(r => <i key={r.bucket} style={{ flexGrow: r.amount / total, background: COLOR[r.bucket] }} />)}</div>
      <ul className="legend">{rows.map(r => <li key={r.bucket}><i style={{ background: COLOR[r.bucket] }} />{BUCKET_LABEL[r.bucket]}<span className="num">{fmt(r.amount)}</span></li>)}</ul>
    </>
  );
}

export default async function Home() {
  await guardStep("done");
  const f = await loadFinances();
  const snap = computeSnapshot(f);
  if (!snap || !f.comp) return <div className="pad"><p>Finish setting up your pay first. <Link href="/income">Go to pay details</Link></p></div>;

  const { plan } = snap;
  const cardDebt = sum(plan.debts.map(d => d.balance));
  const example = Math.max(500, Math.round(plan.income.targetCommissionMonthlyGross * 0.65 / 100) * 100);
  const commissionSplit = routeCommission(plan, example, { cushionBalance: plan.cushion.current, cardDebt }, f.comp);
  const [{ data: past }, { data: yes }] = await Promise.all([
    f.supabase.from("messages").select("role, content").eq("user_id", f.user.id).order("created_at", { ascending: false }).limit(20),
    f.supabase.from("recommendations").select("title").eq("user_id", f.user.id).eq("status", "approved"),
  ]);
  const name = f.profile.first_name ?? "there";

  return (
    <>
      <div className="pad">
        <div className="hhead">
          <span className="small">Hi, {name}</span>
          <form action={signOut}><button className="secondary" style={{ padding: "4px 10px", fontSize: 12 }}>Sign out</button></form>
        </div>

        <p className="small" style={{ margin: 0 }}>Safe to spend</p>
        <p className="big num">{fmt(snap.safe)}</p>
        <p className="small" style={{ margin: 0 }}>{snap.nextPayDate ? `until payday, ${day(snap.nextPayDate)}` : "until your next paycheck"}. Bills and plan money are already set aside.</p>

        <section className="sec">
          <h2>Each {fmt(plan.income.netPerPaycheck)} paycheck</h2>
          <SplitBar rows={plan.allocations.map(a => ({ bucket: a.bucket, amount: a.perPaycheck }))} />
        </section>

        <section className="sec">
          <h2>When a {fmt(example)} commission lands</h2>
          <SplitBar rows={commissionSplit} />
          {snap.recentCommissions.length > 0 && (
            <p className="small">Recent commissions: {snap.recentCommissions.map(d => `${fmt(d.commission)} on ${day(d.date)}`).join(", ")}.</p>
          )}
        </section>

        <section className="sec">
          <h2>Where you stand</h2>
          <div className="card">
            <p style={{ margin: "0 0 6px" }}>Cushion <b className="num">{fmt(plan.cushion.current)}</b> of {fmt(plan.cushion.fullTarget)}</p>
            {cardDebt > 0 && <p style={{ margin: "0 0 6px" }}>High-interest debt <b className="num">{fmt(cardDebt)}</b>{plan.payoff?.monthsToFree ? `, gone in ${plan.payoff.monthsToFree} months on base pay alone` : ""}</p>}
            <p style={{ margin: 0 }}>Checking <b className="num">{fmt(snap.checking)}</b></p>
          </div>
        </section>

        <section className="sec">
          <h2>Your moves</h2>
          {yes?.length ? <ul className="list">{yes.map(m => <li key={m.title}><span className="nm">{m.title}</span></li>)}</ul> : <p className="small">You haven&apos;t said yes to any moves yet.</p>}
          <p style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <Link className="secondary" href="/plan">See the plan</Link>
            <Link className="secondary" href="/living">Edit spending</Link>
            <Link className="secondary" href="/income">Edit pay</Link>
            <Link className="secondary" href="/connect">Accounts</Link>
            <RefreshBanks />
          </p>
        </section>
      </div>
      <JeffChat
        initial={(past ?? []).reverse() as { role: "user" | "assistant"; content: string }[]}
        greeting={`Hey ${name}. You can spend ${fmt(snap.safe)} before payday and still stay on plan. Ask me anything.`}
      />
    </>
  );
}
