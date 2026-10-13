import { guardStep } from "@/lib/data";
import { fmt, sum } from "@/lib/engine";
import { Steps } from "@/components/Steps";
import { LivingForm } from "./LivingForm";

export default async function Living() {
  const { supabase, user, profile } = await guardStep("living", "plan", "done");
  const { data } = await supabase.from("living_items").select("key, name, monthly, kind").eq("user_id", user.id);
  const order = { fixed: 0, need: 1, want: 2 } as Record<string, number>;
  const items = (data ?? []).map(i => ({ ...i, monthly: Number(i.monthly) })).sort((a, b) => order[a.kind] - order[b.kind] || b.monthly - a.monthly);
  return (
    <div className="pad">
      <Steps at="living" />
      <h1 className="title">What it costs you to live</h1>
      <p className="sub">
        {items.length
          ? <>From your last few months: about <b className="num">{fmt(sum(items.map(i => i.monthly)))}</b> a month. Fix anything that looks off. Bills are fixed, needs flex a little, wants are your call.</>
          : "We didn't find enough spending to estimate this yet. Go back and refresh your accounts, or continue and add it later."}
      </p>
      <LivingForm items={items} savingsHighYield={profile.savings_high_yield} />
    </div>
  );
}
