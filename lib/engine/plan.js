// Builds the plan: what each base paycheck does, what each commission check does,
// and the moves Jeff asks the rep to approve. Every number here is deterministic;
// the LLM only explains it.
const { PAYCHECKS_PER_YEAR } = require("./types");
const { planningIncome } = require("./income");
const { monthlyOf } = require("./living");
const { HIGH_INTEREST_APR, highInterestDebts, simulatePayoff } = require("./debt");
const { commissionTaxGapRate, SUPPLEMENTAL_RATE } = require("./tax");
const { fmt, futureValueOfAnnual, round, sum } = require("./money");
/** 2026 IRA contribution limit under age 50. Review every January. */
const ROTH_LIMIT = 7_500;
const BUCKET_LABEL = {
    living: "Living money",
    cushion: "Cushion",
    cards: "Card payoff",
    roth: "Roth IRA",
    savings: "Savings goals",
    tax_reserve: "Tax set-aside",
    draw_reserve: "Draw set-aside",
    base_gap: "Covers this month's bills",
    yours: "Yours to spend",
};
function buildPlan(input) {
    const { comp, employer, accounts, living, today } = input;
    const income = planningIncome(comp, input.detected, today);
    const ppm = income.paychecksPerMonth;
    const fixed = monthlyOf(living, "fixed"), need = monthlyOf(living, "need"), want = monthlyOf(living, "want");
    const total = fixed + need + want;
    const surplus = round(income.netPerPaycheck - total / ppm);
    const notes = [];
    const cushionNow = sum(accounts.filter(a => a.kind === "savings").map(a => a.balance));
    const cushion = {
        current: round(cushionNow),
        starterTarget: round(Math.max(1000, fixed), 100),
        // Commission earners get three months: pay swings and SDR seats turn over fast.
        fullTarget: round(total * 3, 100),
    };
    const debts = highInterestDebts(accounts);
    const free = Math.max(0, surplus);
    const cushionPP = cushion.current >= cushion.fullTarget ? 0
        : cushion.current < cushion.starterTarget ? round(Math.max(Math.min(50, free), free * (debts.length ? 0.4 : 0.5)), 5)
            : round(free * 0.25, 5);
    const rest = Math.max(0, free - cushionPP);
    const allocations = [{ bucket: "living", perPaycheck: round(total / ppm) }];
    if (cushionPP)
        allocations.push({ bucket: "cushion", perPaycheck: cushionPP });
    if (rest)
        allocations.push({ bucket: debts.length ? "cards" : "roth", perPaycheck: rest });
    if (surplus < 0)
        notes.push(`Your base take-home is ${fmt(-surplus)} a paycheck short of what you spend. Until that changes, the first part of every commission covers the gap.`);
    if (income.inRamp)
        notes.push("You're still ramping, so Jeff plans on base pay and treats every commission as a bonus.");
    let payoff = null;
    const recs = [];
    const pct = employer?.matchPct ?? 0;
    if (pct > 0 && (input.contributingPct ?? 0) < pct) {
        const annual = (comp.baseSalary * pct) / 100;
        const cutPP = round(((annual * (1 - SUPPLEMENTAL_RATE)) / PAYCHECKS_PER_YEAR[income.frequency]), 5);
        recs.push({
            kind: "match",
            title: "Get your full 401(k) match",
            detail: `Contribute ${pct}% and ${employer.name} adds ${pct}%, about ${fmt(annual)} a year on your base alone. Your paycheck drops about ${fmt(cutPP)}.`,
            why: "A match is an instant 100% return. Nothing else in this plan beats it, including paying off cards.",
            value10y: round(futureValueOfAnnual(annual), 100),
        });
    }
    if (input.savingsHighYield === false && cushion.fullTarget > 0) {
        recs.push({
            kind: "hysa",
            title: "Move your cushion to a high-yield savings account",
            detail: "Most big-bank savings accounts pay close to 0%. High-yield accounts pay around 4% with no fees.",
            why: `On a ${fmt(cushion.fullTarget)} cushion that's roughly ${fmt(cushion.fullTarget * 0.04)} a year for doing nothing.`,
            value10y: round(cushion.fullTarget * 0.04 * 10, 100),
        });
    }
    if (cushion.current < cushion.fullTarget) {
        recs.push({
            kind: "cushion",
            title: cushion.current < cushion.starterTarget ? `Build a ${fmt(cushion.starterTarget)} starter cushion` : `Grow your cushion to ${fmt(cushion.fullTarget)}`,
            detail: `${cushionPP ? fmt(cushionPP) + " from each paycheck, plus" : "Filled from"} your commission checks. Three months of living costs is the goal: ${fmt(cushion.fullTarget)}.`,
            why: "Commission swings and a slow month shouldn't land on a credit card. The cushion is what makes a bad month boring.",
            value10y: 0,
        });
    }
    if (debts.length) {
        const extra = (rest * ppm);
        const base = simulatePayoff(debts, null);
        const plan = simulatePayoff(debts, extra);
        const saved = round(Math.max(0, base.totalInterest - plan.totalInterest), 100);
        payoff = { monthsToFree: plan.monthsToFree, interestSaved: saved };
        const first = [...debts].sort((a, b) => b.apr - a.apr)[0];
        recs.push({
            kind: "cards",
            title: "Pay off high-interest debt, highest rate first",
            detail: `${fmt(rest)} a paycheck plus most of each commission, starting with ${first.name} at ${(first.apr * 100).toFixed(1)}%.${plan.monthsToFree ? ` On base pay alone you're free in ${plan.monthsToFree} months; commissions make it faster.` : ""}`,
            why: `Paying off a card charging ${(first.apr * 100).toFixed(0)}% is a guaranteed ${(first.apr * 100).toFixed(0)}% return. This saves about ${fmt(saved)} in interest compared with paying minimums.`,
            value10y: saved,
        });
    }
    const gapRate = commissionTaxGapRate(comp);
    recs.push({
        kind: "commission_split",
        title: "Give every commission check a job",
        detail: "When a commission lands, Jeff splits it the same day: set-asides first, 10% for you, then the starter cushion, high-interest debt, the full cushion, and your goals.",
        why: "Lumpy money with no plan turns into lifestyle. A fixed split means a big month moves you forward and still feels like a win.",
        value10y: 0,
    });
    if (gapRate > 0) {
        recs.push({
            kind: "tax_reserve",
            title: `Set aside ${Math.round(gapRate * 100)}% of commissions for taxes`,
            detail: `Commissions are withheld at a flat ${SUPPLEMENTAL_RATE * 100}% federal, but at your target pay your top rate is ${Math.round((gapRate + SUPPLEMENTAL_RATE) * 100)}%.`,
            why: "Without a set-aside, the difference shows up as a bill in April.",
            value10y: 0,
        });
    }
    if (income.recoverableDrawMonthly > 0) {
        recs.push({
            kind: "draw_reserve",
            title: "Hold back part of your draw until it's earned",
            detail: `Your ${fmt(income.recoverableDrawMonthly)} monthly draw can be taken back from later commissions. Jeff keeps 30% of commissions aside until your ramp ends.`,
            why: "Spending a draw you later have to repay is the most common money trap in a first sales job.",
            value10y: 0,
        });
    }
    if (!debts.length) {
        // Base surplus only; commission checks top it up through the split.
        const rothAnnual = round(Math.min(ROTH_LIMIT, rest * ppm * 12), 100);
        if (rothAnnual > 0)
            recs.push({
                kind: "roth",
                title: "Open a Roth IRA",
                detail: `${fmt(rothAnnual)} a year from your base pay, plus part of every commission, up to the ${fmt(ROTH_LIMIT)} limit. It grows tax-free.`,
                why: "Starting in your twenties is the single biggest lever on retirement money. Every dollar has 40 years to compound.",
                value10y: round(futureValueOfAnnual(rothAnnual), 100),
            });
    }
    return {
        income,
        livingMonthly: { fixed, need, want, total },
        surplusPerPaycheck: surplus,
        allocations,
        cushion,
        debts,
        payoff,
        commissionTaxGapRate: Math.max(0, gapRate),
        recommendations: recs,
        notes,
    };
}
/**
 * Splits a commission deposit (take-home, after withholding). `cushionBalance` and `cardDebt`
 * are current balances so the split changes as goals fill. Order matters: obligations,
 * then the rep's own share, then safety, then goals.
 */
