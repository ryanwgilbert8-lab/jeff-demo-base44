import { decide } from "@/app/actions";
import { fmt } from "@/lib/engine/money";

export type Move = { id: string; title: string; detail: string; why: string; value_10y: number | string; status: string };

export function MoveCard({ m }: { m: Move }) {
  const value = Number(m.value_10y);
  return (
    <article className={`move ${m.status}`}>
      <h3>{m.title}</h3>
      <p>{m.detail}</p>
      <p className="why">{m.why}</p>
      {value > 0 && <p className="val">Worth about {fmt(value)} over 10 years</p>}
      <form action={decide} className="acts">
        <input type="hidden" name="id" value={m.id} />
        {m.status === "pending" ? (
          <>
            <button className="secondary" name="status" value="approved" style={{ background: "var(--jeff)", color: "var(--onjeff)", borderColor: "var(--jeff)" }}>Yes, do it</button>
            <button className="secondary" name="status" value="declined">Not now</button>
          </>
        ) : (
          <>
            <span className="pill">{m.status === "approved" ? "You said yes" : "Skipped for now"}</span>
            <button className="secondary" name="status" value="pending" style={{ padding: "3px 10px", fontSize: 12.5 }}>Change</button>
          </>
        )}
      </form>
    </article>
  );
}
