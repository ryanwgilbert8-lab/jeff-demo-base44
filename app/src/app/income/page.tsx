import { loadFinances, guardStep } from "@/lib/data";
import { detectIncome, fmt } from "@/lib/engine";
import { Steps } from "@/components/Steps";
import { IncomeForm } from "./IncomeForm";

const FREQ: Record<string, string> = { weekly: "every week", biweekly: "every two weeks", semimonthly: "twice a month", monthly: "once a month" };

export default async function Income() {
  await guardStep("income", "living", "plan", "done");
  const f = await loadFinances();
  const detected = detectIncome(f.transactions);
  const commissions = detected?.deposits.filter(d => d.commission > 0) ?? [];
  const c = f.comp;

  return (
    <div className="pad">
      <Steps at="income" />
      <h1 className="title">How you get paid</h1>
      {detected ? (
        <p className="hint">
          We see about <b>{fmt(detected.netBasePerPaycheck)}</b> landing {FREQ[detected.frequency]} from {detected.payer}
          {commissions.length ? `, plus ${commissions.length} commission deposit${commissions.length > 1 ? "s" : ""} on top` : ""}. Jeff plans on that base and never counts commission before it lands.
        </p>
      ) : (
        <p className="hint">We couldn&apos;t spot your paychecks yet. Fill this in and Jeff will estimate your take-home until they show up.</p>
      )}
      <IncomeForm
        defaults={{
          pay_frequency: c?.payFrequency ?? detected?.frequency ?? "biweekly",
          base_salary: c?.baseSalary ?? "",
          ote: c?.ote ?? "",
          commission_cadence: c?.commissionCadence ?? "monthly",
          start_date: c?.startDate ?? "",
          ramp_months: c?.rampMonths ?? 3,
          ramp_draw_monthly: c?.rampDrawMonthly ?? 0,
          draw_recoverable: c?.drawRecoverable ?? false,
          state_tax_pct: c ? Math.round(c.stateTaxRate * 1000) / 10 : 5,
          contributing_pct: f.profile.contributing_pct ?? "",
        }}
        matchPct={f.employer?.matchPct ?? 0}
        employer={f.employer?.name ?? "your company"}
      />
    </div>
  );
}
