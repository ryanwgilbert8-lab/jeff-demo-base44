import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, supabaseServer } from "@/lib/supabase/server";
import { STEP_PATH, type Step } from "@/lib/data";

export default async function Welcome() {
  const user = await getUser();
  if (user) {
    const supabase = await supabaseServer();
    const { data } = await supabase.from("profiles").select("onboarding_step").eq("id", user.id).single();
    redirect(STEP_PATH[(data?.onboarding_step ?? "join") as Step]);
  }
  return (
    <div className="welcome">
      <h1 className="wordmark">Jeff</h1>
      <p>Your money, run for you. Built for sales pay: steady base, lumpy commission, and every dollar with a job.</p>
      <p style={{ fontSize: 15, opacity: .75 }}>Free from your employer, and private. Your company never sees your accounts or what you ask Jeff.</p>
      <Link href="/login" className="primary" style={{ marginTop: "auto" }}>Get started</Link>
      <p className="fine">Read-only bank connection through Plaid. Jeff never moves your money.</p>
    </div>
  );
}
