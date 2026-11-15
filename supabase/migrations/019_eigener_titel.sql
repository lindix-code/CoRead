-- Migration 019: Eigener Titel pro Buch (wie das eigene Cover, nur für dein Regal)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists custom_title text check (custom_title is null or char_length(custom_title) between 1 and 200);
