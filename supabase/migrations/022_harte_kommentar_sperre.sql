-- Migration 022: Harte Sperre für Buddy-Read-Kommentare
-- Kommentare der anderen Person zu einer Seite, die du noch nicht erreicht hast,
-- liefert die Datenbank gar nicht erst aus. Im Supabase SQL Editor ausführen
-- (New query -> einfügen -> Run).

-- Bis zu welcher Seite hat jemand ein Buch gelesen? (fertig = unbegrenzt)
create or replace function public.reader_page(p_user uuid, p_book text)
returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when le.status = 'read' then 1000000000::numeric
    when le.progress_mode = 'percent' and coalesce(le.pages_total, b.pages) > 0
      then round(coalesce(le.progress_percent, 0)::numeric / 100 * coalesce(le.pages_total, b.pages))
    when le.progress_mode = 'chapter' and le.chapters_total > 0 and coalesce(le.pages_total, b.pages) > 0
      then round(coalesce(le.progress_chapter, 0)::numeric / le.chapters_total * coalesce(le.pages_total, b.pages))
    else coalesce(le.progress_page, 0)::numeric
  end
  from public.library_entries le
  join public.books b on b.id = le.book_id
  where le.user_id = p_user and le.book_id = p_book
$$;

revoke execute on function public.reader_page(uuid, text) from public, anon;
grant execute on function public.reader_page(uuid, text) to authenticated;

-- Eigene Kommentare immer; die der anderen Person nur ohne Seite oder bis zu deiner Seite
drop policy if exists "buddy_comments_select" on public.buddy_comments;
create policy "buddy_comments_select" on public.buddy_comments for select to authenticated
  using (
    user_id = auth.uid()
    or (
      public.are_friends(auth.uid(), user_id)
      and (
        page is null
        or page <= coalesce(
          public.reader_page(auth.uid(), (select r.book_id from public.buddy_reads r where r.id = read_id)),
          0
        )
      )
    )
  );

-- Wie viele Kommentare sind noch gesperrt (nur Seite und Anzahl, kein Text)?
create or replace function public.buddy_locked_counts(p_read uuid)
returns table (page int, n bigint)
language sql stable security definer set search_path = public as $$
  select c.page, count(*)
  from public.buddy_comments c
  join public.buddy_reads r on r.id = c.read_id
  where c.read_id = p_read
    and c.user_id <> auth.uid()
    and public.are_friends(auth.uid(), c.user_id)
    and c.page is not null
    and c.page > coalesce(public.reader_page(auth.uid(), r.book_id), 0)
  group by c.page
  order by c.page
$$;

revoke execute on function public.buddy_locked_counts(uuid) from public, anon;
grant execute on function public.buddy_locked_counts(uuid) to authenticated;
