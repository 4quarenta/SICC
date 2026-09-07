-- Apply the two-hour invitation policy to records created before this migration.
-- The predicate keeps this migration safe to re-run.
update public.operator_invites
set expires_at = created_at + interval '2 hours'
where expires_at > created_at + interval '2 hours';
