insert into public.person_media (person_id, kind, object_key, original_name, content_type, byte_size, sha256, description)
select distinct on (l.person_id, r.image_object_key)
  l.person_id,
  'legacy',
  r.image_object_key,
  coalesce(nullif(r.original_name, ''), r.record_id || '.webp'),
  'image/webp',
  coalesce(r.image_bytes, 0),
  coalesce(nullif(r.image_sha256, ''), md5(r.image_object_key)),
  'Imagem do acervo legado'
from public.legacy_source_person_links l
join public.legacy_source_records r on r.record_id = l.source_record_id
where r.image_object_key is not null
  and not exists (
    select 1
    from public.person_media existing
    where existing.person_id = l.person_id
      and existing.kind in ('face', 'face_front', 'face_profile', 'legacy')
  );
