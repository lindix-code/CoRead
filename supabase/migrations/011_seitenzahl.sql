-- Migration 011: eigene Seitenzahl pro Buch (wenn die Datenquelle keine liefert)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.library_entries
  add column if not exists pages_total integer;
