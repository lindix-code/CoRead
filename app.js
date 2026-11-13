// CoRead
// - Buchsuche: Google Books API (Metadaten + Cover), Open Library als Cover-Fallback
// - Login, Bibliothek, Lesestatus, Bewertung und Verbindung zur Freundin: Supabase

const GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes";
const STATUS = { want: "Möchte ich lesen", reading: "Lese ich gerade", read: "Gelesen" };

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

let me = null; // eigenes Profil
let friend = null; // Profil der Freundin (oder null)
let myLibrary = []; // meine Bücher inkl. entry
let libView = "mine"; // "mine" | "friend"
let libList = "reading"; // aktive Unterliste in der Bibliothek

// Unterlisten der Bibliothek: [Schlüssel, Name, Filter]
const LISTS = [
  ["shelf", "Mein Bücherregal", (b) => b.entry.owned],
  ["reading", "Lese ich gerade", (b) => b.entry.status === "reading"],
  ["read", "Abgeschlossen", (b) => b.entry.status === "read"],
  ["want", "Möchte ich lesen", (b) => b.entry.status === "want"],
];

// ---------- Buchsuche ----------

function isIsbn(text) {
  const digits = text.replace(/[-\s]/g, "");
  return /^(\d{9}[\dXx]|\d{13})$/.test(digits);
}

function buildQuery(input) {
  const text = input.trim();
  if (isIsbn(text)) return "isbn:" + text.replace(/[-\s]/g, "");
  return text;
}

function openLibraryCover(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
}

// Google-Books-Antwort -> unser einfaches Buchformat
function toBook(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn13 = (ids.find((i) => i.type === "ISBN_13") || {}).identifier;
  const isbn10 = (ids.find((i) => i.type === "ISBN_10") || {}).identifier;
  const isbn = isbn13 || isbn10 || null;

  const links = v.imageLinks || {};
  let cover = links.thumbnail || links.smallThumbnail || null;
  if (cover) cover = cover.replace("http://", "https://");
  if (!cover && isbn) cover = openLibraryCover(isbn);

  return {
    id: item.id,
    title: v.title || "Ohne Titel",
    subtitle: v.subtitle || "",
    authors: v.authors || [],
    publisher: v.publisher || "",
    publishedDate: v.publishedDate || "",
    pages: v.pageCount || null,
    language: v.language || "",
    categories: v.categories || [],
    description: v.description || "",
    isbn,
    cover,
    fallbackCover: isbn ? openLibraryCover(isbn) : null,
  };
}

