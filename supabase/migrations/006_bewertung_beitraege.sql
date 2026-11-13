-- Migration 006: Sterne und automatische Beiträge auf der Pinnwand
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.posts
  add column if not exists rating smallint check (rating between 1 and 5),
  add column if not exists auto boolean not null default false;  -- automatischer "abgeschlossen"-Beitrag
