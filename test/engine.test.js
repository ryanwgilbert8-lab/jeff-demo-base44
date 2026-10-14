const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Small expect() so the checks read the same as before, on Node's built-in test runner.
function expect(actual) {
  const close = (exp, digits = 2) => Math.abs(exp - actual) < Math.pow(10, -digits) / 2;
  const api = {
    toBe: exp => assert.equal(actual, exp),
    toEqual: exp => assert.deepEqual(actual, exp),
    toBeCloseTo: (exp, digits) => assert.ok(close(exp, digits), `${actual} is not close to ${exp}`),
    toBeGreaterThan: exp => assert.ok(actual > exp, `${actual} is not > ${exp}`),
    toBeLessThan: exp => assert.ok(actual < exp, `${actual} is not < ${exp}`),
    toContain: exp => assert.ok(actual.includes(exp), `${JSON.stringify(actual)} does not contain ${exp}`),
    toMatchObject: exp => { for (const [k, v] of Object.entries(exp)) assert.deepEqual(actual[k], v, k); },
  };
  api.not = { toContain: exp => assert.ok(!actual.includes(exp), `${JSON.stringify(actual)} contains ${exp}`) };
  return api;
}
const {
  buildPlan, commissionTaxGapRate, detectIncome, federalTax, inferFrequency, livingFromTransactions,
  marginalFederalRate, routeCommission, safeToSpend, simulatePayoff, sum,
} = require("../lib/engine");
const { accounts, comp, transactions } = require("./fixtures");

const today = "2026-10-13";

describe("tax", () => {
  it("applies brackets above the standard deduction", () => {
    expect(federalTax(16_100)).toBe(0);
    expect(federalTax(26_100)).toBeCloseTo(1_000); // 10k taxable at 10%
  });
  it("finds the commission withholding gap at target pay", () => {
    expect(marginalFederalRate(90_000)).toBe(0.22);
    expect(commissionTaxGapRate({ ote: 90_000 })).toBe(0);
    expect(commissionTaxGapRate({ ote: 150_000 })).toBeCloseTo(0.02);
  });
});

describe("detectIncome", () => {
  const d = detectIncome(transactions(today));
  it("finds biweekly base pay and the next payday", () => {
    expect(d.frequency).toBe("biweekly");
    expect(d.netBasePerPaycheck).toBe(1_780);
    expect(d.lastPayDate).toBe("2026-10-09");
    expect(d.nextPayDate).toBe("2026-10-23");
  });
  it("splits commission out of on-cycle and off-cycle deposits", () => {
    expect(d.deposits.find(x => x.date === "2026-09-25")).toMatchObject({ base: 1_780, commission: 2_400 });
    expect(d.deposits.find(x => x.date === "2026-08-15")).toMatchObject({ base: 0, commission: 900 });
  });
  it("infers cadence from gaps", () => {
    expect(inferFrequency(7)).toBe("weekly");
    expect(inferFrequency(15.2)).toBe("semimonthly");
    expect(inferFrequency(30)).toBe("monthly");
  });
});

describe("livingFromTransactions", () => {
  const items = livingFromTransactions(transactions(today), today);
  const by = k => items.find(i => i.key === k);
  it("groups spending the way people talk about it", () => {
    expect(by("rent")).toMatchObject({ kind: "fixed" });
    expect(by("eating_out")?.kind).toBe("want");
    expect(by("groceries")?.monthly).toBeGreaterThan(250);
  });
  it("ignores income, transfers and card payments", () => {
    expect(items.some(i => /payment|transfer/i.test(i.name) && i.key !== "student_loan")).toBe(false);
  });
});

describe("simulatePayoff", () => {
  const debts = [{ id: "a", name: "A", balance: 1_000, apr: 0.3, minPayment: null }, { id: "b", name: "B", balance: 2_000, apr: 0.2, minPayment: null }];
  it("pays the highest rate first and beats minimums", () => {
    const base = simulatePayoff(debts, null);
    const plan = simulatePayoff(debts, 300);
    expect(plan.payoffMonth.a).toBeLessThan(plan.payoffMonth.b);
    expect(plan.totalInterest).toBeLessThan(base.totalInterest);
    expect(plan.monthsToFree).toBeLessThan(15);
  });
});

describe("buildPlan", () => {
  const txns = transactions(today);
  const plan = buildPlan({
    today, comp, accounts,
    employer: { name: "Acme", matchPct: 4 },
    contributingPct: 0,
    living: livingFromTransactions(txns, today),
    detected: detectIncome(txns),
    savingsHighYield: false,
  });

  it("plans on base pay only", () => {
    expect(plan.income.netPerPaycheck).toBe(1_780);
    expect(plan.income.inRamp).toBe(false);
  });
  it("allocates exactly the base paycheck when there's a surplus", () => {
    if (plan.surplusPerPaycheck >= 0) expect(sum(plan.allocations.map(a => a.perPaycheck))).toBeCloseTo(plan.income.netPerPaycheck, -1);
  });
  it("leads with the match, then cushion and cards", () => {
    const kinds = plan.recommendations.map(r => r.kind);
    expect(kinds[0]).toBe("match");
    expect(kinds).toContain("cards");
    expect(kinds).toContain("commission_split");
    expect(kinds).not.toContain("roth"); // cards first
    expect(plan.debts.map(d => d.id)).toEqual(["c1", "c2"]); // student loan at 5.5% is not high-interest
  });

  it("routes a commission: your share, starter cushion, then cards", () => {
    const split = routeCommission(plan, 4_000, { cushionBalance: 400, cardDebt: 4_300 }, comp);
    expect(sum(split.map(s => s.amount))).toBeCloseTo(4_000, 0);
    expect(split.map(s => s.bucket)).toEqual(["yours", "cushion", "cards"]);
    expect(split[0].amount).toBe(400);
    expect(split[1].amount).toBe(plan.cushion.starterTarget - 400);
  });

  it("sends commissions to long-term goals once debt and cushion are done", () => {
    const split = routeCommission(plan, 2_000, { cushionBalance: plan.cushion.fullTarget, cardDebt: 0 }, comp);
    expect(split.map(s => s.bucket)).toEqual(["yours", "roth", "savings"]);
  });

  it("averages whole months so rent isn't double counted", () => {
    const items = livingFromTransactions(txns, today);
    expect(items.find(i => i.key === "rent")?.monthly).toBe(1_450);
  });

  it("holds back part of a recoverable draw while ramping", () => {
    const ramping = { ...comp, startDate: "2026-09-01", rampDrawMonthly: 1_500, drawRecoverable: true };
    const p = buildPlan({ today, comp: ramping, employer: null, contributingPct: null, accounts, living: [], detected: null, savingsHighYield: null });
    expect(p.income.inRamp).toBe(true);
    expect(p.recommendations.some(r => r.kind === "draw_reserve")).toBe(true);
    expect(routeCommission(p, 1_000, { cushionBalance: 0, cardDebt: 0 }, ramping)[0]).toEqual({ bucket: "draw_reserve", amount: 300 });
  });

  it("never reports a negative safe-to-spend", () => {
    expect(safeToSpend({ plan, checkingBalance: 50, flexibleSpentSincePayday: 0 })).toBe(0);
    expect(safeToSpend({ plan, checkingBalance: 5_000, flexibleSpentSincePayday: 0 })).toBeGreaterThan(0);
  });
});
