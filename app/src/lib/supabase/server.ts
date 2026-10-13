import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Supabase client acting as the signed-in user. RLS applies. */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: list => {
        // Server Components can't set cookies; the proxy refreshes the session instead.
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {}
      },
    },
  });
}

/**
 * Service-role client that bypasses RLS. Only for writes the user can't do directly
 * (Plaid tokens, synced bank data, Jeff's messages). Always scope queries by a user id
 * that came from `requireUser()`, never from the request body.
 */
export function supabaseAdmin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getUser() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return data.user;
}
