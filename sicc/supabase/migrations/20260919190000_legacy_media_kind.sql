begin;

alter table public.person_media drop constraint if exists person_media_kind_check;
alter table public.person_media add constraint person_media_kind_check
  check (kind in ('face', 'face_front', 'face_profile', 'tattoo', 'legacy'));

commit;
