"use client";
import { useActionState } from "react";
import { sendMagicLink, type FormState } from "@/app/actions";

export default function Login() {
  const [state, action, pending] = useActionState<FormState, FormData>(sendMagicLink, undefined);
  return (
    <div className="pad">
      <h1 className="title">Sign in</h1>
      {state?.sent ? (
        <p className="sub">Check your email. We sent you a link that signs you in. It works once and expires in an hour.</p>
      ) : (
        <form action={action}>
          <p className="sub">Use your work or personal email. We'll send a sign-in link, no password needed.</p>
          <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" required autoFocus /></label>
          {state?.error && <p className="err">{state.error}</p>}
          <button className="primary" disabled={pending}>{pending ? "Sending…" : "Email me a link"}</button>
        </form>
      )}
    </div>
  );
}
