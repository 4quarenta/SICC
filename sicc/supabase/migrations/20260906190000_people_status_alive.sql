-- Migrate person situation from review workflow states to life status.
-- Existing records cannot be inferred as deceased, so legacy values become alive.
begin;

alter table public.people
  drop constraint if exists people_status_check;

update public.people
set status = case when status = 'dead' then 'dead' else 'alive' end;

alter table public.people
  alter column status set default 'alive';

alter table public.people
  add constraint people_status_check
  check (status in ('alive', 'dead'));

commit;
