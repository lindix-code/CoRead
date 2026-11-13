-- Migration 008: Hörbuch-Kennzeichnung
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists audiobook boolean not null default false;
