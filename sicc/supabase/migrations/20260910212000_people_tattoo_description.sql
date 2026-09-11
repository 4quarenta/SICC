alter table public.people
  add column if not exists tattoo_description text;

comment on column public.people.tattoo_description is
  'Descrição textual de tatuagens conhecidas do indivíduo, informada manualmente ou por importação assistida.';