async function searchGoogle(input, lang) {
  const params = new URLSearchParams({
    q: buildQuery(input),
    maxResults: "20",
    printType: "books",
  });
  if (lang) params.set("langRestrict", lang);
  if (typeof GOOGLE_BOOKS_KEY !== "undefined" && GOOGLE_BOOKS_KEY) params.set("key", GOOGLE_BOOKS_KEY);
  const res = await fetch(`${GOOGLE_BOOKS_URL}?${params}`);
  if (!res.ok) throw new Error(`Google Books Fehler ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(toBook);
}

// Ersatzquelle, falls Google Books nicht antwortet (z. B. wegen Anfragelimit)
async function searchOpenLibrary(input, lang) {
  const text = input.trim();
  const params = new URLSearchParams({
    limit: "20",
    fields:
      "key,title,subtitle,author_name,publisher,first_publish_year,number_of_pages_median,language,subject,isbn,cover_i",
  });
  if (isIsbn(text)) params.set("q", "isbn:" + text.replace(/[-\s]/g, ""));
  else params.set("q", text);
  if (lang) params.set("lang", lang);
  const res = await fetch(`https://openlibrary.org/search.json?${params}`);
  if (!res.ok) throw new Error(`Open Library Fehler ${res.status}`);
  const data = await res.json();
  return (data.docs || []).map((d) => {
    const isbn = (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || null;
    const cover = d.cover_i
      ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
      : isbn
        ? openLibraryCover(isbn)
        : null;
    return {
      id: "ol:" + d.key,
      title: d.title || "Ohne Titel",
      subtitle: d.subtitle || "",
      authors: d.author_name || [],
      publisher: (d.publisher || [])[0] || "",
      publishedDate: d.first_publish_year ? String(d.first_publish_year) : "",
      pages: d.number_of_pages_median || null,
      language: (d.language || [])[0] || "",
      categories: (d.subject || []).slice(0, 3),
      description: "",
      isbn,
      cover,
      fallbackCover: isbn ? openLibraryCover(isbn) : null,
    };
  });
}

async function searchBooks(input, lang) {
  try {
    const books = await searchGoogle(input, lang);
    // Bei Sprachfilter ohne Treffer: ohne Filter nochmal versuchen
    if (!books.length && lang) return await searchGoogle(input, "");
    return books;
  } catch (googleError) {
    try {
      return await searchOpenLibrary(input, lang);
    } catch (openLibraryError) {
      throw new Error(
        `Die Suche ist gerade nicht erreichbar (${googleError.message}; ${openLibraryError.message}).`
      );
    }
  }
}

// ---------- Datenbank (Supabase) ----------

function dbToBook(b) {
  return {
    id: b.id,
    title: b.title,
    subtitle: b.subtitle || "",
    authors: b.authors || [],
    publisher: b.publisher || "",
    publishedDate: b.published_date || "",
    pages: b.pages,
    language: b.language || "",
    categories: b.categories || [],
    description: b.description || "",
    isbn: b.isbn,
    cover: b.cover,
    fallbackCover: b.isbn ? openLibraryCover(b.isbn) : null,
  };
}

function bookToDb(book) {
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle || null,
    authors: book.authors,
    publisher: book.publisher || null,
    published_date: book.publishedDate || null,
    pages: book.pages,
    language: book.language || null,
    categories: book.categories,
    description: book.description || null,
    isbn: book.isbn,
    cover: book.cover,
  };
}

async function fetchLibrary(userId) {
  const { data, error } = await sb
    .from("library_entries")
    .select("status, owned, started_at, finished_at, progress_page, rating, books(*)")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    ...dbToBook(r.books),
    entry: {
      status: r.status,
      owned: r.owned,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      progress: r.progress_page,
      rating: r.rating,
    },
  }));
}

async function saveEntry(book, entry) {
  // Buch im gemeinsamen Katalog ablegen (falls noch nicht vorhanden)
  const { error: bookError } = await sb
    .from("books")
    .upsert(bookToDb(book), { onConflict: "id", ignoreDuplicates: true });
  if (bookError) throw bookError;

  const { error } = await sb.from("library_entries").upsert(
    {
      user_id: me.id,
      book_id: book.id,
      status: entry.status,
      owned: entry.owned,
      started_at: entry.startedAt,
      finished_at: entry.finishedAt,
      progress_page: entry.progress,
      rating: entry.rating,
    },
    { onConflict: "user_id,book_id" }
  );
  if (error) throw error;
}

async function removeEntry(bookId) {
  const { error } = await sb
    .from("library_entries")
    .delete()
    .eq("user_id", me.id)
    .eq("book_id", bookId);
  if (error) throw error;
}

async function reloadMyLibrary() {
  myLibrary = await fetchLibrary(me.id);
}

async function loadFriend() {
  friend = null;
  const { data, error } = await sb.from("friendships").select("user_a, user_b");
  if (error || !data.length) return;
  const row = data[0];
  const friendId = row.user_a === me.id ? row.user_b : row.user_a;
  const { data: profile } = await sb.from("profiles").select("*").eq("id", friendId).single();
  friend = profile || null;
}

// ---------- Anzeige-Helfer ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function coverElement(book) {
  if (!book.cover) return el("div", { className: "cover-placeholder" }, "Kein Cover");
  const img = el("img", { src: book.cover, alt: "Cover: " + book.title, loading: "lazy" });
  img.onerror = () => {
    if (book.fallbackCover && img.src !== book.fallbackCover) {
      img.src = book.fallbackCover;
    } else {
      img.replaceWith(el("div", { className: "cover-placeholder" }, "Kein Cover"));
    }
  };
  return img;
}

function entryLine(book) {
  const e = book.entry;
  if (!e) return "";
  const parts = [];
  if (e.status) {
    let text = STATUS[e.status];
    if (e.status === "reading" && e.progress != null) {
      text += book.pages ? ` (S. ${e.progress}/${book.pages})` : ` (S. ${e.progress})`;
    }
    parts.push(text);
  }
  if (e.owned) parts.push("Im Regal");
  if (e.rating) parts.push("★".repeat(e.rating));
  return parts.join(" · ");
}

