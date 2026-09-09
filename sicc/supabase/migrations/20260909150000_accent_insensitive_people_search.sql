create extension if not exists unaccent with schema extensions;

create or replace function public.search_people_ids(search_term text)
returns table(id bigint)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with normalized as (
    select lower(unaccent(trim(coalesce(search_term, '')))) as q,
           regexp_replace(coalesce(search_term, ''), '\D', '', 'g') as cpf_q
  )
  select distinct p.id
  from public.people p
  cross join normalized n
  where n.q <> ''
    and (
      lower(unaccent(coalesce(p.full_name, ''))) like '%' || n.q || '%'
      or lower(unaccent(coalesce(p.nickname, ''))) like '%' || n.q || '%'
      or lower(unaccent(coalesce(p.mother_name, ''))) like '%' || n.q || '%'
      or (n.cpf_q <> '' and p.cpf = n.cpf_q)
    );
$$;

revoke all on function public.search_people_ids(text) from public, anon, authenticated;
grant execute on function public.search_people_ids(text) to service_role;
