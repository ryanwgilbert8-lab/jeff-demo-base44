// Commission-aware income. Sales pay = steady base + lumpy commission. Jeff plans the
// month on what's guaranteed and gives every commission dollar a job when it lands.
import type { CompPlan, PayFrequency, Transaction } from "./types";
import { PAYCHECKS_PER_YEAR } from "./types";
import { addDays, addMonths, daysBetween, median, round } from "./money";
import { estimatedNet } from "./tax";

const PAYROLL_NAME = /payroll|direct dep|dir dep|salary|paychex|adp|gusto|rippling|workday|justworks|trinet|ppd/i;

export interface Deposit {
  date: string;
  amount: number;
  base: number; // portion that is regular base pay
  commission: number; // portion above base, or the whole deposit if it landed off-cycle
}

export interface DetectedIncome {
  payer: string;
  frequency: PayFrequency;
  netBasePerPaycheck: number;
  deposits: Deposit[];
  lastPayDate: string;
  nextPayDate: string;
}

const normalizePayer = (t: Transaction) =>
  (t.merchant || t.name).toLowerCase().replace(/[^a-z ]/g, " ").replace(/\b(payroll|direct|dep|ppd|id|co|inc|llc)\b/g, "").replace(/\s+/g, " ").trim();

export function inferFrequency(medianGapDays: number): PayFrequency {
  if (medianGapDays < 10) return "weekly";
  if (medianGapDays < 14.6) return "biweekly";
  if (medianGapDays < 20) return "semimonthly";
  return "monthly";
}

const PERIOD_DAYS: Record<PayFrequency, number> = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 };

/** Finds the employer's payroll deposits and splits each into base and commission. */
export function detectIncome(txns: Transaction[]): DetectedIncome | null {
  const credits = txns.filter(t => t.amount < 0 && !t.pending && (t.categoryPrimary === "INCOME" || PAYROLL_NAME.test(t.name)));
  if (!credits.length) return null;

  const groups = new Map<string, Transaction[]>();
  for (const t of credits) {
    const k = normalizePayer(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const payroll = [...groups.values()].sort((a, b) => b.length - a.length)[0].sort((a, b) => a.date.localeCompare(b.date));
  if (payroll.length < 2) return null;

  // The base paycheck is the typical deposit; lumpy ones above it carry commission.
  const amounts = payroll.map(t => -t.amount);
  const lowerHalf = amounts.filter(a => a <= median(amounts));
  const base = median(lowerHalf);

  // Cadence from deposits that look like regular paychecks (within 15% of base).
  const regular = payroll.filter(t => Math.abs(-t.amount - base) <= base * 0.15);
  const gaps = regular.slice(1).map((t, i) => daysBetween(regular[i].date, t.date));
  const frequency = inferFrequency(gaps.length ? median(gaps) : 14);
  const period = PERIOD_DAYS[frequency];

  let lastRegular: string | null = null;
  const deposits: Deposit[] = payroll.map(t => {
    const amount = -t.amount;
    const offCycle = lastRegular !== null && daysBetween(lastRegular, t.date) < period * 0.5;
    if (offCycle) return { date: t.date, amount, base: 0, commission: amount };
    lastRegular = t.date;
    const commission = amount > base * 1.15 ? amount - base : 0;
    return { date: t.date, amount, base: amount - commission, commission };
  });

  const lastPayDate = lastRegular ?? payroll[payroll.length - 1].date;
  const nextPayDate = frequency === "monthly" ? addMonths(lastPayDate, 1) : addDays(lastPayDate, period);
  return { payer: payroll[0].merchant || payroll[0].name, frequency, netBasePerPaycheck: round(base), deposits, lastPayDate, nextPayDate };
}

export function inRamp(comp: CompPlan, today: string): boolean {
  return comp.rampMonths > 0 && today < addMonths(comp.startDate, comp.rampMonths);
}

export interface PlanningIncome {
  frequency: PayFrequency;
  paychecksPerMonth: number;
  /** Take-home Jeff builds the plan on. Only money the rep is guaranteed. */
  netPerPaycheck: number;
  netMonthly: number;
  /** Expected commission at target, gross per month. Never counted on in the plan. */
  targetCommissionMonthlyGross: number;
  inRamp: boolean;
  /** Draw that may be clawed back later; Jeff holds part of it in reserve. */
  recoverableDrawMonthly: number;
  source: "deposits" | "estimate";
}

export function planningIncome(comp: CompPlan, detected: DetectedIncome | null, today: string): PlanningIncome {
  const frequency = detected?.frequency ?? comp.payFrequency;
  const perYear = PAYCHECKS_PER_YEAR[frequency];
  const ramp = inRamp(comp, today);

  // A non-recoverable draw is guaranteed pay while ramping; a recoverable one is an advance.
  const guaranteedDraw = ramp && !comp.drawRecoverable ? comp.rampDrawMonthly * 12 : 0;
  const estimatedBaseNet = estimatedNet(comp.baseSalary, comp.stateTaxRate) / perYear;
  const netBase = detected?.netBasePerPaycheck ?? estimatedBaseNet;
  const drawNet = guaranteedDraw ? (estimatedNet(comp.baseSalary + guaranteedDraw, comp.stateTaxRate) - estimatedNet(comp.baseSalary, comp.stateTaxRate)) / perYear : 0;

  const netPerPaycheck = round(netBase + drawNet);
  return {
    frequency,
    paychecksPerMonth: perYear / 12,
    netPerPaycheck,
    netMonthly: round((netPerPaycheck * perYear) / 12),
    targetCommissionMonthlyGross: round(Math.max(0, comp.ote - comp.baseSalary) / 12),
    inRamp: ramp,
    recoverableDrawMonthly: ramp && comp.drawRecoverable ? comp.rampDrawMonthly : 0,
    source: detected ? "deposits" : "estimate",
  };
}
