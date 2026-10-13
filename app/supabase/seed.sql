-- Local/dev seed: one employer and an invite code for its SDR class.
insert into public.employers (id, name, match_pct, k401_provider)
values ('00000000-0000-4000-8000-000000000001', 'Acme Software', 4, 'Fidelity')
on conflict do nothing;

insert into public.invite_codes (code, employer_id, cohort, max_uses)
values ('ACME-SDR-27', '00000000-0000-4000-8000-000000000001', 'SDR class, Jan 2027', 200)
on conflict do nothing;
