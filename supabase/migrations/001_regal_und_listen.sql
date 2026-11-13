-- Migration 001: Bücherregal (Besitz) getrennt vom Lesestatus
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Bestehende Einträge bleiben erhalten.

alter table public.library_entries
  add column if not exists owned boolean not null default false;

-- Status darf jetzt leer sein (Buch steht nur im Regal, nicht auf einer Leseliste)
alter table public.library_entries alter column status drop not null;
alter table public.library_entries alter column status drop default;
