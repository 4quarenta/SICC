alter table public.operator_invites
  add column if not exists code text;

create unique index if not exists operator_invites_code_key
  on public.operator_invites (code)
  where code is not null;