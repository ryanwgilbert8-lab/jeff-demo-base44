-- Jeff: initial schema. Every user-owned table has RLS so a rep can only ever read
-- their own rows. Employers never read these tables; they get group totals through
-- employer_cohort_stats(), which refuses groups smaller than 10.

create extension if not exists pgcrypto;

-- Employers and invites --------------------------------------------------------

create table public.employers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  match_pct numeric(5,2) not null default 0,
  k401_provider text,
  created_at timestamptz not null default now()
);

create table public.invite_codes (
  code text primary key,
  employer_id uuid not null references public.employers(id) on delete cascade,
  cohort text not null,                 -- e.g. "SDR class, Jan 2027"
  expires_at timestamptz,
  max_uses int,
  uses int not null default 0,
  created_at timestamptz not null default now()
);

-- People -----------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employer_id uuid references public.employers(id),
  cohort text,
  first_name text,
  role text not null default 'employee' check (role in ('employee', 'employer_admin')),
  onboarding_step text not null default 'join'
    check (onboarding_step in ('join', 'connect', 'income', 'living', 'plan', 'done')),
  contributing_pct numeric(5,2),        -- current 401(k) contribution, null if unknown
  savings_high_yield boolean,
  created_at timestamptz not null default now()
);

create table public.comp_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pay_frequency text not null check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  base_salary numeric(12,2) not null check (base_salary >= 0),
  ote numeric(12,2) not null check (ote >= base_salary),
  commission_cadence text not null default 'monthly' check (commission_cadence in ('monthly', 'quarterly')),
  start_date date not null,
  ramp_months int not null default 0 check (ramp_months between 0 and 24),
  ramp_draw_monthly numeric(12,2) not null default 0,
  draw_recoverable boolean not null default false,
  state_tax_rate numeric(5,4) not null default 0.05,
  updated_at timestamptz not null default now()
);

-- Bank data (Plaid) ----------------------------------------------------------------

create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null unique,
  access_token_enc text not null,       -- AES-256-GCM, key lives only in the app server env
  institution_name text,
  sync_cursor text,
  status text not null default 'ok',
  created_at timestamptz not null default now()
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_item_id uuid not null references public.plaid_items(id) on delete cascade,
  plaid_account_id text not null unique,
  name text not null,
  mask text,
  institution text,
  kind text not null check (kind in ('checking', 'savings', 'credit', 'loan', 'investment', 'other')),
  balance numeric(14,2) not null default 0,  -- cash held, or amount owed for credit/loan
  apr numeric(6,4),
  min_payment numeric(12,2),
  updated_at timestamptz not null default now()
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  plaid_transaction_id text not null unique,
  date date not null,
  name text not null,
  merchant_name text,
  amount numeric(14,2) not null,        -- Plaid sign: positive = money out
  category_primary text,
  category_detailed text,
  pending boolean not null default false
);
create index transactions_user_date on public.transactions (user_id, date desc);

-- The plan -----------------------------------------------------------------------

create table public.living_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  name text not null,
  monthly numeric(12,2) not null check (monthly >= 0),
  kind text not null check (kind in ('fixed', 'need', 'want')),
  confirmed boolean not null default false,
  primary key (user_id, key)
);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  detail text not null,
  why text not null,
  value_10y numeric(14,2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, kind)
);

create table public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index messages_user_time on public.messages (user_id, created_at);

-- Every recommendation Jeff makes and every yes/no is recorded, append-only.
create table public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  actor text not null,                  -- 'user' | 'jeff' | 'system'
  action text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Row level security --------------------------------------------------------------

alter table public.employers enable row level security;
alter table public.invite_codes enable row level security;
alter table public.profiles enable row level security;
alter table public.comp_plans enable row level security;
alter table public.plaid_items enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.living_items enable row level security;
alter table public.recommendations enable row level security;
alter table public.messages enable row level security;
alter table public.audit_log enable row level security;

-- Reps can see their own employer's name and match. Invite codes are only checked
-- server-side (redeem_invite), so they have no client policy at all.
create policy "read own employer" on public.employers for select to authenticated
  using (id = (select employer_id from public.profiles where id = (select auth.uid())));

create policy "own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "update own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- Employer, cohort and role only change through redeem_invite or an admin, never the client.
revoke update on public.profiles from authenticated;
grant update (first_name, contributing_pct, savings_high_yield, onboarding_step) on public.profiles to authenticated;

create policy "own comp plan" on public.comp_plans for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own accounts" on public.accounts for select to authenticated using (user_id = (select auth.uid()));
create policy "own transactions" on public.transactions for select to authenticated using (user_id = (select auth.uid()));
create policy "own living items" on public.living_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own recommendations" on public.recommendations for select to authenticated using (user_id = (select auth.uid()));
create policy "decide own recommendations" on public.recommendations for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.recommendations from authenticated;
grant update (status, decided_at) on public.recommendations to authenticated;
create policy "own messages" on public.messages for select to authenticated using (user_id = (select auth.uid()));
create policy "own audit log" on public.audit_log for select to authenticated using (user_id = (select auth.uid()));
-- Writes to plaid_items, accounts, transactions, recommendations (insert), messages and
-- audit_log happen on the server with the service role, after the user is verified.
-- plaid_items: no client policies. Access tokens are only touched by the server with the service role.

-- A profile row for every new sign-in.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Redeem an employer invite: attaches the caller to the employer and cohort.
create function public.redeem_invite(invite text, first text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invite_codes;
begin
  select * into inv from public.invite_codes where code = upper(trim(invite)) for update;
  if inv is null then raise exception 'invalid_code'; end if;
  if inv.expires_at is not null and inv.expires_at < now() then raise exception 'expired_code'; end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then raise exception 'used_up_code'; end if;
  update public.invite_codes set uses = uses + 1 where code = inv.code;
  update public.profiles
     set employer_id = inv.employer_id, cohort = inv.cohort, first_name = nullif(trim(first), ''),
         onboarding_step = case when onboarding_step = 'join' then 'connect' else onboarding_step end
   where id = auth.uid();
  insert into public.audit_log (user_id, actor, action, payload)
    values (auth.uid(), 'user', 'joined_employer', jsonb_build_object('employer_id', inv.employer_id, 'cohort', inv.cohort));
  return inv.employer_id;
end $$;
revoke all on function public.redeem_invite(text, text) from public, anon;
grant execute on function public.redeem_invite(text, text) to authenticated;

-- Employer view: totals for a cohort, never individuals. Returns nothing below 10 people.
create function public.employer_cohort_stats(emp uuid, cohort_name text)
returns table (members int, onboarded int, getting_full_match int, avg_cushion_months numeric)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role = 'employer_admin' and p.employer_id = emp) then
    raise exception 'not_allowed';
  end if;
  return query
  with m as (
    select p.id, p.onboarding_step, p.contributing_pct, e.match_pct,
           (select coalesce(sum(a.balance), 0) from public.accounts a where a.user_id = p.id and a.kind = 'savings') as cushion,
           (select coalesce(sum(l.monthly), 0) from public.living_items l where l.user_id = p.id) as living
      from public.profiles p join public.employers e on e.id = p.employer_id
     where p.employer_id = emp and p.cohort = cohort_name and p.role = 'employee'
  )
  select count(*)::int,
         count(*) filter (where onboarding_step = 'done')::int,
         count(*) filter (where contributing_pct >= match_pct)::int,
         round(avg(case when living > 0 then cushion / living end), 1)
    from m
  having count(*) >= 10;
end $$;
revoke all on function public.employer_cohort_stats(uuid, text) from public, anon;
grant execute on function public.employer_cohort_stats(uuid, text) to authenticated;
