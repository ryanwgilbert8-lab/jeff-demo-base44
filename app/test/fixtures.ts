import type { Account, CompPlan, Transaction } from "@/lib/engine";
import { addDays } from "@/lib/engine";

// An SDR six months in: $60k base, $90k OTE, paid biweekly, monthly commission, card debt.
export const comp: CompPlan = {
  payFrequency: "biweekly",
  baseSalary: 60_000,
  ote: 90_000,
  commissionCadence: "monthly",
  startDate: "2026-04-01",
  rampMonths: 3,
  rampDrawMonthly: 0,
  drawRecoverable: false,
  stateTaxRate: 0.05,
};

export const accounts: Account[] = [
  { id: "chk", name: "Total Checking", kind: "checking", balance: 1_800 },
  { id: "sav", name: "Savings", kind: "savings", balance: 400 },
  { id: "c1", name: "Quicksilver card", kind: "credit", balance: 3_200, apr: 0.279 },
  { id: "c2", name: "Discover it", kind: "credit", balance: 1_100, apr: 0.245 },
  { id: "sl", name: "Student loans", kind: "loan", balance: 24_000, apr: 0.055 },
];

const PRIMARIES = ["INCOME", "TRANSFER_OUT", "RENT_AND_UTILITIES", "LOAN_PAYMENTS", "FOOD_AND_DRINK", "GENERAL_MERCHANDISE", "TRANSPORTATION"];

/** 90 days of activity ending `today`: biweekly base pay of $1,780, monthly commissions on top. */
export function transactions(today = "2026-10-13"): Transaction[] {
  const t: Transaction[] = [];
  let id = 0;
  const add = (date: string, name: string, amount: number, detailed: string, accountId = "chk") =>
    t.push({ id: String(++id), accountId, date, name, amount, categoryPrimary: PRIMARIES.find(p => detailed.startsWith(p)) ?? null, categoryDetailed: detailed });

  // Paydays every 14 days back from Oct 9.
  for (let d = "2026-10-09"; d >= addDays(today, -90); d = addDays(d, -14)) add(d, "ACME SOFTWARE PAYROLL PPD", -1_780, "INCOME_WAGES");
  // Commission paid with the second paycheck of the month (on-cycle) and one off-cycle spiff.
  t.find(x => x.date === "2026-09-25")!.amount = -1_780 - 2_400;
  add("2026-08-15", "ACME SOFTWARE PAYROLL PPD", -900, "INCOME_WAGES");

  for (const m of ["2026-07-15", "2026-08-01", "2026-09-01", "2026-10-01"]) {
    if (m < addDays(today, -90)) continue;
    add(m, "Zelle to Landlord", 1_450, "RENT_AND_UTILITIES_RENT");
    add(m, "Verizon", 85, "RENT_AND_UTILITIES_TELEPHONE");
    add(m, "Nelnet", 230, "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT");
    add(m, "Capital One payment", 300, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");
  }
  for (let d = addDays(today, -88); d <= today; d = addDays(d, 7)) {
    add(d, "Trader Joe's", 70, "FOOD_AND_DRINK_GROCERIES", "c1");
    add(d, "DoorDash", 65, "FOOD_AND_DRINK_RESTAURANT", "c1");
    add(d, "Bar Louie", 45, "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR", "c1");
    add(d, "Amazon", 40, "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "c2");
    add(d, "Uber", 25, "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "c2");
  }
  add("2026-09-20", "Transfer to savings", 100, "TRANSFER_OUT_SAVINGS");
  return t;
}