function bookCard(book, readOnly) {
  const card = el("button", { className: "card", type: "button" });
  card.append(
    coverElement(book),
    el("div", { className: "title" }, book.title),
    el("div", { className: "author" }, book.authors.join(", "))
  );
  const line = entryLine(book);
  if (line) card.append(el("div", { className: "meta" }, line));
  card.onclick = () => showDetail(book, readOnly);
  return card;
}

function renderGrid(container, books, readOnly = false) {
  container.replaceChildren(...books.map((b) => bookCard(b, readOnly)));
}

function fact(label, value) {
  if (!value) return null;
  return el("div", {}, `${label}: ${value}`);
}

function selectField(label, id, options, value) {
  const select = el("select", { id });
  for (const [val, text] of options) {
    const opt = el("option", { value: val }, text);
    if (String(val) === String(value ?? "")) opt.selected = true;
    select.append(opt);
  }
  return el("label", { className: "field" }, label, select);
}

function showDetail(book, readOnly = false) {
  // Falls das Buch schon in meiner Bibliothek ist, den gespeicherten Stand zeigen
  const mine = myLibrary.find((b) => b.id === book.id);
  const entry = readOnly ? book.entry : mine && mine.entry;

  const top = el(
    "div",
    { className: "detail-top" },
    coverElement(book),
    el(
      "div",
      {},
      el("h2", {}, book.title),
      el("div", { className: "author" }, book.authors.join(", ")),
      el(
        "div",
        { className: "facts" },
        ...[
          fact("Untertitel", book.subtitle),
          fact("Verlag", book.publisher),
          fact("Erschienen", book.publishedDate),
          fact("Seiten", book.pages),
          fact("Sprache", book.language),
          fact("Genre", book.categories.join(", ")),
          fact("ISBN", book.isbn),
        ].filter(Boolean)
      )
    )
  );

  // Beschreibungen von Google können HTML enthalten – wir zeigen nur reinen Text.
  const tmp = document.createElement("div");
  tmp.innerHTML = book.description;
  const description = el("p", { className: "description" });
  description.textContent = tmp.textContent || "Keine Beschreibung vorhanden.";

  const content = el("div", { className: "detail" }, top, description);

  if (readOnly) {
    const line = entryLine(book);
    if (line) content.append(el("p", { className: "meta" }, `${friend ? friend.display_name : ""}: ${line}`));
  } else {
    const statusField = selectField(
      "Status",
      "f-status",
      [["", "Keine Leseliste"], ...Object.entries(STATUS)],
      entry ? entry.status : "want"
    );
    const ownedBox = el("input", { id: "f-owned", type: "checkbox", checked: !!(entry && entry.owned) });
    const ownedField = el("label", { className: "check" }, ownedBox, " In meinem Bücherregal");
    const startedField = el(
      "label",
      { className: "field" },
      "Begonnen am",
      el("input", { id: "f-started", type: "date", value: (entry && entry.startedAt) || "" })
    );
    const finishedField = el(
      "label",
      { className: "field" },
      "Beendet am",
      el("input", { id: "f-finished", type: "date", value: (entry && entry.finishedAt) || "" })
    );
    const statusSelect = statusField.querySelector("select");
    const updateDateFields = () => {
      startedField.hidden = !["reading", "read"].includes(statusSelect.value);
      finishedField.hidden = statusSelect.value !== "read";
    };
    updateDateFields();
    statusSelect.onchange = updateDateFields;
    const progressField = el("label", { className: "field" }, "Aktuelle Seite");
    const progress = el("input", {
      id: "f-progress",
      type: "number",
      min: "0",
      value: entry && entry.progress != null ? entry.progress : "",
    });
    if (book.pages) progress.max = String(book.pages);
    progressField.append(progress);
    const ratingField = selectField(
      "Bewertung",
      "f-rating",
      [["", "–"], ...[1, 2, 3, 4, 5].map((n) => [n, "★".repeat(n)])],
      entry ? entry.rating : ""
    );

    const saveBtn = el("button", { className: "btn", type: "button" }, entry ? "Speichern" : "Zur Bibliothek");
    const msg = el("p", { role: "status", className: "meta" });
    saveBtn.onclick = async () => {
      const status = $("f-status").value || null;
      const owned = $("f-owned").checked;
      if (!status && !owned) {
        msg.textContent = "Wähle eine Leseliste oder setze den Haken für das Bücherregal.";
        return;
      }
      saveBtn.disabled = true;
      try {
        await saveEntry(book, {
          status,
          owned,
          startedAt:
            status === "reading" || status === "read"
              ? $("f-started").value || (status === "reading" ? todayLocal() : null)
              : null,
          finishedAt: status === "read" ? $("f-finished").value || todayLocal() : null,
          progress: $("f-progress").value === "" ? null : Number($("f-progress").value),
          rating: $("f-rating").value === "" ? null : Number($("f-rating").value),
        });
        await reloadMyLibrary();
        $("detail").close();
        renderLibrary();
        renderHome();
      } catch (err) {
        msg.textContent = "Speichern hat nicht geklappt: " + err.message;
        saveBtn.disabled = false;
      }
    };

    const actions = el("div", { className: "actions" }, saveBtn);
    if (entry) {
      const removeBtn = el("button", { className: "btn secondary", type: "button" }, "Entfernen");
      removeBtn.onclick = async () => {
        try {
          await removeEntry(book.id);
          await reloadMyLibrary();
          $("detail").close();
          renderLibrary();
          renderHome();
        } catch (err) {
          msg.textContent = "Entfernen hat nicht geklappt: " + err.message;
        }
      };
      actions.append(removeBtn);
    }
    content.append(statusField, startedField, finishedField, ownedField, progressField, ratingField, actions, msg);
  }

  $("detail-content").replaceChildren(content);
  $("detail").showModal();
}

