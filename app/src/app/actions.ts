"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { loadFinances, loadProfile, requireUser } from "@/lib/data";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";
import { refreshRecommendations } from "@/lib/recs";
import { livingFromTransactions } from "@/lib/engine";

export type FormState = { error?: string; sent?: boolean } | undefined;

async function siteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
}

export async function sendMagicLink(_: FormState, form: FormData): Promise<FormState> {
  const email = z.email().safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { error: "That doesn't look like an email address." };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({ email: email.data, options: { emailRedirectTo: `${await siteUrl()}/auth/callback` } });
  if (error) return { error: "We couldn't send the link. Try again in a minute." };
  return { sent: true };
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}

export async function joinEmployer(_: FormState, form: FormData): Promise<FormState> {
  const { supabase } = await requireUser();
  const code = String(form.get("code") ?? "").trim();
  const first = String(form.get("first") ?? "").trim().slice(0, 60);
  if (!code) return { error: "Enter the code from your welcome email." };
  const { error } = await supabase.rpc("redeem_invite", { invite: code, first });
  if (error) {
    const msg = /expired/.test(error.message) ? "That code has expired. Ask your manager for a new one."
      : /used_up/.test(error.message) ? "That code has been used up. Ask your manager for a new one."
      : "We don't recognize that code. Check the welcome email from your company.";
    return { error: msg };
  }
  redirect("/connect");
}

export async function finishConnect() {
  const { supabase, user } = await requireUser();
  const { count } = await supabase.from("accounts").select("id", { count: "exact", head: true }).eq("user_id", user.id);
  if (!count) redirect("/connect");
  await supabase.from("profiles").update({ onboarding_step: "income" }).eq("id", user.id).eq("onboarding_step", "connect");
  redirect("/income");
}

const Income = z.object({
  pay_frequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
  base_salary: z.coerce.number().min(10_000).max(1_000_000),
  ote: z.coerce.number().min(10_000).max(2_000_000),
  commission_cadence: z.enum(["monthly", "quarterly"]),
  start_date: z.iso.date(),
  ramp_months: z.coerce.number().int().min(0).max(24),
  ramp_draw_monthly: z.coerce.number().min(0).max(50_000),
  draw_recoverable: z.preprocess(v => v === "on", z.boolean()),
  state_tax_pct: z.coerce.number().min(0).max(15),
  contributing_pct: z.preprocess(v => (v === "" || v === null ? null : v), z.coerce.number().min(0).max(100).nullable()),
}).refine(v => v.ote >= v.base_salary, { message: "On-target earnings should be at least your base salary." });

export async function saveIncome(_: FormState, form: FormData): Promise<FormState> {
  const parsed = Income.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the highlighted fields." };
  const v = parsed.data;
  const { supabase, user } = await requireUser();
  const { error } = await supabase.from("comp_plans").upsert({
    user_id: user.id, pay_frequency: v.pay_frequency, base_salary: v.base_salary, ote: v.ote,
    commission_cadence: v.commission_cadence, start_date: v.start_date, ramp_months: v.ramp_months,
    ramp_draw_monthly: v.ramp_months ? v.ramp_draw_monthly : 0, draw_recoverable: v.ramp_months ? v.draw_recoverable : false,
    state_tax_rate: v.state_tax_pct / 100, updated_at: new Date().toISOString(),
  });
  if (error) return { error: "Couldn't save that. Try again." };
  await supabase.from("profiles").update({ contributing_pct: v.contributing_pct }).eq("id", user.id);
  await supabase.from("profiles").update({ onboarding_step: "living" }).eq("id", user.id).eq("onboarding_step", "income");

  // First time through: draft living costs from their transactions for them to confirm.
  const f = await loadFinances();
  if (!f.livingItems.length) {
    const items = livingFromTransactions(f.transactions, f.today);
    if (items.length) await supabase.from("living_items").upsert(items.map(i => ({ user_id: user.id, key: i.key, name: i.name, monthly: i.monthly, kind: i.kind })));
  }
  redirect("/living");
}

export async function saveLiving(_: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireUser();
  const { data: items } = await supabase.from("living_items").select("key").eq("user_id", user.id);
  for (const { key } of items ?? []) {
    const amt = Number(form.get(`amt_${key}`));
    const kind = String(form.get(`kind_${key}`));
    if (!Number.isFinite(amt) || amt < 0 || amt > 100_000 || !["fixed", "need", "want"].includes(kind)) return { error: "Amounts need to be numbers." };
    await supabase.from("living_items").update({ monthly: Math.round(amt), kind, confirmed: true }).eq("user_id", user.id).eq("key", key);
  }
  const hy = form.get("savings_high_yield");
  await supabase.from("profiles").update({ savings_high_yield: hy === "yes" ? true : hy === "no" ? false : null }).eq("id", user.id);
  await supabase.from("profiles").update({ onboarding_step: "plan" }).eq("id", user.id).eq("onboarding_step", "living");
  await refreshRecommendations(await loadFinances());
  redirect("/plan");
}

export async function decide(form: FormData) {
  const { supabase, user } = await requireUser();
  const id = z.uuid().parse(form.get("id"));
  const status = z.enum(["approved", "declined", "pending"]).parse(form.get("status"));
  await supabase.from("recommendations").update({ status, decided_at: status === "pending" ? null : new Date().toISOString() }).eq("id", id).eq("user_id", user.id);
  await supabaseAdmin().from("audit_log").insert({ user_id: user.id, actor: "user", action: `recommendation_${status}`, payload: { id } });
  revalidatePath("/plan");
  revalidatePath("/home");
}

export async function finishPlan() {
  const { supabase, user } = await loadProfile();
  await supabase.from("profiles").update({ onboarding_step: "done" }).eq("id", user.id);
  redirect("/home");
}

export async function rebuildPlan() {
  await refreshRecommendations(await loadFinances());
  revalidatePath("/home");
  revalidatePath("/plan");
}
