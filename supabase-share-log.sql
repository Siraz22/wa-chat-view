-- Run once in Supabase → SQL Editor.
-- Records the outcome of every share attempt, so the reader itself can stay
-- completely silent: no pill, no toast, no console line. Read this table to see
-- what landed and what did not.

create table if not exists public.share_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  status       text        not null,   -- 'ok' | 'failed'
  filename     text,
  content_hash text,                   -- join to notes.content_hash
  batch_id     uuid,
  parts        int,                    -- chunks the file was split into
  written      int,                    -- chunks actually inserted (0 = already there)
  duration_ms  int,
  error        text,                   -- null when status is 'ok'
  page_url     text,                   -- which copy of the reader was used
  user_agent   text
);

alter table public.share_log enable row level security;

create policy "anon can log"
  on public.share_log for insert
  to anon
  with check (
    status in ('ok', 'failed')
    and (filename     is null or char_length(filename)     <= 260)
    and (content_hash is null or char_length(content_hash) <= 64)
    and (error        is null or char_length(error)        <= 2000)
    and (page_url     is null or char_length(page_url)     <= 500)
    and (user_agent   is null or char_length(user_agent)   <= 400)
    and (parts   is null or parts   between 0 and 100000)
    and (written is null or written between 0 and 100000)
  );

-- As with notes: insert only. The page cannot read, edit or delete its own log.

create index if not exists share_log_created_idx on public.share_log (created_at desc);
create index if not exists share_log_hash_idx    on public.share_log (content_hash);
