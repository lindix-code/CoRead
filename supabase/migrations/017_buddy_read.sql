-- Migration 017: Buddy Read (gemeinsam ein Buch lesen, abstimmen, kommentieren)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Alles ist für euch beide sichtbar. Kommentare tragen eine Seitenzahl für den Spoilerschutz.

create table if not exists public.buddy_reads (
  id uuid primary key default gen_random_uuid(),
  book_id text not null unique references public.books (id) on delete cascade,
  status text not null default 'proposed' check (status in ('proposed', 'active', 'done')),
  proposed_by uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.buddy_votes (
  read_id uuid not null references public.buddy_reads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  vote boolean not null,
  created_at timestamptz not null default now(),
  primary key (read_id, user_id)
);

create table if not exists public.buddy_comments (
  id uuid primary key default gen_random_uuid(),
  read_id uuid not null references public.buddy_reads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  body text not null check (length(body) between 1 and 1000),
  page int check (page is null or page >= 0),
  created_at timestamptz not null default now()
);

alter table public.buddy_reads enable row level security;
alter table public.buddy_votes enable row level security;
alter table public.buddy_comments enable row level security;

create policy "buddy_reads_select" on public.buddy_reads for select to authenticated
  using (proposed_by = auth.uid() or public.are_friends(auth.uid(), proposed_by));
create policy "buddy_reads_insert" on public.buddy_reads for insert to authenticated
  with check (proposed_by = auth.uid());
create policy "buddy_reads_update" on public.buddy_reads for update to authenticated
  using (proposed_by = auth.uid() or public.are_friends(auth.uid(), proposed_by))
  with check (proposed_by = auth.uid() or public.are_friends(auth.uid(), proposed_by));
create policy "buddy_reads_delete" on public.buddy_reads for delete to authenticated
  using (proposed_by = auth.uid() or public.are_friends(auth.uid(), proposed_by));

create policy "buddy_votes_select" on public.buddy_votes for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "buddy_votes_insert" on public.buddy_votes for insert to authenticated
  with check (user_id = auth.uid());
create policy "buddy_votes_update" on public.buddy_votes for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "buddy_votes_delete" on public.buddy_votes for delete to authenticated
  using (user_id = auth.uid());

create policy "buddy_comments_select" on public.buddy_comments for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "buddy_comments_insert" on public.buddy_comments for insert to authenticated
  with check (user_id = auth.uid());
create policy "buddy_comments_delete" on public.buddy_comments for delete to authenticated
  using (user_id = auth.uid());
