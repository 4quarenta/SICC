begin;

update public.people
set cpf = regexp_replace(cpf, '\D', '', 'g')
where cpf <> regexp_replace(cpf, '\D', '', 'g');

alter table public.people
  drop constraint if exists people_cpf_digits_check;

alter table public.people
  add constraint people_cpf_digits_check
  check (cpf ~ '^[0-9]{11}$');

commit;
