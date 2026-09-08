-- Preserve the import/creation time for historical approaches that lacked a reported date.
update public.approaches
set occurred_at = created_at
where occurred_at is null;
