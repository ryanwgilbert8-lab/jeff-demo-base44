"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Banks can take a minute to send transaction history after linking. */
export function RefreshBanks() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="secondary" disabled={busy} onClick={async () => {
      setBusy(true);
      await fetch("/api/plaid/sync", { method: "POST" });
      setBusy(false);
      router.refresh();
    }}>{busy ? "Refreshing…" : "Refresh"}</button>
  );
}
