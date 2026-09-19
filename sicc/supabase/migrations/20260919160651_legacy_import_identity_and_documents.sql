-- Archive all legacy source records; create people only for legible identities.
-- Existing people and media are not rewritten or deleted.
begin;

alter table public.people alter column cpf drop not null;
alter table public.people alter column full_name drop not null;
alter table public.people alter column created_by drop not null;
alter table public.people add column if not exists legacy_source_record_id text;
alter table public.people add column if not exists legacy_parent_record_id text;
alter table public.people add column if not exists legacy_import_manifest_sha256 text;
alter table public.people add column if not exists legacy_imported_at timestamptz;
create unique index if not exists people_legacy_source_record_id_uq
  on public.people (legacy_source_record_id) where legacy_source_record_id is not null;

alter table public.people drop constraint if exists people_legacy_identity_check;
alter table public.people add constraint people_legacy_identity_check check (
  (legacy_source_record_id is null and nullif(btrim(full_name), '') is not null) or (
    legacy_source_record_id is not null
    and
    (nullif(btrim(full_name), '') is not null or cpf ~ '^[0-9]{11}$')
    and legacy_import_manifest_sha256 ~ '^[a-f0-9]{64}$'
  )
);

alter table public.addresses add column if not exists legacy_source_record_id text;
create unique index if not exists addresses_legacy_source_record_id_uq
  on public.addresses (legacy_source_record_id) where legacy_source_record_id is not null;

create table if not exists public.legacy_source_records (
  record_id text primary key,
  source_order integer not null unique check (source_order between 1 and 11011),
  part_number smallint not null check (part_number between 1 and 37),
  record_type text not null,
  source_manifest_sha256 text not null check (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archive_object_key text not null,
  image_object_key text unique,
  image_sha256 text check (image_sha256 is null or image_sha256 ~ '^[a-f0-9]{64}$'),
  image_bytes integer check (image_bytes is null or image_bytes > 0),
  original_name text,
  display_name text,
  publication_fields jsonb not null default '{}'::jsonb,
  source_person_count integer not null default 0 check (source_person_count >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.legacy_source_person_links (
  person_id bigint not null references public.people(id) on delete cascade,
  source_record_id text not null references public.legacy_source_records(record_id) on delete restrict,
  person_record_id text not null unique,
  association_scope text not null check (association_scope in ('individual_source','shared_document_text')),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (person_id, source_record_id)
);
create index if not exists legacy_source_person_links_source_idx
  on public.legacy_source_person_links(source_record_id);

grant select on public.legacy_source_records, public.legacy_source_person_links to authenticated;
grant all on public.legacy_source_records, public.legacy_source_person_links to service_role;

alter table public.legacy_source_records enable row level security;
alter table public.legacy_source_person_links enable row level security;
drop policy if exists legacy_source_records_operator_select on public.legacy_source_records;
create policy legacy_source_records_operator_select on public.legacy_source_records
  for select to authenticated using ((select private.is_operator()));
drop policy if exists legacy_source_person_links_operator_select on public.legacy_source_person_links;
create policy legacy_source_person_links_operator_select on public.legacy_source_person_links
  for select to authenticated using ((select private.is_operator()));

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('sicc-legacy-manifests','sicc-legacy-manifests',false,5242880,array['application/gzip'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

commit;
