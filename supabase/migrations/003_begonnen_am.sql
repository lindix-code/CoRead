-- Migration 003: Startdatum ("Begonnen am") zusätzlich zum Enddatum
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists started_at date;
