-- Migration 021: Feedback zu Buchempfehlungen ("Für dich")
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

create table if not exists public.rec_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  book_key text not null,                          -- Kurzschlüssel aus Titel + Autor (zum Ausblenden)
  title text not null,
  authors text[] not null default '{}',
  source text,                                     -- friend | rated | fav | genre
  category text not null,                          -- Grund (z. B. Falsche Sprache)
  note text check (note is null or char_length(note) <= 500),
  block_author boolean not null default false,     -- Autor nicht mehr vorschlagen
  created_at timestamptz not null default now()
);

alter table public.rec_feedback enable row level security;

create policy "rec_feedback_select" on public.rec_feedback for select to authenticated
  using (user_id = auth.uid());
create policy "rec_feedback_insert" on public.rec_feedback for insert to authenticated
  with check (user_id = auth.uid());
create policy "rec_feedback_delete" on public.rec_feedback for delete to authenticated
  using (user_id = auth.uid());
