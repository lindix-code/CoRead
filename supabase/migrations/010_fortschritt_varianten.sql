-- Migration 010: Fortschritt wahlweise in Seiten, Kapiteln oder Prozent
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists progress_mode text,
  add column if not exists progress_chapter integer,
  add column if not exists chapters_total integer,
  add column if not exists progress_percent integer;
