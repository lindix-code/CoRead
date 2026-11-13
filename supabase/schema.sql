-- CoRead – Datenbank-Schema für Supabase
-- Einmalig im Supabase-Dashboard ausführen: SQL Editor -> New query -> einfügen -> Run.
-- Alle Tabellen sind durch Row Level Security (RLS) geschützt:
--   * Eigene Daten kann nur man selbst ändern.
--   * Lesen darf man eigene Daten und die der verbundenen Freundin.
--   * Niemand sonst sieht etwas.

-- ---------- Profile ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Leseratte',
  invite_code text not null unique
    default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  created_at timestamptz not null default now(),
  feed_seen_at timestamptz not null default now()
);

-- Beim Registrieren automatisch ein Profil anlegen
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Leseratte')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Freundschaft (Verbindung zwischen zwei Personen) ----------
create table public.friendships (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships
    where user_a = least(a, b) and user_b = greatest(a, b)
  );
$$;

-- Verbindung über den Einladungscode der anderen Person herstellen
create function public.connect_with_code(code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  other uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select id into other from public.profiles where invite_code = upper(trim(code));
  if other is null then
    raise exception 'Code nicht gefunden';
  end if;
  if other = auth.uid() then
    raise exception 'Das ist dein eigener Code';
  end if;
  insert into public.friendships (user_a, user_b)
  values (least(auth.uid(), other), greatest(auth.uid(), other))
  on conflict do nothing;
end;
$$;

revoke execute on function public.are_friends(uuid, uuid) from public, anon;
revoke execute on function public.connect_with_code(text) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;
grant execute on function public.connect_with_code(text) to authenticated;

-- ---------- Bücher (gemeinsamer Katalog) ----------
create table public.books (
  id text primary key,               -- Google-Books-ID
  title text not null,
  subtitle text,
  authors text[] not null default '{}',
  publisher text,
  published_date text,
  pages int,
  language text,
  categories text[] not null default '{}',
  description text,
  isbn text,
  cover text,
  created_at timestamptz not null default now()
);

-- ---------- Bibliothek + Lesestatus + Bewertung ----------
create table public.library_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  book_id text not null references public.books (id),
  status text check (status in ('want', 'reading', 'read')),  -- leer = nur im Regal
  audiobook boolean not null default false,                   -- Hörbuch
  owned boolean not null default false,                       -- steht im Bücherregal
  progress_page int check (progress_page >= 0),
  progress_mode text,                                         -- 'page' | 'chapter' | 'percent'
  progress_chapter int,
  chapters_total int,
  progress_percent int,
  pages_total int,                                            -- eigene Seitenzahl, falls die Datenquelle keine hat
  rating smallint check (rating between 1 and 5),
  custom_cover text,                                          -- eigenes Cover (URL im Storage)
  started_at date,                                            -- Begonnen am
  finished_at date,                                           -- Lesedatum (für den Jahres-Tracker)
  added_at timestamptz not null default now(),
  unique (user_id, book_id)
);

-- ---------- Kommentare ----------
create table public.book_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  book_id text not null references public.books (id),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- ---------- Top-Listen ----------
create table public.reading_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  title text not null check (length(title) between 1 and 120),
  description text,
  created_at timestamptz not null default now()
);

create table public.list_items (
  list_id uuid not null references public.reading_lists (id) on delete cascade,
  book_id text not null references public.books (id),
  position int not null default 0,
  primary key (list_id, book_id)
);

-- ---------- Row Level Security ----------
alter table public.profiles        enable row level security;
alter table public.friendships     enable row level security;
alter table public.books           enable row level security;
alter table public.library_entries enable row level security;
alter table public.book_comments   enable row level security;
alter table public.reading_lists   enable row level security;
alter table public.list_items      enable row level security;

-- Profile: eigenes und das der Freundin lesen, nur das eigene ändern
create policy "profiles_select" on public.profiles for select to authenticated
  using (id = auth.uid() or public.are_friends(auth.uid(), id));
create policy "profiles_update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Freundschaft: nur lesen, Anlegen geht ausschließlich über connect_with_code()
create policy "friendships_select" on public.friendships for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- Bücher: alle Angemeldeten dürfen lesen und neue Bücher hinzufügen, aber nichts ändern
create policy "books_select" on public.books for select to authenticated using (true);
create policy "books_insert" on public.books for insert to authenticated with check (true);

-- Bibliothek
create policy "library_select" on public.library_entries for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "library_insert" on public.library_entries for insert to authenticated
  with check (user_id = auth.uid());
create policy "library_update" on public.library_entries for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "library_delete" on public.library_entries for delete to authenticated
  using (user_id = auth.uid());

-- Kommentare
create policy "comments_select" on public.book_comments for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "comments_insert" on public.book_comments for insert to authenticated
  with check (user_id = auth.uid());
create policy "comments_delete" on public.book_comments for delete to authenticated
  using (user_id = auth.uid());

-- Listen
create policy "lists_select" on public.reading_lists for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "lists_insert" on public.reading_lists for insert to authenticated
  with check (user_id = auth.uid());
create policy "lists_update" on public.reading_lists for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "lists_delete" on public.reading_lists for delete to authenticated
  using (user_id = auth.uid());

create policy "list_items_select" on public.list_items for select to authenticated
  using (exists (
    select 1 from public.reading_lists l
    where l.id = list_id
      and (l.user_id = auth.uid() or public.are_friends(auth.uid(), l.user_id))
  ));
create policy "list_items_write" on public.list_items for all to authenticated
  using (exists (select 1 from public.reading_lists l where l.id = list_id and l.user_id = auth.uid()))
  with check (exists (select 1 from public.reading_lists l where l.id = list_id and l.user_id = auth.uid()));

-- ---------- Storage für eigene Cover ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "covers_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Pinnwand (Migration 005) ----------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  title text check (title is null or length(title) <= 120),
  body text not null check (length(body) between 1 and 5000),
  images text[] not null default '{}' check (coalesce(array_length(images, 1), 0) <= 4),
  book_id text references public.books (id),
  created_at timestamptz not null default now()
);

create index posts_created_idx on public.posts (created_at desc);

alter table public.posts enable row level security;

-- Lesen: eigene Einträge und die der verbundenen Freundin. Ändern/Löschen: nur eigene.
create policy "posts_select" on public.posts for select to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));
create policy "posts_insert" on public.posts for insert to authenticated
  with check (user_id = auth.uid());
create policy "posts_update" on public.posts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "posts_delete" on public.posts for delete to authenticated
  using (user_id = auth.uid());

-- Privater Speicher für Fotos (max. 3 MB pro Bild). Die App zeigt sie über zeitlich begrenzte Links.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Ordnername = User-ID des Besitzers. Lesen dürfen Besitzerin und verbundene Freundin.
create policy "post_images_select" on storage.objects for select to authenticated
  using (
    bucket_id = 'post-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.are_friends(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  );
create policy "post_images_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "post_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Sterne und automatische Beiträge (Migration 006) ----------
alter table public.posts
  add column if not exists rating smallint check (rating between 1 and 5),
  add column if not exists auto boolean not null default false;

-- ---------- Lesezeitraum in Beiträgen (Migration 007) ----------
alter table public.posts
  add column if not exists started_at date,
  add column if not exists finished_at date;
