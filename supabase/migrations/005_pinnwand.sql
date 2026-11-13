-- Migration 005: Pinnwand (Blogeinträge mit Fotos)
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

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
