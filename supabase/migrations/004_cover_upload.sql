-- Migration 004: eigene Buchcover hochladen
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

-- Eigenes Cover pro Bibliothekseintrag (überschreibt das Standard-Cover nur für dich)
alter table public.library_entries
  add column if not exists custom_cover text;

-- Öffentlicher Speicher für Cover-Bilder (max. 2 MB, nur Bilder)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Hochladen, Ändern und Löschen darf jede nur in ihrem eigenen Ordner (Ordnername = eigene User-ID)
create policy "covers_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
