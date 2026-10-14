import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import {
  type Account, type CompPlan, type Employer, type LivingItem, type Transaction,
  addDays, buildPlan, detectIncome, flexibleSpentSince, safeToSpend, sum, toISO,
} from "@/lib/engine";

export type Step = "join" | "connect" | "income" | "living" | "plan" | "done";
export const STEP_PATH: Record<Step, string> = { join: "/join", connect: "/connect", income: "/income", living: "/living", plan: "/plan", done: "/home" };

export async function requireUser() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return { supabase, user: data.user };
}

export async function loadProfile() {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) redirect("/login");
  return { supabase, user, profile };
}

/** Sends the user to the right onboarding step if they jump ahead. */
export async function guardStep(...allowed: Step[]) {
  const ctx = await loadProfile();
  const step = ctx.profile.onboarding_step as Step;
  if (!allowed.includes(step)) {
    const order: Step[] = ["join", "connect", "income", "living", "plan", "done"];
    // Going back to an earlier step is fine; skipping forward is not.
    if (order.indexOf(step) < Math.min(...allowed.map(s => order.indexOf(s)))) redirect(STEP_PATH[step]);
  }
  return ctx;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function toComp(row: Record<string, unknown> | null): CompPlan | null {
  if (!row) return null;
  return {
    payFrequency: row.pay_frequency as CompPlan["payFrequency"],
    baseSalary: num(row.base_salary),
    ote: num(row.ote),
    commissionCadence: row.commission_cadence as CompPlan["commissionCadence"],
    startDate: String(row.start_date),
    rampMonths: num(row.ramp_months),
    rampDrawMonthly: num(row.ramp_draw_monthly),
    drawRecoverable: !!row.draw_recoverable,
    stateTaxRate: num(row.state_tax_rate),
  };
}

/** Everything the engine needs for one user, read with their own RLS-scoped client. */
export async function loadFinances() {
  const { supabase, user, profile } = await loadProfile();
  const today = toISO(new Date());
  const since = addDays(today, -180);
  const [emp, comp, acc, tx, living] = await Promise.all([
    profile.employer_id ? supabase.from("employers").select("name, match_pct, k401_provider").eq("id", profile.employer_id).single() : Promise.resolve({ data: null }),
    supabase.from("comp_plans").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("accounts").select("*").eq("user_id", user.id).order("kind"),
    supabase.from("transactions").select("*").eq("user_id", user.id).gte("date", since).order("date", { ascending: false }).limit(5000),
    supabase.from("living_items").select("*").eq("user_id", user.id),
  ]);

  const employer: Employer | null = emp.data ? { name: emp.data.name, matchPct: num(emp.data.match_pct), k401Provider: emp.data.k401_provider } : null;
  const accounts: Account[] = (acc.data ?? []).map(a => ({
    id: a.id, name: a.name, institution: a.institution, kind: a.kind, balance: num(a.balance),
    apr: a.apr === null ? null : num(a.apr), minPayment: a.min_payment === null ? null : num(a.min_payment),
  }));
  const transactions: Transaction[] = (tx.data ?? []).map(t => ({
    id: t.id, accountId: t.account_id, date: t.date, name: t.name, merchant: t.merchant_name,
    amount: num(t.amount), categoryPrimary: t.category_primary, categoryDetailed: t.category_detailed, pending: t.pending,
  }));
  const livingItems: LivingItem[] = (living.data ?? []).map(l => ({ key: l.key, name: l.name, monthly: num(l.monthly), kind: l.kind }));
  return { supabase, user, profile, today, employer, comp: toComp(comp.data), accounts, transactions, livingItems };
}

export type Finances = Awaited<ReturnType<typeof loadFinances>>;

/** The plan plus the live numbers for the home screen. Null until income is set up. */
export function computeSnapshot(f: Finances) {
  if (!f.comp) return null;
  const detected = detectIncome(f.transactions);
  const plan = buildPlan({
    today: f.today,
    comp: f.comp,
    employer: f.employer,
    contributingPct: f.profile.contributing_pct === null ? null : Number(f.profile.contributing_pct),
    accounts: f.accounts,
    living: f.livingItems,
    detected,
    savingsHighYield: f.profile.savings_high_yield,
  });
  const checking = sum(f.accounts.filter(a => a.kind === "checking").map(a => a.balance));
  const lastPay = detected?.lastPayDate ?? addDays(f.today, -7);
  const safe = safeToSpend({ plan, checkingBalance: checking, flexibleSpentSincePayday: flexibleSpentSince(f.transactions, lastPay) });
  const recentCommissions = (detected?.deposits ?? []).filter(d => d.commission > 0).slice(-4).reverse();
  return { plan, detected, checking, safe, nextPayDate: detected?.nextPayDate ?? null, recentCommissions };
}
