// Highest-rate-first ("avalanche") payoff for card and loan debt.
import type { Account } from "./types";

export interface Debt { id: string; name: string; balance: number; apr: number; minPayment: number | null }

/** APR to assume when the bank doesn't report one (Plaid liabilities is optional). */
export const DEFAULT_CARD_APR = 0.24;
/** Debt at or above this rate gets paid down before investing beyond the match. */
export const HIGH_INTEREST_APR = 0.08;

export const minPaymentFor = (d: Debt, balance: number) =>
  balance <= 0 ? 0 : Math.min(balance, d.minPayment ?? Math.max(25, balance * 0.03));

export function highInterestDebts(accounts: Account[]): Debt[] {
  return accounts
    .filter(a => (a.kind === "credit" || a.kind === "loan") && a.balance > 0)
    .map(a => ({ id: a.id, name: a.name, balance: a.balance, apr: a.apr ?? (a.kind === "credit" ? DEFAULT_CARD_APR : 0), minPayment: a.minPayment ?? null }))
    .filter(d => d.apr >= HIGH_INTEREST_APR);
}

export interface PayoffResult {
  monthsToFree: number | null; // null if not paid off within the horizon
  totalInterest: number;
  payoffMonth: Record<string, number>;
}

/**
 * Simulates month by month. With `extraMonthly` set, the total payment stays fixed:
 * when one debt is gone its minimum rolls into the next. With null, pays shrinking minimums only.
 */
export function simulatePayoff(debts: Debt[], extraMonthly: number | null, horizon = 360): PayoffResult {
  const bal = new Map(debts.map(d => [d.id, d.balance]));
  const budget = extraMonthly === null ? null : debts.reduce((s, d) => s + minPaymentFor(d, d.balance), 0) + extraMonthly;
  const byRate = [...debts].sort((a, b) => b.apr - a.apr);
  const payoffMonth: Record<string, number> = {};
  let totalInterest = 0;

  for (let m = 1; m <= horizon; m++) {
    for (const d of debts) {
      const i = (bal.get(d.id)! * d.apr) / 12;
      bal.set(d.id, bal.get(d.id)! + i);
      totalInterest += i;
    }
    let left = budget ?? Infinity;
    for (const d of debts) {
      const p = Math.min(minPaymentFor(d, bal.get(d.id)!), left);
      bal.set(d.id, bal.get(d.id)! - p);
      left -= p;
    }
    if (budget !== null) {
      for (const d of byRate) {
        if (left <= 0) break;
        const p = Math.min(bal.get(d.id)!, left);
        bal.set(d.id, bal.get(d.id)! - p);
        left -= p;
      }
    }
    for (const d of debts) if (payoffMonth[d.id] === undefined && bal.get(d.id)! <= 0.5) payoffMonth[d.id] = m;
    if (debts.every(d => payoffMonth[d.id] !== undefined)) return { monthsToFree: m, totalInterest, payoffMonth };
  }
  return { monthsToFree: null, totalInterest, payoffMonth };
}
