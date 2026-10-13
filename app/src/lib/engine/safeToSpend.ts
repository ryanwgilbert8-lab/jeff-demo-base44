// "Safe to spend until your next paycheck": the one number on the home screen.
import type { Plan } from "./plan";
import { round } from "./money";

export interface SafeToSpendInput {
  plan: Plan;
  checkingBalance: number;
  flexibleSpentSincePayday: number;
  /** Keep this much in checking no matter what, so nothing bounces. */
  floor?: number;
}

export function safeToSpend({ plan, checkingBalance, flexibleSpentSincePayday, floor = 100 }: SafeToSpendInput): number {
  const ppm = plan.income.paychecksPerMonth;
  const flexBudget = (plan.livingMonthly.need + plan.livingMonthly.want) / ppm;
  const fixedReserved = plan.livingMonthly.fixed / ppm;
  const byBudget = flexBudget - flexibleSpentSincePayday;
  const byBalance = checkingBalance - fixedReserved - floor;
  return round(Math.max(0, Math.min(byBudget, byBalance)));
}
