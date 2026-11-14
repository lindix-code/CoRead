-- Migration 013: Gemeinsame Klassiker (wer hat welchen Klassiker gelesen)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Die Titelliste selbst steht in app.js (CLASSICS); hier wird nur gespeichert,
-- wer einen Klassiker als gelesen markiert hat. Jede Person markiert nur für sich.

create table if not exists public.classic_reads (
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  classic_id text not null check (length(classic_id) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (user_id, classic_id)
);

alter table public.classic_reads enable row level security;

create policy "classic_reads_select" on public.classic_reads for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "classic_reads_insert" on public.classic_reads for insert to authenticated
  with check (user_id = auth.uid());
create policy "classic_reads_delete" on public.classic_reads for delete to authenticated
  using (user_id = auth.uid());