// ---------- Bibliothek ----------

async function renderLibrary() {
  $("lib-mine").className = libView === "mine" ? "btn" : "btn secondary";
  $("lib-friend").className = libView === "friend" ? "btn" : "btn secondary";
  $("lib-friend").hidden = !friend;
  if (friend) $("lib-friend").textContent = friend.display_name;

  if (libView === "mine") {
    renderLists(myLibrary, false);
  } else if (friend) {
    $("lib-lists").replaceChildren();
    $("library").replaceChildren();
    $("library-status").textContent = "Lade …";
    try {
      renderLists(await fetchLibrary(friend.id), true);
    } catch (err) {
      $("library-status").textContent = "Konnte die Bibliothek nicht laden.";
    }
  }
}

// Zeigt die Unterlisten (Regal, Lese ich gerade, Abgeschlossen, Möchte ich lesen)
function renderLists(books, readOnly) {
  const buttons = LISTS.map(([key, label, test]) => {
    const count = books.filter(test).length;
    const btn = el(
      "button",
      { className: key === libList ? "btn" : "btn secondary", type: "button" },
      `${label} (${count})`
    );
    btn.onclick = () => {
      libList = key;
      renderLists(books, readOnly);
    };
    return btn;
  });
  $("lib-lists").replaceChildren(...buttons);

  const [, label, test] = LISTS.find(([key]) => key === libList);
  const shown = books.filter(test);
  const who = readOnly && friend ? friend.display_name + ": " : "";
  $("library-status").textContent = shown.length
    ? `${who}${label}`
    : `${who}Noch nichts in „${label}“.`;
  renderGrid($("library"), shown, readOnly);
}

// ---------- Startseite ----------

let homeBookId = null;

