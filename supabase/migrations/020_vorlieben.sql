-- Migration 020: Vorlieben im Profil (Lieblingsautoren, Interessen & Genres) als Grundlage für Buchempfehlungen
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).

alter table public.profiles
  add column if not exists favorite_authors text[] not null default '{}'
    check (coalesce(array_length(favorite_authors, 1), 0) <= 40),
  add column if not exists interests text[] not null default '{}'
    check (coalesce(array_length(interests, 1), 0) <= 60);
