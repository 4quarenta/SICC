create extension if not exists unaccent;

create or replace function public.search_people_ids(search_term text)
returns table(id bigint)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with normalized as (
    select
      lower(unaccent(trim(coalesce(search_term, '')))) as q,
      regexp_replace(coalesce(search_term, ''), '\D', '', 'g') as cpf_q
  )
  select p.id
  from public.people p
  cross join normalized n
  where n.q <> ''
    and (
      lower(unaccent(coalesce(p.full_name, ''))) like '%' || n.q || '%'
      or lower(unaccent(coalesce(p.nickname, ''))) like '%' || n.q || '%'
      or lower(unaccent(coalesce(p.mother_name, ''))) like '%' || n.q || '%'
      or (n.cpf_q <> '' and p.cpf = n.cpf_q)
    )
  order by
    case
      when lower(unaccent(coalesce(p.full_name, ''))) = n.q then 0
      when lower(unaccent(coalesce(p.nickname, ''))) = n.q then 1
      when lower(unaccent(coalesce(p.full_name, ''))) like n.q || '%' then 2
      when lower(unaccent(coalesce(p.nickname, ''))) like n.q || '%' then 3
      when lower(unaccent(coalesce(p.mother_name, ''))) like n.q || '%' then 4
      else 5
    end,
    p.full_name,
    p.id;
$$;

revoke all on function public.search_people_ids(text) from public, anon, authenticated;
grant execute on function public.search_people_ids(text) to service_role;