function todayLocal() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function renderHome() {
  const reading = myLibrary.filter((b) => b.entry.status === "reading");
  const hero = $("home-hero");

  if (!reading.length) {
    const searchBtn = el("button", { className: "btn", type: "button" }, "Buch suchen");
    searchBtn.onclick = () => showTab("search");
    hero.replaceChildren(
      el("div", { className: "hero empty" }, el("p", {}, "Du liest gerade kein Buch."), searchBtn)
    );
  } else {
    const book = reading.find((b) => b.id === homeBookId) || reading[0];
    homeBookId = book.id;
    const page = book.entry.progress || 0;
    const pct = book.pages ? Math.min(100, Math.round((page / book.pages) * 100)) : null;

    const fill = el("div", { className: "bar-fill" });
    fill.style.width = (pct || 0) + "%";
    const bar = el("div", { className: "bar" }, fill);
    const progressText = el(
      "div",
      { className: "progress-text" },
      pct != null ? `Seite ${page} von ${book.pages} · ${pct} %` : `Seite ${page}`
    );

    const input = el("input", { type: "number", min: "0", value: page, "aria-label": "Aktuelle Seite" });
    if (book.pages) input.max = String(book.pages);
    const saveBtn = el("button", { className: "btn", type: "button" }, "Seite speichern");
    const detailBtn = el("button", { className: "btn secondary", type: "button" }, "Details");
    const msg = el("div", { className: "meta", role: "status" });
    saveBtn.onclick = async () => {
      if (input.value === "") return;
      saveBtn.disabled = true;
      try {
        await saveEntry(book, { ...book.entry, progress: Number(input.value) });
        await reloadMyLibrary();
        renderHome();
      } catch (err) {
        msg.textContent = "Speichern hat nicht geklappt: " + err.message;
        saveBtn.disabled = false;
      }
    };
    detailBtn.onclick = () => showDetail(book);

    const info = el(
      "div",
      { className: "hero-info" },
      el("div", { className: "hero-label" }, "Ich lese gerade"),
      el("h2", {}, book.title),
      el("div", { className: "author" }, book.authors.join(", ")),
      bar,
      progressText,
      el("div", { className: "actions" }, input, saveBtn, detailBtn),
      msg
    );

    const parts = [el("div", { className: "hero" }, el("div", { className: "hero-cover" }, coverElement(book)), info)];

    if (reading.length > 1) {
      const chips = reading.map((b) => {
        const chip = el(
          "button",
          { className: b.id === book.id ? "btn" : "btn secondary", type: "button" },
          b.title.length > 28 ? b.title.slice(0, 27) + "…" : b.title
        );
        chip.onclick = () => {
          homeBookId = b.id;
          renderHome();
        };
        return chip;
      });
      parts.push(el("div", { className: "actions subtabs" }, ...chips));
    }
    hero.replaceChildren(...parts);
  }

  const owned = myLibrary.filter((b) => b.entry.owned).length;
  $("shelf-count").textContent = owned;
  $("shelf-sub").textContent =
    myLibrary.length === 1 ? "1 Buch insgesamt eingetragen" : `${myLibrary.length} Bücher insgesamt eingetragen`;

  const year = String(new Date().getFullYear());
  $("year-label").textContent = `Gelesen ${year}`;
  $("year-count").textContent = booksReadIn(year).length;
  renderYearOverview();
}

let yearOpen = false;

// Bücher, die im angegebenen Jahr beendet wurden (neueste zuerst)
function booksReadIn(year) {
  return myLibrary
    .filter((b) => b.entry.status === "read" && b.entry.finishedAt && b.entry.finishedAt.startsWith(year))
    .sort((a, b) => b.entry.finishedAt.localeCompare(a.entry.finishedAt));
}

function formatDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function readingPeriod(entry) {
  if (!entry.finishedAt) return "";
  if (!entry.startedAt) return `Beendet am ${formatDate(entry.finishedAt)}`;
  const days = Math.round(
    (new Date(entry.finishedAt) - new Date(entry.startedAt)) / 86400000
  ) + 1;
  const dur = days > 0 ? ` (${days} ${days === 1 ? "Tag" : "Tage"})` : "";
  return `${formatDate(entry.startedAt)} – ${formatDate(entry.finishedAt)}${dur}`;
}

function renderYearOverview() {
  const box = $("year-overview");
  $("tile-year").setAttribute("aria-expanded", String(yearOpen));
  box.hidden = !yearOpen;
  if (!yearOpen) return;

  const year = String(new Date().getFullYear());
  const books = booksReadIn(year);
  if (!books.length) {
    box.replaceChildren(
      el("p", { className: "meta" }, `Noch kein Buch in ${year} beendet. Gezählt werden Bücher mit Status „Gelesen“ und Datum „Beendet am“.`)
    );
    return;
  }
  const rows = books.map((book) => {
    const row = el("button", { className: "row", type: "button" });
    const cover = el("div", { className: "row-cover" }, coverElement(book));
    const info = el(
      "div",
      { className: "row-info" },
      el("div", { className: "title" }, book.title),
      el("div", { className: "author" }, book.authors.join(", ")),
      el("div", { className: "meta" }, readingPeriod(book.entry)),
      book.entry.rating ? el("div", { className: "meta" }, "★".repeat(book.entry.rating)) : ""
    );
    row.append(cover, info);
    row.onclick = () => showDetail(book);
    return row;
  });
  box.replaceChildren(el("h3", {}, `Gelesen ${year}: ${books.length} ${books.length === 1 ? "Buch" : "Bücher"}`), ...rows);
}

