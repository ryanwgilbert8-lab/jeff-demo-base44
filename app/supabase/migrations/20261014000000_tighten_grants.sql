-- Signed-out visitors get nothing on Jeff's tables; RLS already blocked rows, this hides the tables too.
revoke all on public.employers, public.invite_codes, public.profiles, public.comp_plans, public.plaid_items,
  public.accounts, public.transactions, public.living_items, public.recommendations, public.messages, public.audit_log
  from anon;
-- Tables signed-in users never touch directly: invite codes (checked by redeem_invite) and Plaid tokens.
revoke all on public.invite_codes, public.plaid_items from authenticated;
-- Server-written tables: signed-in users only read them.
revoke insert, delete, truncate, references, trigger on public.accounts, public.transactions, public.recommendations,
  public.messages, public.audit_log, public.employers from authenticated;
-- Profiles are created by the sign-up trigger only.
revoke insert, delete, truncate, references, trigger on public.profiles from authenticated;
