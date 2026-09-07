begin;

alter table public.people
  add column if not exists custody_status text not null default 'free';

update public.people
set custody_status = 'free'
where custody_status is null
   or custody_status not in ('free', 'detained');

alter table public.people
  drop constraint if exists people_custody_status_check;

alter table public.people
  add constraint people_custody_status_check
  check (custody_status in ('free', 'detained'));

commit;
