-- Cover foreign keys used by joins, deletes and RLS checks.
create index if not exists approaches_operator_idx on public.approaches (operator_id);
create index if not exists audit_logs_operator_idx on public.audit_logs (operator_id);
create index if not exists operator_invites_creator_idx on public.operator_invites (created_by);
create index if not exists operator_invites_used_by_idx on public.operator_invites (used_by);
create index if not exists operator_profiles_invited_by_idx on public.operator_profiles (invited_by);
create index if not exists people_created_by_idx on public.people (created_by);
create index if not exists people_faction_idx on public.people (faction_id);
create index if not exists qtc_alerts_created_by_idx on public.qtc_alerts (created_by);
create index if not exists qtc_alerts_resolved_by_idx on public.qtc_alerts (resolved_by);
