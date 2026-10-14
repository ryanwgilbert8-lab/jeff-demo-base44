import { redirect } from "next/navigation";
import { loadProfile, STEP_PATH, type Step } from "@/lib/data";
import { JoinForm } from "./JoinForm";

export default async function Join() {
  const { profile } = await loadProfile();
  if (profile.onboarding_step !== "join") redirect(STEP_PATH[profile.onboarding_step as Step]);
  return (
    <div className="pad">
      <h1 className="title">Welcome to Jeff</h1>
      <p className="sub">Your company set this up for your team. Enter the code from your welcome email.</p>
      <JoinForm />
    </div>
  );
}
