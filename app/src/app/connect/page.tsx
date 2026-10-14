import { guardStep } from "@/lib/data";
import { finishConnect } from "@/app/actions";
import { fmt } from "@/lib/engine";
import { Steps } from "@/components/Steps";
import { PlaidConnect } from "@/components/PlaidConnect";
import { RefreshBanks } from "@/components/RefreshBanks";

const KIND_LABEL: Record<string, string> = { checking: "Checking", savings: "Savings", credit: "Credit card", loan: "Loan", investment: "Investments", other: "Other" };

export default async function Connect() {
  const { supabase, user } = await guardStep("connect", "income", "living", "plan", "done");
  const [{ data: accounts }, { count }] = await Promise.all([
    supabase.from("accounts").select("id, name, mask, institution, kind, balance").eq("user_id", user.id).order("institution"),
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", user.id),
  ]);
  const has = (accounts ?? []).length > 0;

  return (
    <>
      <div className="pad">
        <Steps at="connect" />
        <h1 className="title">Connect your accounts</h1>
        <p className="sub">Add the account your paycheck lands in, plus any cards and loans. The more Jeff sees, the better the plan. Read-only: Jeff can&apos;t move money.</p>
        <PlaidConnect label={has ? "Add another account" : "Connect a bank or card"} />
        {has && (
          <>
            <ul className="list" style={{ marginTop: 18 }}>
              {accounts!.map(a => (
                <li key={a.id}>
                  <div className="nm"><b>{a.name}{a.mask ? ` ··${a.mask}` : ""}</b><small>{a.institution} · {KIND_LABEL[a.kind]}</small></div>
                  <span className="amt num">{a.kind === "credit" || a.kind === "loan" ? "owe " : ""}{fmt(Number(a.balance))}</span>
                </li>
              ))}
            </ul>
            <p className="small" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{count ? `${count} transactions pulled` : "Waiting on transaction history from your bank…"}</span>
              <RefreshBanks />
            </p>
          </>
        )}
      </div>
      <form action={finishConnect} className="footer"><button className="primary" disabled={!has}>Continue</button></form>
    </>
  );
}
