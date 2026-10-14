// Turns 90 days of transactions into "what it costs you to live", grouped the way
// people talk about money (rent, groceries, going out), not the way banks label it.
const { addMonths, round, sum } = require("./money");
// Matched in order against Plaid's detailed category, then primary.
const RULES = [
    ["RENT_AND_UTILITIES_RENT", { key: "rent", name: "Rent", kind: "fixed" }],
    ["RENT_AND_UTILITIES", { key: "utilities", name: "Phone and utilities", kind: "fixed" }],
    ["LOAN_PAYMENTS_CAR_PAYMENT", { key: "car", name: "Car payment", kind: "fixed" }],
    ["LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT", { key: "student_loan", name: "Student loan", kind: "fixed" }],
    ["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", { key: "skip", name: "", kind: "fixed" }],
    ["LOAN_PAYMENTS", { key: "other_loans", name: "Other loan payments", kind: "fixed" }],
    ["GENERAL_SERVICES_INSURANCE", { key: "insurance", name: "Insurance", kind: "fixed" }],
    ["FOOD_AND_DRINK_GROCERIES", { key: "groceries", name: "Groceries", kind: "need" }],
    ["TRANSPORTATION_GAS", { key: "gas", name: "Gas", kind: "need" }],
    ["TRANSPORTATION", { key: "transport", name: "Rides and transit", kind: "need" }],
    ["MEDICAL", { key: "medical", name: "Medical", kind: "need" }],
    ["FOOD_AND_DRINK_RESTAURANT", { key: "eating_out", name: "Eating out and delivery", kind: "want" }],
    ["FOOD_AND_DRINK_FAST_FOOD", { key: "eating_out", name: "Eating out and delivery", kind: "want" }],
    ["FOOD_AND_DRINK", { key: "going_out", name: "Coffee, bars and going out", kind: "want" }],
    ["ENTERTAINMENT_TV_AND_MOVIES", { key: "subscriptions", name: "Subscriptions", kind: "want" }],
    ["ENTERTAINMENT", { key: "fun", name: "Fun and events", kind: "want" }],
    ["TRAVEL", { key: "travel", name: "Travel", kind: "want" }],
    ["PERSONAL_CARE", { key: "personal", name: "Gym and personal care", kind: "want" }],
    ["GENERAL_MERCHANDISE", { key: "shopping", name: "Shopping and Amazon", kind: "want" }],
    ["GENERAL_SERVICES", { key: "services", name: "Services", kind: "want" }],
    ["HOME_IMPROVEMENT", { key: "home", name: "Home stuff", kind: "want" }],
];
const IGNORE_PRIMARY = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "BANK_FEES"]);
function bucketFor(t) {
    if (t.categoryPrimary && IGNORE_PRIMARY.has(t.categoryPrimary))
        return null;
    const cat = t.categoryDetailed || t.categoryPrimary || "";
    for (const [prefix, b] of RULES)
        if (cat.startsWith(prefix))
            return b.key === "skip" ? null : b;
    return { key: "other", name: "Everything else", kind: "want" };
}
/**
 * Average monthly spend per bucket over the last `months` complete calendar months
 * (fewer if the history is shorter). Whole months keep rent and bills from being
 * double counted when a window happens to catch two of them.
 */
function livingFromTransactions(txns, today, months = 3) {
    const thisMonth = today.slice(0, 7);
    const earliest = txns.reduce((m, t) => (t.date < m ? t.date : m), today).slice(0, 7);
    const window = [];
    for (let i = 1; i <= months; i++) {
        const m = addMonths(thisMonth + "-01", -i).slice(0, 7);
        // Skip the first month of history: it's usually partial.
        if (m > earliest)
            window.push(m);
    }
    if (!window.length)
        window.push(thisMonth); // brand-new account: use what we have
    const byKey = new Map();
    for (const t of txns) {
        if (t.amount <= 0 || t.pending || !window.includes(t.date.slice(0, 7)))
            continue;
        const b = bucketFor(t);
        if (!b)
            continue;
        const cur = byKey.get(b.key) ?? { b, total: 0 };
        cur.total += t.amount;
        byKey.set(b.key, cur);
    }
    const order = { fixed: 0, need: 1, want: 2 };
    return [...byKey.values()]
        .map(({ b, total }) => ({ key: b.key, name: b.name, kind: b.kind, monthly: round(total / window.length, 5) }))
        .filter(i => i.monthly >= 10)
        .sort((a, b) => order[a.kind] - order[b.kind] || b.monthly - a.monthly);
}
const monthlyOf = (items, kind) => sum(items.filter(i => !kind || i.kind === kind).map(i => i.monthly));
/** Spending since the last payday in flexible (need + want) buckets, for safe-to-spend. */
function flexibleSpentSince(txns, since) {
    return sum(txns.filter(t => t.amount > 0 && t.date >= since && bucketFor(t)?.kind !== "fixed" && bucketFor(t) !== null).map(t => t.amount));
}

module.exports = { bucketFor, livingFromTransactions, monthlyOf, flexibleSpentSince };
