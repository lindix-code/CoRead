-- Migration 009: Glöckchen mit Zähler für neue Pinnwand-Beiträge
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

-- Zeitpunkt, bis zu dem jede:r die Pinnwand zuletzt gesehen hat
alter table public.profiles
  add column if not exists feed_seen_at timestamptz not null default now();