function routeCommission(plan, net, state, comp) {
    const out = [];
    let left = net;
    const take = (bucket, amt) => {
        const a = round(Math.max(0, Math.min(left, amt)));
        if (a > 0) {
            out.push({ bucket, amount: a });
            left -= a;
        }
    };
    const withheld = SUPPLEMENTAL_RATE + 0.0765 + comp.stateTaxRate;
    const gross = net / (1 - withheld);
    if (plan.commissionTaxGapRate > 0)
        take("tax_reserve", gross * plan.commissionTaxGapRate);
    if (plan.surplusPerPaycheck < 0) {
        const months = comp.commissionCadence === "quarterly" ? 3 : 1;
        take("base_gap", -plan.surplusPerPaycheck * plan.income.paychecksPerMonth * months);
    }
    if (plan.income.recoverableDrawMonthly > 0)
        take("draw_reserve", net * 0.3);
    take("yours", left * 0.1);
    // Starter cushion first so a surprise doesn't land back on a card, then the cards,
    // then the full three-month cushion, then long-term goals.
    let cushion = state.cushionBalance;
    const fill = (target) => { const before = left; take("cushion", target - cushion); cushion += before - left; };
    fill(plan.cushion.starterTarget);
    if (state.cardDebt > 0)
        take("cards", state.cardDebt);
    fill(plan.cushion.fullTarget);
    if (left > 0) {
        const roth = round(left / 2);
        take("roth", roth);
        take("savings", left);
    }
    return out;
}

module.exports = { BUCKET_LABEL, buildPlan, routeCommission };