$("tile-shelf").onclick = () => {
  libView = "mine";
  libList = "shelf";
  showTab("library");
};
$("tile-year").onclick = () => {
  yearOpen = !yearOpen;
  renderYearOverview();
};

// ---------- Verbindung ----------

function renderFriendPanel() {
  $("my-code").textContent = me.invite_code;
  $("friend-info").textContent = friend
    ? `Verbunden mit ${friend.display_name}.`
    : "Noch nicht verbunden. Schick deiner Freundin deinen Code oder gib hier ihren ein.";
  $("connect-form").hidden = !!friend;
}

$("connect-form").onsubmit = async (event) => {
  event.preventDefault();
  $("friend-status").textContent = "Verbinde …";
  const { error } = await sb.rpc("connect_with_code", { code: $("friend-code").value });
  if (error) {
    $("friend-status").textContent = error.message;
    return;
  }
  await loadFriend();
  $("friend-status").textContent = "";
  renderFriendPanel();
};

// ---------- Login ----------

function authMessage(text) {
  $("auth-status").textContent = text;
}

$("auth-form").onsubmit = async (event) => {
  event.preventDefault();
  authMessage("Anmeldung läuft …");
  const { error } = await sb.auth.signInWithPassword({
    email: $("auth-email").value.trim(),
    password: $("auth-password").value,
  });
  if (error) authMessage("Anmeldung fehlgeschlagen: " + error.message);
};

$("btn-signup").onclick = async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || password.length < 8) {
    authMessage("Bitte E-Mail und ein Passwort mit mindestens 8 Zeichen eingeben.");
    return;
  }
  authMessage("Registrierung läuft …");
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: $("auth-name").value.trim() } },
  });
  if (error) {
    authMessage("Registrierung fehlgeschlagen: " + error.message);
  } else if (!data.session) {
    authMessage("Fast geschafft: Bitte bestätige deine E-Mail-Adresse über den Link in der Mail.");
  }
};

$("logout").onclick = () => sb.auth.signOut();

async function onSession(session) {
  const loggedIn = !!session;
  $("view-auth").hidden = loggedIn;
  $("nav").hidden = !loggedIn;
  $("logout").hidden = !loggedIn;

  if (!loggedIn) {
    me = null;
    friend = null;
    myLibrary = [];
    for (const id of ["view-home", "view-search", "view-library", "view-friend"]) $(id).hidden = true;
    return;
  }

  try {
    const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
    if (error) throw error;
    me = data;
    await loadFriend();
    await reloadMyLibrary();
    renderFriendPanel();
    showTab("home");
  } catch (err) {
    $("view-auth").hidden = false;
    authMessage("Konnte deine Daten nicht laden: " + err.message);
  }
}

// ---------- Bedienung ----------

function showTab(name) {
  for (const n of ["home", "search", "library", "friend"]) {
    $("view-" + n).hidden = n !== name;
    $("tab-" + n).classList.toggle("active", n === name);
  }
  if (name === "library") renderLibrary();
  if (name === "home") renderHome();
}

$("tab-home").onclick = () => showTab("home");
$("tab-search").onclick = () => showTab("search");
$("tab-library").onclick = () => showTab("library");
$("tab-friend").onclick = () => showTab("friend");
$("lib-mine").onclick = () => {
  libView = "mine";
  renderLibrary();
};
$("lib-friend").onclick = () => {
  libView = "friend";
  renderLibrary();
};
$("close").onclick = () => $("detail").close();

$("search-form").onsubmit = async (event) => {
  event.preventDefault();
  $("status").textContent = "Suche läuft …";
  $("results").replaceChildren();
  try {
    const books = await searchBooks($("query").value, $("lang").value);
    $("status").textContent = books.length ? `${books.length} Treffer` : "Keine Treffer.";
    renderGrid($("results"), books);
  } catch (err) {
    $("status").textContent = err.message;
  }
};

// Auf Login/Logout reagieren (nicht direkt in der Callback-Funktion auf Supabase warten)
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => onSession(session), 0);
});
