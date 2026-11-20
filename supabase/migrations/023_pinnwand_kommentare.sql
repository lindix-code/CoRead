-- Migration 023: Kommentare unter Pinnwand-Beiträgen
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  body text not null check (length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists post_comments_post_idx on public.post_comments (post_id, created_at);

alter table public.post_comments enable row level security;

-- Lesen und Schreiben darf, wer den Beitrag sehen darf (eigene Beiträge und die der verbundenen Freundin).
-- Löschen: nur eigene Kommentare.
create policy "post_comments_select" on public.post_comments for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));
create policy "post_comments_insert" on public.post_comments for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.posts p where p.id = post_id));
create policy "post_comments_delete" on public.post_comments for delete to authenticated
  using (user_id = auth.uid());
