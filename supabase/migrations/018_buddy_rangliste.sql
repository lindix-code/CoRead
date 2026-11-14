-- Migration 018: Buddy-Read-Rangliste (Platz 1 bis 3 per Drag and Drop)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.buddy_reads
  add column if not exists rank int check (rank is null or rank between 1 and 99);
