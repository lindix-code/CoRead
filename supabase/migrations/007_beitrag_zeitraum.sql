-- Migration 007: Lesezeitraum in Beiträgen (für das Layout der automatischen "abgeschlossen"-Beiträge)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.posts
  add column if not exists started_at date,
  add column if not exists finished_at date;
