// Builds a real person's Jeff experience from their real data, in the same shape the demo's
// sample people use (accounts, lead, paycheck, living costs, questions, plan moves), so every
// screen works the same for real users. Numbers come from the money engine, never from the AI.
const pool = require("./db");
const E = require("./engine");
const { fmt, round, sum } = E;

const r10 = n => Math.round(n / 10) * 10;
const today = () => E.toISO(new Date());

/* ---------- loading ---------- */
async function loadData(userId) {
  const [{ rows: accounts }, { rows: txRows }, { rows: [state] }] = await Promise.all([
    pool.query("SELECT id, name, mask, institution, kind, subtype, balance::float, apr::float, min_payment::float AS min_payment FROM accounts WHERE user_id = $1", [userId]),
    pool.query(`SELECT id, account_id, to_char(date, 'YYYY-MM-DD') AS date, name, merchant_name, amount::float, category_primary, category_detailed, pending
                  FROM transactions WHERE user_id = $1 AND date >= current_date - 200 ORDER BY date`, [userId]),
    pool.query("SELECT data, updated_at FROM live_state WHERE user_id = $1", [userId]),
  ]);
  const txns = txRows.map(t => ({ id: String(t.id), accountId: String(t.account_id), date: t.date, name: t.name, merchant: t.merchant_name,
    amount: t.amount, categoryPrimary: t.category_primary, categoryDetailed: t.category_detailed, pending: t.pending }));
  return { accounts, txns, state: state ? state.data : null, stateUpdatedAt: state ? state.updated_at : null };
}

