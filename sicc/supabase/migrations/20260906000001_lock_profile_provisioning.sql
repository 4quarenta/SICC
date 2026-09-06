-- Operator profiles are provisioned by a server/Edge Function after it checks
-- the hashed, single-use invite. Do not allow a browser to self-promote or
-- choose an arbitrary inviter through the Data API.
drop policy if exists operator_profiles_insert on public.operator_profiles;
drop policy if exists operator_profiles_update on public.operator_profiles;

create policy operator_profiles_admin_update on public.operator_profiles for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

revoke insert, update on public.operator_profiles from authenticated;
