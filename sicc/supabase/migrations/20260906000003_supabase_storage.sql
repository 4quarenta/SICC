-- Media is kept in a private Supabase Storage bucket. The API Edge Function
-- uses the service role to authorize reads and writes; the browser never gets
-- a public object URL or a storage secret.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sicc-media', 'sicc-media', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Keep direct browser access closed. The Edge Function signs short-lived URLs
-- after checking the Supabase access token and operator profile.
drop policy if exists sicc_media_no_direct_access on storage.objects;
create policy sicc_media_no_direct_access on storage.objects
for all to anon, authenticated
using (false)
with check (false);
