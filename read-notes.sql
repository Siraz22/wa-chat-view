-- Ways to read the pile in the Supabase SQL Editor.
-- The grid shows one row per line, which is why these beat a single string_agg
-- cell: that cell holds the whole file and collapses every newline into a wall.

-- 1. What has been dropped, newest first.
select
  batch_id,
  filename,
  max(parts)      as parts,
  sum(byte_size)  as bytes,
  min(created_at) as dropped_at
from public.notes
group by batch_id, filename
order by dropped_at desc;

-- 2. Read one note, one line per row. Paste a batch_id from query 1.
with note as (
  select string_agg(content, '' order by part) as body
  from public.notes
  where batch_id = 'PASTE-BATCH-ID-HERE'
)
select ord as line, txt
from note, lateral unnest(string_to_array(note.body, E'\n')) with ordinality as u(txt, ord)
order by ord;

-- 3. Same, but for the most recent drop of a given chat — no id to copy.
with latest as (
  select batch_id
  from public.notes
  where filename ilike '%Esha%'          -- change the name
  order by created_at desc
  limit 1
), note as (
  select string_agg(n.content, '' order by n.part) as body
  from public.notes n join latest l on l.batch_id = n.batch_id
)
select ord as line, txt
from note, lateral unnest(string_to_array(note.body, E'\n')) with ordinality as u(txt, ord)
order by ord;

-- 4. Only the real messages, skipping the blank lines inside multi-line notes.
with latest as (
  select batch_id from public.notes
  where filename ilike '%Esha%'
  order by created_at desc limit 1
), note as (
  select string_agg(n.content, '' order by n.part) as body
  from public.notes n join latest l on l.batch_id = n.batch_id
)
select ord as line, txt
from note, lateral unnest(string_to_array(note.body, E'\n')) with ordinality as u(txt, ord)
where btrim(txt) <> ''
order by ord;

-- 5. The whole file as one value, for copying out. Click the cell to expand it,
--    or use Download CSV. Readable in a text editor, not in the grid.
select string_agg(content, '' order by part) as full_note
from public.notes
where batch_id = 'PASTE-BATCH-ID-HERE';
