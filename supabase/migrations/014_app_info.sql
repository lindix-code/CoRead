-- Migration 014: App-Infos (Support-Kontakt, Impressum) - nur für Angemeldete lesbar
-- Im Supabase SQL Editor ausführen (New query -> einfügen -> Run).
-- Die echten Daten (Adresse, Telefonnummer) kommen NICHT ins öffentliche GitHub-Repo,
-- sondern werden per SQL direkt in die Datenbank geschrieben.

create table if not exists public.app_info (
  key text primary key,
  value text not null
);

alter table public.app_info enable row level security;

create policy "app_info_select" on public.app_info for select to authenticated
  using (true);
-- Schreiben ist nur über den SQL Editor möglich (keine Policy für insert/update/delete)

insert into public.app_info (key, value) values
  ('impressum_note', E'Liebe Zaza,\n\ndiese App ist für uns beide gebaut: für jedes Buch, das wir uns ans Herz legen, für jede Seite, die wir parallel lesen, und für alles, was wir dazu sagen müssen.\n\nDanke, dass du meine Lesepartnerin bist.\n\nDeine Lindi')
on conflict (key) do nothing;
