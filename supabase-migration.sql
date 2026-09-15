-- Run once in Supabase → SQL Editor, on top of the Appender project's schema.
-- Adds a content hash so re-dropping the same export is a harmless no-op
-- instead of a second copy of the whole chat.

alter table public.notes add column if not exists content_hash text;

-- Must NOT be a partial index: ON CONFLICT can only use a partial index if the
-- statement repeats the index predicate, which PostgREST cannot express.
-- Rows written before this migration have a null hash, and nulls are distinct
-- in a unique index, so they never collide with each other.
drop index if exists public.notes_dedupe_idx;

create unique index if not exists notes_dedupe_idx
  on public.notes (content_hash, part);
