begin;

-- Extend only invitations that are still active and were previously capped at two hours.
-- Already expired, used, or revoked invitations are never reactivated.
update public.operator_invites
set expires_at = created_at + interval '8 hours'
where expires_at > now()
  and expires_at = created_at + interval '2 hours';

commit;
