create or replace function public.search_face_candidates(
  query_embedding extensions.vector(128),
  match_limit integer default 25,
  match_threshold double precision default 0.62
)
returns table (person_id bigint, media_id bigint, distance double precision)
language sql stable
set search_path = public, extensions
as $$
  select pm.person_id, pm.id, (pm.face_embedding <=> query_embedding)::double precision
  from public.person_media pm
  join public.people p on p.id = pm.person_id
  where pm.kind in ('face', 'face_front', 'face_profile')
    and pm.face_embedding is not null
    and (pm.face_embedding <=> query_embedding) <= match_threshold
  order by pm.face_embedding <=> query_embedding
  limit least(greatest(match_limit, 1), 100);
$$;

revoke all on function public.search_face_candidates(extensions.vector(128), integer, double precision) from public;
grant execute on function public.search_face_candidates(extensions.vector(128), integer, double precision) to service_role;
