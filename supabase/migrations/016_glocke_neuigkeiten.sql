-- Migration 016: Glöckchen-Neuigkeiten (neue Lieblingsbücher, abgehakte Klassiker)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Merkt sich, bis wann du die Neuigkeiten der anderen Person gesehen hast.

alter table public.profiles
  add column if not exists events_seen_at timestamptz not null default now();
