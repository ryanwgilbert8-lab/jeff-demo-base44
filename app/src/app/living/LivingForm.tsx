"use client";
import { useActionState, useState } from "react";
import { saveLiving, type FormState } from "@/app/actions";
import { fmt } from "@/lib/engine/money";

type Item = { key: string; name: string; monthly: number; kind: string };
const GROUPS = [["fixed", "Bills"], ["need", "Needs"], ["want", "Wants"]] as const;

export function LivingForm({ items, savingsHighYield }: { items: Item[]; savingsHighYield: boolean | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveLiving, undefined);
  const [amts, setAmts] = useState(() => Object.fromEntries(items.map(i => [i.key, i.monthly])));
  const [kinds, setKinds] = useState(() => Object.fromEntries(items.map(i => [i.key, i.kind])));
  return (
    <form action={action}>
      {GROUPS.map(([kind, label]) => {
        const rows = items.filter(i => kinds[i.key] === kind);
        if (!rows.length) return null;
        return (
          <div key={kind}>
            <p className="group"><span>{label}</span><span className="num">{fmt(rows.reduce((s, i) => s + (Number(amts[i.key]) || 0), 0))}/mo</span></p>
            <ul className="list">
              {rows.map(i => (
                <li key={i.key}>
                  <div className="nm">
                    <b>{i.name}</b>
                    <select name={`kind_${i.key}`} value={kinds[i.key]} onChange={e => setKinds({ ...kinds, [i.key]: e.target.value })} className="small" style={{ border: 0, background: "transparent", padding: 0 }}>
                      <option value="fixed">Bill</option><option value="need">Need</option><option value="want">Want</option>
                    </select>
                  </div>
                  <input className="amt num" name={`amt_${i.key}`} inputMode="numeric" value={amts[i.key]} onChange={e => setAmts({ ...amts, [i.key]: e.target.value as unknown as number })} aria-label={`${i.name} per month`} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <label className="field" style={{ marginTop: 20 }}><span>Does your savings account earn 3% or more?</span>
        <select name="savings_high_yield" defaultValue={savingsHighYield === null ? "unsure" : savingsHighYield ? "yes" : "no"}>
          <option value="unsure">Not sure</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </label>
      {state?.error && <p className="err">{state.error}</p>}
      <div className="footer" style={{ padding: "12px 0 0" }}><button className="primary" disabled={pending}>{pending ? "Building your plan…" : "Build my plan"}</button></div>
    </form>
  );
}
