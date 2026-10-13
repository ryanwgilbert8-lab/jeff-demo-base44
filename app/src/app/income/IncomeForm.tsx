"use client";
import { useActionState, useState } from "react";
import { saveIncome, type FormState } from "@/app/actions";

type Defaults = Record<string, string | number | boolean>;

export function IncomeForm({ defaults: d, matchPct, employer }: { defaults: Defaults; matchPct: number; employer: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveIncome, undefined);
  const [ramp, setRamp] = useState(Number(d.ramp_months) > 0);
  return (
    <form action={action}>
      <div className="row2">
        <label className="field"><span>Base salary (yearly)</span><input name="base_salary" inputMode="numeric" defaultValue={String(d.base_salary)} placeholder="60000" required /></label>
        <label className="field"><span>On-target earnings (OTE)</span><input name="ote" inputMode="numeric" defaultValue={String(d.ote)} placeholder="90000" required /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Paychecks come</span>
          <select name="pay_frequency" defaultValue={String(d.pay_frequency)}>
            <option value="weekly">Weekly</option><option value="biweekly">Every 2 weeks</option>
            <option value="semimonthly">Twice a month</option><option value="monthly">Monthly</option>
          </select>
        </label>
        <label className="field"><span>Commission is paid</span>
          <select name="commission_cadence" defaultValue={String(d.commission_cadence)}>
            <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Start date</span><input name="start_date" type="date" defaultValue={String(d.start_date)} required /></label>

      <label className="check"><input type="checkbox" checked={ramp} onChange={e => setRamp(e.target.checked)} /> I&apos;m on a ramp (reduced quota while I start)</label>
      {ramp ? (
        <>
          <div className="row2">
            <label className="field"><span>Ramp length (months)</span><input name="ramp_months" inputMode="numeric" defaultValue={String(d.ramp_months || 3)} /></label>
            <label className="field"><span>Monthly draw, if any</span><input name="ramp_draw_monthly" inputMode="numeric" defaultValue={String(d.ramp_draw_monthly)} /></label>
          </div>
          <label className="check"><input type="checkbox" name="draw_recoverable" defaultChecked={!!d.draw_recoverable} /> My draw is recoverable (paid back from later commission)</label>
        </>
      ) : (
        <><input type="hidden" name="ramp_months" value="0" /><input type="hidden" name="ramp_draw_monthly" value="0" /></>
      )}

      <div className="row2">
        <label className="field"><span>State income tax (%)</span><input name="state_tax_pct" inputMode="decimal" defaultValue={String(d.state_tax_pct)} /></label>
        <label className="field"><span>Your 401(k) contribution (%)</span><input name="contributing_pct" inputMode="decimal" defaultValue={String(d.contributing_pct)} placeholder="Not sure" /></label>
      </div>
      {matchPct > 0 && <p className="small" style={{ marginTop: -6 }}>{employer} matches up to {matchPct}%. Leave blank if you&apos;re not sure what you put in.</p>}

      {state?.error && <p className="err">{state.error}</p>}
      <div className="footer" style={{ padding: "12px 0 0" }}><button className="primary" disabled={pending}>Continue</button></div>
    </form>
  );
}
