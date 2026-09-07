begin;

-- Convert still-active links created under the previous two-hour policy.
-- The tolerance accounts for timestamp differences between application and database clocks.
-- Expired, used, and revoked links remain unchanged.
update public.operator_invites
set expires_at = created_at + interval '8 hours'
where expires_at > now()
  and expires_at between created_at + interval '2 hours' - interval '1 minute'
                    and created_at + interval '2 hours' + interval '1 minute';

commit;
