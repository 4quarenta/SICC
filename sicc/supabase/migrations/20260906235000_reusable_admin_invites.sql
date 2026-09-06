-- Reusable, revocable invitation links created by administrators.
alter table public.operator_invites
  add column if not exists invite_type text not null default 'single',
  add column if not exists revoked_at timestamptz,
  add column if not exists use_count integer not null default 0;

alter table public.operator_invites
  drop constraint if exists operator_invites_invite_type_check,
  add constraint operator_invites_invite_type_check check (invite_type in ('single', 'bulk')),
  drop constraint if exists operator_invites_use_count_check,
  add constraint operator_invites_use_count_check check (use_count >= 0);

create index if not exists operator_invites_active_code_idx
  on public.operator_invites (code_hash, expires_at)
  where revoked_at is null;
