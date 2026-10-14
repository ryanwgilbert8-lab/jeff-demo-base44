"use client";
import { useActionState } from "react";
import { joinEmployer, type FormState } from "@/app/actions";

export function JoinForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(joinEmployer, undefined);
  return (
    <form action={action}>
      <label className="field"><span>First name</span><input name="first" autoComplete="given-name" required /></label>
      <label className="field"><span>Team code</span><input name="code" autoCapitalize="characters" placeholder="ACME-SDR-27" required /></label>
      {state?.error && <p className="err">{state.error}</p>}
      <button className="primary" disabled={pending}>Continue</button>
    </form>
  );
}