/* ---------- names ---------- */
function cleanPayer(name) {
  const s = String(name || "").replace(/\b(payroll|direct dep(osit)?|dir dep|ppd|ach|deposit|salary|id:?\s*\S+|co\b|inc\b|llc\b)/gi, " ").replace(/[^A-Za-z0-9&' ]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : "Your employer";
}
const FREQ_WORDS = { weekly: "every week", biweekly: "every other week", semimonthly: "twice a month", monthly: "once a month" };

/* ---------- accounts, in the demo's shape ---------- */
function shapeAccounts(accounts, txns) {
  // The checking account paychecks land in becomes "chk"; the biggest savings becomes "sav".
  const incomeCount = new Map();
  for (const t of txns) if (t.amount < 0 && (t.categoryPrimary === "INCOME")) incomeCount.set(t.accountId, (incomeCount.get(t.accountId) || 0) + 1);
  const checking = accounts.filter(a => a.kind === "checking").sort((a, b) => (incomeCount.get(String(b.id)) || 0) - (incomeCount.get(String(a.id)) || 0) || b.balance - a.balance);
  const savings = accounts.filter(a => a.kind === "savings").sort((a, b) => b.balance - a.balance);
  const type = { checking: "cash", savings: "cash", credit: "credit", loan: "loan", investment: "invest" };
  return accounts.filter(a => type[a.kind]).map(a => ({
    id: a === checking[0] ? "chk" : a === savings[0] ? "sav" : (a.kind === "credit" ? "card" : "a") + a.id,
    dbId: a.id,
    inst: a.institution || "Your bank",
    name: a.name + (a.mask ? ` ··${a.mask}` : ""),
    type: type[a.kind],
    kind: a.kind,
    bal: a.kind === "credit" || a.kind === "loan" ? -a.balance : a.balance,
    apr: a.apr,
    rate: a.apr ? `${(a.apr * 100).toFixed(a.apr * 100 % 1 ? 1 : 0)}% APR` : "",
  }));
}

function engineAccounts(accounts) {
  return accounts.map(a => ({ id: String(a.id), name: a.name, institution: a.institution, kind: a.kind, balance: a.balance, apr: a.apr, minPayment: a.min_payment }));
}

function leadFor(shaped, debts) {
  const cash = sum(shaped.filter(a => a.type === "cash").map(a => a.bal));
  const owed = -sum(shaped.filter(a => a.type === "credit" || a.type === "loan").map(a => a.bal));
  const nDebts = shaped.filter(a => (a.type === "credit" || a.type === "loan") && a.bal < -0.5).length;
  const cardInterest = sum(debts.map(d => (d.balance * d.apr) / 12));
  if (!nDebts) return `You've got <em>${fmt(cash)}</em> in cash and no debt. ${cash > 3000 ? "A clean slate. Now let's make that money work." : "A clean slate to build on."}`;
  return `You've got <em>${fmt(cash)}</em> in cash and owe <em>${fmt(owed)}</em> across ${nDebts} ${nDebts === 1 ? "debt" : "debts"}.` +
    (cardInterest >= 5 ? ` Your high-interest debt costs about <em>${fmt(cardInterest)} a month</em> in interest.` : "");
}

/* ---------- cost of living, with suggested trims ---------- */
const TRIM = {
  eating_out: { cut: 0.55, say: (a, t) => `Let's start with eating out and delivery. It's ${fmt(a)} a month. I'd bring it to ${fmt(t)}. That's still a couple of nights a week.`, why: "It's usually the biggest flexible number, and the easiest to pull back without feeling it much." },
  going_out: { cut: 0.75, say: (a, t) => `Coffee, bars and going out run ${fmt(a)}. That's your social life, so I'm not touching most of it. I'd suggest ${fmt(t)}.`, why: "I'm not trying to make you stay home. A small trim here adds up over a year." },
  shopping: { cut: 0.65, say: (a, t) => `Shopping and Amazon come to about ${fmt(a)} a month. I'd like to cap it at ${fmt(t)} for now. Once the plan's rolling, we loosen it.`, why: "Small purchases are where budgets quietly leak. A cap makes it a choice instead of a habit." },
  subscriptions: { cut: 0.7, say: (a, t) => `Subscriptions are ${fmt(a)} a month. Cutting the ones you don't use gets you to about ${fmt(t)}.`, why: "These are the easiest wins there are. You won't feel them." },
  fun: { cut: 0.75, say: (a, t) => `Fun and events are ${fmt(a)}. I'd suggest ${fmt(t)}, and I'll make room when something big comes up.`, why: "Tell me what's coming and I'll save for it, so it doesn't land on a card." },
  travel: { cut: 0.6, say: (a, t) => `Travel has been about ${fmt(a)} a month lately. I'd plan on ${fmt(t)} and save ahead for trips instead.`, why: "Trips paid for ahead of time don't follow you home on a card." },
  personal: { cut: 0.8, say: (a, t) => `Gym and personal care run ${fmt(a)}. A small trim to ${fmt(t)}?`, why: "Usually there's one membership or habit here you won't miss." },
  other: { cut: 0.7, say: (a, t) => `About ${fmt(a)} a month goes to everything else, small stuff that adds up. I'd cap it at ${fmt(t)}.`, why: "A cap makes small purchases a choice instead of a habit." },
};

function livingFor(txns, accounts, debts) {
  const items = E.livingFromTransactions(txns, today());
  const creditIds = new Set(accounts.filter(a => a.kind === "credit").map(a => String(a.id)));
  const onCard = new Map();
  for (const t of txns) {
    if (t.amount <= 0) continue;
    const b = E.bucketFor(t); if (!b) continue;
    const cur = onCard.get(b.key) || [0, 0];
    cur[creditIds.has(t.accountId) ? 0 : 1] += t.amount;
    onCard.set(b.key, cur);
  }
  const trimmable = items.filter(i => i.kind === "want" && TRIM[i.key] && i.monthly >= 80).sort((a, b) => b.monthly - a.monthly).slice(0, 4).map(i => i.key);
  const cardDebt = debts.length > 0;
  return items.map(i => {
    const [card, cash] = onCard.get(i.key) || [0, 0];
    const out = { key: i.key, name: i.name, amt: i.monthly, type: i.kind, card: card > cash };
    if (trimmable.includes(i.key)) {
      const T = TRIM[i.key], to = Math.max(10, r10(i.monthly * T.cut));
      out.trim = { to, say: T.say(i.monthly, to), why: T.why, harm: cardDebt && out.card };
    }
    return out;
  });
}

/* ---------- questions ---------- */
function questionsFor(detected, employer, shaped) {
  const q = [];
  const big = (detected?.deposits || []).filter(d => d.commission > 0).slice(-1)[0];
  if (big) q.push({ id: "commission", q: `Some paydays run bigger, like ${new Date(big.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })} at ${fmt(big.amount)}. Is that commission or a bonus?`, opts: ["Yes, commission", "A bonus", "Something else"] });
  if (!employer || employer.matchPct === null || employer.matchPct === undefined) {
    q.push({ id: "match", q: `Does ${employer ? employer.name : "your employer"} match what you put in a 401(k)?`, opts: ["Yes, 3%", "Yes, 4%", "Yes, 5% or more", "Not sure", "No match"] });
  }
  q.push({ id: "contrib", q: "Are you putting anything into your 401(k) right now?", opts: ["Yes, enough for the full match", "A little", "Nothing yet", "Not sure"] });
  const sav = shaped.find(a => a.id === "sav");
  if (sav) q.push({ id: "hysa", q: `Your savings at ${sav.inst}. Do you know if it earns more than 3%?`, opts: ["Yes, it does", "No, or not sure"], hl: sav.name });
  return q;
}

/* ---------- comp plan from what we know ---------- */
function grossFromNet(netAnnual, stateRate) {
  let lo = netAnnual, hi = netAnnual * 2.2;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (E.estimatedNet(mid, stateRate) < netAnnual) lo = mid; else hi = mid; }
  return round(lo, 100);
}

function compFor({ detected, hr, ans, pay }) {
  const payFrequency = detected?.frequency || "biweekly";
  const perYear = E.PAYCHECKS_PER_YEAR[payFrequency];
  const stateTaxRate = 0.05;
  const net = pay || detected?.netBasePerPaycheck || (hr?.pay ?? 0);
  const baseSalary = hr?.salary || (net ? grossFromNet(net * perYear, stateTaxRate) : 50_000);
  const commissionMonthlyNet = /commission/i.test(ans?.commission || "") ? sum((detected?.deposits || []).map(d => d.commission)) / 6 : 0;
  const ote = baseSalary + (commissionMonthlyNet ? grossFromNet(commissionMonthlyNet * 12, stateTaxRate) : 0);
  const start = new Date(); start.setUTCFullYear(start.getUTCFullYear() - 1);
  return { payFrequency, baseSalary, ote, commissionCadence: "monthly", startDate: E.toISO(start), rampMonths: 0, rampDrawMonthly: 0, drawRecoverable: false, stateTaxRate };
}

function matchPctFrom(employer, ans) {
  if (employer && employer.matchPct !== null && employer.matchPct !== undefined) return Number(employer.matchPct);
  const m = String(ans?.match || "").match(/(\d+(?:\.\d+)?)%/);
  return m ? Number(m[1]) : /^yes/i.test(ans?.match || "") ? 4 : 0;
}
function contributingFrom(ans, matchPct) {
  const c = String(ans?.contrib || "");
  if (/full match/i.test(c)) return matchPct;
  if (/little/i.test(c)) return Math.min(1, matchPct / 2);
  if (/nothing/i.test(c)) return 0;
  return null;
}

/* ---------- the profile ---------- */
async function profile(user) {
  const { accounts, txns, state } = await loadData(user.id);
  const shaped = shapeAccounts(accounts, txns);
  const debts = E.highInterestDebts(engineAccounts(accounts));
  const detected = E.detectIncome(txns);
  const hr = user.hr_data || null;
  const employer = user.employer_name ? { name: user.employer_name, matchPct: hr?.benefits?.retirement?.matchPct ?? Number(user.match_pct), k401Provider: user.k401_provider } : null;
  const payer = detected ? cleanPayer(detected.payer) : (employer?.name || hr?.employer || null);
  const pay = detected?.netBasePerPaycheck || hr?.pay || null;
  const frequency = detected?.frequency || "biweekly";
  const out = {
    first: user.first_name || user.name || "there",
    payer, pay, frequency, frequencyWords: FREQ_WORDS[frequency],
    paysTo: shaped.find(a => a.id === "chk")?.name || "checking",
    nextPayDate: detected?.nextPayDate || null,
    salary: hr?.salary || null,
    matchPct: employer?.matchPct ?? null,
    employer,
    banks: [...new Set(shaped.map(a => a.inst))],
    accounts: shaped,
    lead: leadFor(shaped, debts),
    living: livingFor(txns, accounts, debts),
    questions: questionsFor(detected, employer, shaped),
    hasCards: debts.length > 0,
    commissions: (detected?.deposits || []).filter(d => d.commission > 0).slice(-4).reverse(),
    transactions: txns.length,
    state,
  };
  if (state && state.living && state.living.length) out.safe = safeFor(user, { accounts, txns, detected, state });
  return out;
}

/* ---------- the plan, as the demo's moves ---------- */
function planFor(user, data, { living, ans, pay }) {
  const { accounts, txns } = data;
  const detected0 = E.detectIncome(txns);
  const detected = detected0 && pay ? { ...detected0, netBasePerPaycheck: pay } : detected0;
  const hr = user.hr_data || null;
  const employerName = user.employer_name || hr?.employer || null;
  const employerMatch = user.employer_name ? (hr?.benefits?.retirement?.matchPct ?? Number(user.match_pct)) : null;
  const matchPct = matchPctFrom(employerMatch === null ? null : { matchPct: employerMatch }, ans);
  const comp = compFor({ detected, hr, ans, pay });
  const livingItems = (living || []).map((l, i) => ({ key: l.key || "l" + i, name: l.name, monthly: Math.max(0, Number(l.amt) || 0), kind: l.type }));
  const baseDetected = detected || (pay ? { frequency: comp.payFrequency, netBasePerPaycheck: pay, deposits: [] } : null);
  const build = det => E.buildPlan({
    today: today(), comp, accounts: engineAccounts(accounts), living: livingItems,
    employer: matchPct ? { name: employerName || "Your employer", matchPct } : null,
    contributingPct: contributingFrom(ans, matchPct),
    detected: det,
    savingsHighYield: ans?.hysa ? /^yes/i.test(ans.hysa) : null,
  });
  let plan = build(baseDetected);
  // If Jeff recommends the 401(k) match, plan the rest on the smaller paycheck that comes with it.
  const matchRec = plan.recommendations.find(r => r.kind === "match");
  const matchCut = matchRec && baseDetected ? round(((comp.baseSalary * matchPct) / 100 * 0.78) / E.PAYCHECKS_PER_YEAR[comp.payFrequency], 5) : 0;
  if (matchCut) plan = build({ ...baseDetected, netBasePerPaycheck: baseDetected.netBasePerPaycheck - matchCut });
  const by = Object.fromEntries(plan.recommendations.map(r => [r.kind, r]));
  const alloc = Object.fromEntries(plan.allocations.map(a => [a.bucket, a.perPaycheck]));
  const moves = [];
  const provider = user.k401_provider || "your 401(k) provider";

  if (by.match) {
    const annual = (comp.baseSalary * matchPct) / 100;
    const cut = matchCut || round((annual * 0.78) / E.PAYCHECKS_PER_YEAR[comp.payFrequency], 5);
    const now = contributingFrom(ans, matchPct);
    const gap = now === null ? `If you're not putting in at least ${matchPct} percent yet, you're leaving up to ${fmt(annual)} a year on the table.`
      : now === 0 ? `Right now you're not putting anything in, so you're leaving about ${fmt(annual)} a year on the table.`
      : `Right now you're putting in less than that, so you're leaving part of about ${fmt(annual)} a year on the table.`;
    moves.push({ id: "match", kind: "move", title: by.match.title, detail: by.match.detail,
      say: `${employerName || "Your employer"} matches ${matchPct} percent of your pay. ${gap} I'd set your 401(k) to ${matchPct} percent. Your paycheck drops about ${fmt(cut)}, because it comes out before tax, and I've already counted that in your plan.`,
      why: by.match.why, payCut: cut, payCutAlt: round(cut / 2, 5),
      alt: { say: `We could start at ${Math.ceil(matchPct / 2)} percent and step up later. You'd get about half the match now. Want that?`, detail: `Start at ${Math.ceil(matchPct / 2)}%, step up later` },
      todo: `Log in to ${provider} and set your contribution to ${matchPct}%.`,
      value: { amt: by.match.value10y, alt: round(by.match.value10y * 0.5, 100), kind: "free", curve: "comp", label: "Free employer money" } });
  }
  if (by.hysa) {
    moves.push({ id: "hysa", kind: "check", title: by.hysa.title, detail: by.hysa.detail,
      say: `Your savings probably earns close to nothing where it is. A high-yield account pays around 4 percent, no fees, and takes five minutes to open. Want me to walk you through it?`,
      why: by.hysa.why, yesLine: "Good. Open one at any online bank with no fees and no minimum, then move your cushion there. Connect it here when it's open and I'll take it from there.",
      noLine: "No problem. Your cushion stays where it is, and I'll still plan around it.", rec: "Open one, then connect it here",
      value: { amt: by.hysa.value10y, kind: "earned", curve: "lin", label: "Interest earned on your cushion" } });
  }
  if (by.cushion) {
    const pp = alloc.cushion || 0;
    moves.push({ id: "cushion", kind: "move", title: by.cushion.title, detail: by.cushion.detail,
      say: `Before we go after anything else, I want ${fmt(plan.cushion.current < plan.cushion.starterTarget ? plan.cushion.starterTarget : plan.cushion.fullTarget)} between you and the next surprise.${pp ? ` I'll put ${fmt(pp)} from each paycheck toward it` : " I'll fill it"}, plus part of every commission. Sound good?`,
      why: by.cushion.why, alloc: pp ? { label: "Cushion", want: pp, alt: round(pp / 2, 5), to: "savings:Cushion" } : null,
      alt: pp ? { say: `I could do ${fmt(round(pp / 2, 5))} a paycheck instead. Slower, but more goes to everything else. Want that?`, detail: `${fmt(round(pp / 2, 5))} from each paycheck` } : null,
      value: { amt: 0, kind: "protect", label: "Protection when surprises hit" } });
  }
  if (by.cards) {
    const first = [...plan.debts].sort((a, b) => b.apr - a.apr)[0];
    moves.push({ id: "cards", kind: "move", title: by.cards.title, detail: by.cards.detail,
      say: `Everything left after your living money and cushion goes at your high-interest debt, starting with ${first.name} at ${(first.apr * 100).toFixed(0)} percent.${plan.payoff?.monthsToFree ? ` On base pay alone you're free in about ${plan.payoff.monthsToFree} months, and commissions make it faster.` : ""} You'll pay about ${fmt(plan.payoff?.interestSaved || 0)} less interest than if you kept paying minimums.`,
      why: "It's called the avalanche. Same total payment, aimed at the most expensive debt first. When one's gone, that payment rolls to the next.",
      alloc: { label: "Debt payoff", rest: true, to: "cards" },
      value: { amt: plan.payoff?.interestSaved || 0, kind: "saved", curve: "debt", label: "Interest you won't pay vs. minimums" } });
  }
  if (by.commission_split) {
    // Use their most recent real commission as the example, when there is one.
    const last = (detected0?.deposits || []).filter(d => d.commission > 0).slice(-1)[0];
    const example = last ? round(last.commission, 10) : Math.max(500, round((plan.income.targetCommissionMonthlyGross || 1000) * 0.65, 100));
    const split = E.routeCommission(plan, example, { cushionBalance: plan.cushion.current, cardDebt: sum(plan.debts.map(d => d.balance)) }, comp);
    const words = split.map(s => `${fmt(s.amount)} ${E.BUCKET_LABEL[s.bucket].toLowerCase()}`).join(", ");
    moves.push({ id: "commission", kind: "move", title: by.commission_split.title,
      detail: `${last ? "Your last" : "A"} ${fmt(example)} commission, split today: ${words}.`,
      say: `Your base pays for your life. Commission is how you get ahead, so every commission check gets split the day it lands. ${last ? `Your last one was ${fmt(example)}. Today it would go` : `A ${fmt(example)} check right now would go`}: ${words}. Ten percent is always yours, no questions.`,
      why: by.commission_split.why, value: { amt: 0, kind: "protect", label: "Commission with a job" } });
  }
  if (by.tax_reserve) moves.push({ id: "tax", kind: "move", title: by.tax_reserve.title, detail: by.tax_reserve.detail, say: `${by.tax_reserve.detail} ${by.tax_reserve.why}`, why: by.tax_reserve.why, value: { amt: 0, kind: "protect", label: "No surprise tax bill" } });
  if (by.roth) {
    moves.push({ id: "roth", kind: "move", title: by.roth.title, detail: by.roth.detail,
      say: `No high-interest debt, so the money left over goes to work. ${by.roth.detail} Starting now is the single biggest lever on your retirement.`,
      why: by.roth.why, alloc: { label: "Roth IRA", rest: true, to: "roth" },
      todo: "Open a Roth IRA at a low-cost brokerage and set up an automatic transfer on paydays.",
      value: { amt: by.roth.value10y, kind: "growth", curve: "comp", label: "Tax-free growth" } });
  }
  return { moves, notes: plan.notes, surplusPerPaycheck: plan.surplusPerPaycheck, cushion: plan.cushion };
}

/** The engine's plan for the living costs and answers a user already agreed to. */
function agreedPlan(user, { accounts, detected, state }) {
  const living = (state.living || []).map((l, i) => ({ key: l.key || "l" + i, name: l.name, monthly: Number(l.amt) || 0, kind: l.type }));
  const comp = compFor({ detected, hr: user.hr_data, ans: state.ans, pay: state.pay });
  const plan = E.buildPlan({ today: today(), comp, accounts: engineAccounts(accounts), living, employer: null, contributingPct: null,
    detected: detected || (state.pay ? { frequency: comp.payFrequency, netBasePerPaycheck: state.pay, deposits: [] } : null), savingsHighYield: null });
  return { plan, comp };
}

function safeFor(user, data) {
  const { accounts, txns, detected } = data;
  const { plan } = agreedPlan(user, data);
  const checking = sum(accounts.filter(a => a.kind === "checking").map(a => a.balance));
  const since = detected?.lastPayDate || E.addDays(today(), -7);
  return E.safeToSpend({ plan, checkingBalance: checking, flexibleSpentSincePayday: E.flexibleSpentSince(txns, since) });
}

async function plan(user, input) {
  return planFor(user, await loadData(user.id), input);
}

async function saveState(userId, data) {
  await pool.query(
    `INSERT INTO live_state(user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [userId, JSON.stringify(data)]);
}

module.exports = { profile, plan, saveState, cleanPayer, loadData, agreedPlan };
