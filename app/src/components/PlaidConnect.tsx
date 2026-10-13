"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";

export function PlaidConnect({ label = "Connect a bank or card" }: { label?: string }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  useEffect(() => {
    fetch("/api/plaid/link-token", { method: "POST" })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setToken(j.link_token))
      .catch(() => setStatus("error"));
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(async (public_token, meta) => {
    if (!public_token) return;
    setStatus("saving");
    const r = await fetch("/api/plaid/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_token, institution: meta.institution?.name ?? null }),
    });
    setStatus(r.ok ? "idle" : "error");
    router.refresh();
  }, [router]);

  const { open, ready } = usePlaidLink({ token, onSuccess });

  return (
    <>
      <button type="button" className="secondary" onClick={() => open()} disabled={!ready || status === "saving"}>
        {status === "saving" ? "Pulling your accounts…" : label}
      </button>
      {status === "error" && <p className="err">Something went wrong connecting. Try again.</p>}
    </>
  );
}
