-- Migration 015: Profil-Bücher (Lieblingsbücher, Buchempfehlung, Ausgeliehen)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Lieblingsbücher und Empfehlungen sieht auch die verbundene Person.
-- "Ausgeliehen" ist eine private Erinnerung und nur für dich selbst sichtbar.

create table if not exists public.profile_books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('favorite', 'recommendation', 'borrowed')),
  book_id text not null references public.books (id) on delete cascade,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (user_id, kind, book_id)
);

alter table public.profile_books enable row level security;

create policy "profile_books_select" on public.profile_books for select to authenticated
  using (
    user_id = auth.uid()
    or (kind <> 'borrowed' and public.are_friends(auth.uid(), user_id))
  );
create policy "profile_books_insert" on public.profile_books for insert to authenticated
  with check (user_id = auth.uid());
create policy "profile_books_update" on public.profile_books for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "profile_books_delete" on public.profile_books for delete to authenticated
  using (user_id = auth.uid());
