-- Migration 002: Lesedatum für den Jahres-Tracker auf der Startseite
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists finished_at date;
