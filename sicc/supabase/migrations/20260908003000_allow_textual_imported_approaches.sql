-- Allow historical Infoseg approaches to preserve textual evidence without inventing GPS data.
alter table public.approaches
  alter column occurred_at drop not null,
  alter column latitude drop not null,
  alter column longitude drop not null;
