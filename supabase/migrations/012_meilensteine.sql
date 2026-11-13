-- Migration 012: Lese-Meilensteine (Zeitraum + Anzahl Bücher)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

create table if not exists public.reading_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  period_start date not null,
  period_end date not null,
  target int not null check (target between 1 and 1000),
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

alter table public.reading_goals enable row level security;

create policy "goals_select" on public.reading_goals for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "goals_insert" on public.reading_goals for insert to authenticated
  with check (user_id = auth.uid());
create policy "goals_update" on public.reading_goals for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "goals_delete" on public.reading_goals for delete to authenticated
  using (user_id = auth.uid());
