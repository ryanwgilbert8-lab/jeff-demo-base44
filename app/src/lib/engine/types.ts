// Shared types for the money engine. The engine is pure: no I/O, no clock reads
// (callers pass `today`), so every number Jeff says can be reproduced in a test.

export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

export const PAYCHECKS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/** How a rep is paid. Entered at onboarding, later filled from payroll (Finch). */
export interface CompPlan {
  payFrequency: PayFrequency;
  baseSalary: number; // annual gross base
  ote: number; // on-target earnings, annual gross (base + target commission)
  commissionCadence: "monthly" | "quarterly";
  startDate: string; // ISO date the rep started
  rampMonths: number; // 0 if no ramp
  rampDrawMonthly: number; // gross monthly draw paid during ramp, 0 if none
  drawRecoverable: boolean; // true if unearned draw is clawed back from later commissions
  stateTaxRate: number; // flat approximation of state income tax, e.g. 0.05
}

export type AccountKind = "checking" | "savings" | "credit" | "loan" | "investment" | "other";

export interface Account {
  id: string;
  name: string;
  institution?: string;
  kind: AccountKind;
  /** Cash held for checking/savings/investment, amount owed for credit/loan. Always >= 0. */
  balance: number;
  apr?: number | null; // e.g. 0.279
  minPayment?: number | null; // monthly
}

/** Plaid-shaped transaction. `amount` > 0 is money leaving the account. */
export interface Transaction {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  name: string;
  merchant?: string | null;
  amount: number;
  categoryPrimary?: string | null; // Plaid personal_finance_category.primary
  categoryDetailed?: string | null; // Plaid personal_finance_category.detailed
  pending?: boolean;
}

export type LivingKind = "fixed" | "need" | "want";

export interface LivingItem {
  key: string; // stable id, e.g. "rent"
  name: string;
  monthly: number;
  kind: LivingKind;
}

export interface Employer {
  name: string;
  matchPct: number; // employer matches up to this % of pay, e.g. 4
  k401Provider?: string | null;
}
