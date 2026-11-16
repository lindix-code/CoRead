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
try {
  if (localStorage.getItem("coread-lib-view") === "friend") libView = "friend"; // zuletzt geöffnete Bücherei
} catch (e) {}
let friendNick = "Zaza"; // Spitzname der Freundin (bei Zaza: "Lindi")
let libList = "shelf"; // aktive Unterliste in der Bibliothek
let classicReads = []; // BookClub: wer hat welchen Klassiker gelesen ({ user_id, classic_id })

// Unterlisten der Bibliothek: [Schlüssel, Name, Filter]
// Ungelesen = gekauft (im Bücherregal) und will ich noch lesen
function isUnread(b) {
  return b.entry.owned && b.entry.status === "want";
}

const LISTS = [
  ["shelf", "Mein Bücherregal", (b) => b.entry.owned],
  ["unread", "Ungelesene Bücher", isUnread],
  ["read", "Abgeschlossen", (b) => b.entry.status === "read"],
  // Wunschliste: will ich lesen, habe ich aber noch nicht gekauft
  ["want", "Möchte ich lesen", (b) => b.entry.status === "want" && !b.entry.owned],
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
    cover: book.originalCover !== undefined ? book.originalCover : book.cover,
  };
}

async function fetchLibrary(userId) {
  const { data, error } = await sb
    .from("library_entries")
    .select("status, owned, audiobook, started_at, finished_at, custom_cover, custom_title, progress_page, progress_mode, progress_chapter, chapters_total, progress_percent, pages_total, rating, books(*)")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    ...dbToBook(r.books),
    title: r.custom_title || r.books.title, // eigener Titel hat Vorrang
    originalTitle: r.books.title,
    pages: r.pages_total || r.books.pages, // eigene Seitenzahl hat Vorrang
    catalogPages: r.books.pages,
    cover: r.custom_cover || r.books.cover,
    originalCover: r.books.cover,
    entry: {
      customCover: r.custom_cover,
      customTitle: r.custom_title,
      status: r.status,
      owned: r.owned,
      audiobook: r.audiobook,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      progress: r.progress_page,
      progressMode: r.progress_mode,
      progressChapter: r.progress_chapter,
      chaptersTotal: r.chapters_total,
      progressPercent: r.progress_percent,
      pagesTotal: r.pages_total,
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

  // Fortschritts-Varianten nur schreiben, wenn sie mitgegeben werden (sonst bleiben die Werte erhalten)
  const extra = {};
  if (entry.customTitle !== undefined) extra.custom_title = entry.customTitle || null;
  if (entry.progressMode !== undefined) extra.progress_mode = entry.progressMode;
  if (entry.progressChapter !== undefined) extra.progress_chapter = entry.progressChapter;
  if (entry.chaptersTotal !== undefined) extra.chapters_total = entry.chaptersTotal;
  if (entry.progressPercent !== undefined) extra.progress_percent = entry.progressPercent;
  if (entry.pagesTotal !== undefined) extra.pages_total = entry.pagesTotal;

  const { error } = await sb.from("library_entries").upsert(
    {
      ...extra,
      user_id: me.id,
      book_id: book.id,
      status: entry.status,
      owned: entry.owned,
      audiobook: !!entry.audiobook,
      custom_cover: entry.customCover || null,
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

// ---------- Cover-Upload ----------

// Verkleinert das Bild (max. 600 px breit) und wandelt es in JPEG um
async function resizeToJpeg(file, maxWidth = 480) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Das Bild konnte nicht verarbeitet werden."))),
      "image/jpeg",
      0.82
    );
  });
}

async function uploadCover(book, file) {
  const blob = await resizeToJpeg(file);
  const safeId = book.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `${me.id}/${safeId}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from("covers").upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
  if (error) throw error;
  return sb.storage.from("covers").getPublicUrl(path).data.publicUrl;
}

// Bereits hochgeladene Bilder nachträglich verkleinern (einmal pro Gerät/Konto ausführbar)
async function optimizeMyImages(report) {
  let count = 0;
  let saved = 0;

  for (const b of myLibrary) {
    const url = b.entry && b.entry.customCover;
    if (!url || !url.includes("/covers/")) continue;
    try {
      report(`Prüfe Cover „${b.title}“ …`);
      const blob = await (await fetch(url)).blob();
      if (blob.size < 60000) continue;
      const small = await resizeToJpeg(blob);
      if (small.size > blob.size * 0.9) continue;
      const newUrl = await uploadCover(b, small);
      const { error } = await sb.from("library_entries").update({ custom_cover: newUrl }).eq("user_id", me.id).eq("book_id", b.id);
      if (error) throw error;
      const oldPath = decodeURIComponent(url.split("/covers/")[1].split("?")[0]);
      await sb.storage.from("covers").remove([oldPath]);
      count++;
      saved += blob.size - small.size;
    } catch (err) {
      console.warn("Cover nicht optimiert:", b.title, err);
    }
  }

  const { data: posts } = await sb.from("posts").select("id, images").eq("user_id", me.id);
  for (const p of posts || []) {
    if (!(p.images || []).length) continue;
    report("Prüfe Beitragsfotos …");
    const newImages = [];
    const oldPaths = [];
    try {
      for (const path of p.images) {
        const { data: blob, error } = await sb.storage.from("post-images").download(path);
        if (error || blob.size < 150000) {
          newImages.push(path);
          continue;
        }
        const small = await resizeToJpeg(blob, 1000);
        if (small.size > blob.size * 0.9) {
          newImages.push(path);
          continue;
        }
        const newPath = `${me.id}/${crypto.randomUUID()}.jpg`;
        const { error: upError } = await sb.storage
          .from("post-images")
          .upload(newPath, small, { contentType: "image/jpeg", cacheControl: "31536000" });
        if (upError) throw upError;
        newImages.push(newPath);
        oldPaths.push(path);
        count++;
        saved += blob.size - small.size;
      }
      if (oldPaths.length) {
        const { error } = await sb.from("posts").update({ images: newImages }).eq("id", p.id);
        if (error) throw error;
        await sb.storage.from("post-images").remove(oldPaths);
      }
    } catch (err) {
      console.warn("Beitragsfotos nicht optimiert:", p.id, err);
    }
  }
  return { count, saved };
}

// Vorhandene große Bilder einmalig im Hintergrund verkleinern (neue Bilder werden schon beim Hochladen verkleinert)
function scheduleImageOptimization() {
  const key = "coread-images-optimized-" + me.id;
  try {
    if (localStorage.getItem(key)) return;
  } catch (e) {}
  setTimeout(async () => {
    try {
      const { count } = await optimizeMyImages(() => {});
      try {
        localStorage.setItem(key, "1");
      } catch (e) {}
      if (count) {
        await reloadMyLibrary();
        renderLibrary();
        renderHome();
      }
    } catch (err) {
      console.warn("Bilder-Optimierung übersprungen:", err);
    }
  }, 4000);
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
  const img = el("img", { src: book.cover, alt: "Cover: " + book.title, loading: "lazy", decoding: "async" });
  img.onerror = () => {
    if (book.fallbackCover && img.src !== book.fallbackCover) {
      img.src = book.fallbackCover;
    } else {
      img.replaceWith(el("div", { className: "cover-placeholder" }, "Kein Cover"));
    }
  };
  return img;
}

function entryLine(book, listKey) {
  const e = book.entry;
  if (!e) return "";
  const parts = [];
  if (listKey === "shelf") {
    // Im Bücherregal stehen alle Bücher im Regal: nur gelesen / ungelesen anzeigen
    if (e.status === "read") parts.push("Gelesen");
    else if (e.status === "reading") parts.push("Lese ich gerade" + (e.progress != null ? (book.pages ? ` (S. ${e.progress}/${book.pages})` : ` (S. ${e.progress})`) : ""));
    else parts.push("Ungelesen");
    if (e.rating) parts.push("★".repeat(e.rating));
    return parts.join(" · ");
  }
  if (e.status) {
    let text = STATUS[e.status];
    if (e.status === "reading" && e.progress != null) {
      text += book.pages ? ` (S. ${e.progress}/${book.pages})` : ` (S. ${e.progress})`;
    }
    parts.push(text);
  }
  if (e.owned && listKey !== "unread") parts.push("Im Regal");
  if (e.rating) parts.push("★".repeat(e.rating));
  return parts.join(" · ");
}

// Kleines Kopfhörer-Symbol für Hörbücher
function audioBadge(book) {
  if (!book.entry || !book.entry.audiobook) return "";
  const badge = el("span", { className: "badge-audio", title: "Hörbuch" });
  badge.append(el("img", { src: "assets/kopfhoerer.png", alt: "" }));
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Hörbuch");
  return badge;
}

function bookCard(book, readOnly, listKey) {
  const card = el("button", { className: "card", type: "button" });
  card.append(
    coverElement(book),
    el("div", { className: "title" }, book.title),
    el("div", { className: "author" }, book.authors.join(", "))
  );
  const line = entryLine(book, listKey);
  if (line) card.append(el("div", { className: "meta" }, line));
  card.append(audioBadge(book));
  card.onclick = () => showDetail(book, readOnly);
  return card;
}

function renderGrid(container, books, readOnly = false, listKey = null) {
  container.replaceChildren(...books.map((b) => bookCard(b, readOnly, listKey)));
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

// Datumsfeld zum Tippen (TT.MM.JJJJ, Zahlentastatur am Handy) plus Kalender-Auswahl
function makeDateField(iso) {
  const text = el("input", {
    type: "text",
    inputMode: "numeric",
    placeholder: "TT.MM.JJJJ",
    maxLength: 10,
    autocomplete: "off",
    value: iso ? formatDate(iso) : "",
  });
  text.setAttribute("aria-label", "Datum als TT.MM.JJJJ");

  // Punkte beim Tippen automatisch einfügen: 14032023 -> 14.03.2023
  text.oninput = () => {
    const d = text.value.replace(/\D/g, "").slice(0, 8);
    let out = d.slice(0, 2);
    if (d.length > 2) out += "." + d.slice(2, 4);
    if (d.length > 4) out += "." + d.slice(4);
    text.value = out;
  };

  // Kalender: verstecktes Datumsfeld, dessen Auswahl ins Textfeld übernommen wird
  const picker = el("input", { type: "date", className: "date-native", tabIndex: -1, value: iso || "" });
  picker.setAttribute("aria-hidden", "true");
  picker.onchange = () => {
    if (picker.value) text.value = formatDate(picker.value);
  };
  const calBtn = el("button", { className: "btn secondary small", type: "button" }, "Kalender");
  calBtn.setAttribute("aria-label", "Kalender öffnen");
  calBtn.onclick = () => {
    const parsed = parse();
    if (parsed.value) picker.value = parsed.value;
    try {
      picker.showPicker();
    } catch {
      picker.focus();
      picker.click();
    }
  };

  function parse() {
    const t = text.value.trim();
    if (!t) return { value: null, bad: false };
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (!m) return { value: null, bad: true };
    const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(year, month - 1, day);
    const valid =
      date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && year >= 1900 && year <= 2100;
    if (!valid) return { value: null, bad: true };
    const pad = (n) => String(n).padStart(2, "0");
    return { value: `${year}-${pad(month)}-${pad(day)}`, bad: false };
  }

  return {
    root: el("div", { className: "date-wrap" }, text, calBtn, picker),
    value: () => parse().value,
    bad: () => parse().bad,
  };
}

// preset: Vorbelegung für neue Einträge (kommt vom "+"-Button der jeweiligen Liste)
function showDetail(book, readOnly = false, preset = null) {
  // Falls das Buch schon in meiner Bibliothek ist, den gespeicherten Stand zeigen
  const mine = myLibrary.find((b) => b.id === book.id);
  const entry = readOnly ? book.entry : mine && mine.entry;
  // Eigenes Cover der Bibliothek zeigen, auch wenn das Buch aus der Suche kommt
  if (!readOnly && mine) book = { ...book, cover: mine.cover, originalCover: mine.originalCover, title: mine.title, originalTitle: mine.originalTitle };
  let customCover = entry ? entry.customCover || null : null;
  const coverSlot = el("div", { className: "cover-slot" }, coverElement(book));

  const top = el(
    "div",
    { className: "detail-top" },
    coverSlot,
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
      entry ? entry.status : preset ? preset.status : "want"
    );
    const ownedBox = el("input", { id: "f-owned", type: "checkbox", checked: entry ? !!entry.owned : !!(preset && preset.owned) });
    const ownedField = el("label", { className: "check" }, ownedBox, " Bücherregal hinzufügen");
    const audioBox = el("input", { id: "f-audio", type: "checkbox", checked: !!(entry && entry.audiobook) });
    const audioField = el("label", { className: "check" }, audioBox, " Hörbuch");
    const startedDate = makeDateField(entry && entry.startedAt);
    const finishedDate = makeDateField(entry && entry.finishedAt);
    const startedField = el("div", { className: "field" }, "Begonnen am", startedDate.root);
    const finishedField = el("div", { className: "field" }, "Beendet am", finishedDate.root);
    const statusSelect = statusField.querySelector("select");
    const updateDateFields = () => {
      const st = statusSelect.value;
      startedField.hidden = !["reading", "read"].includes(st);
      finishedField.hidden = st !== "read";
      progressField.hidden = st !== "reading";
      chaptersField.hidden = st !== "reading";
      pagesField.hidden = st !== "reading";
      ratingField.hidden = st === "want"; // "Möchte ich lesen": noch nichts zu bewerten
    };
    const progressField = el("label", { className: "field" }, "Aktuelle Seite");
    const progress = el("input", {
      id: "f-progress",
      type: "number",
      min: "0",
      value: entry && entry.progress != null ? entry.progress : "",
    });
    if (book.pages) progress.max = String(book.pages);
    progressField.append(progress);
    // Kapitelzahl kennt keine Datenquelle: optional selbst eintragen, dann gibt es den Fortschritt in Kapiteln
    const chaptersField = el("label", { className: "field" }, "Anzahl Kapitel (optional, für Fortschritt in Kapiteln)");
    const chaptersInput = el("input", {
      id: "f-chapters",
      type: "number",
      min: "1",
      value: entry && entry.chaptersTotal != null ? entry.chaptersTotal : "",
    });
    chaptersField.append(chaptersInput);
    const pagesField = el("label", { className: "field" }, "Seitenzahl des Buchs (optional, falls oben keine bekannt ist)");
    const pagesInput = el("input", {
      id: "f-pages",
      type: "number",
      min: "1",
      value: entry && entry.pagesTotal != null ? entry.pagesTotal : "",
      placeholder: book.catalogPages || book.pages || "",
    });
    pagesField.append(pagesInput);
    const ratingField = selectField(
      "Bewertung",
      "f-rating",
      [["", "–"], ...[1, 2, 3, 4, 5].map((n) => [n, "★".repeat(n)])],
      entry ? entry.rating : ""
    );

    updateDateFields();
    statusSelect.onchange = updateDateFields;

    // Cover tauschen / hochladen
    const coverMsg = el("div", { className: "meta", role: "status" });
    const fileInput = el("input", { type: "file", accept: "image/*", hidden: true });
    const uploadBtn = el(
      "button",
      { className: "btn secondary small", type: "button" },
      book.cover ? "Cover ändern" : "Cover hochladen"
    );
    uploadBtn.onclick = () => fileInput.click();
    const refreshCover = () => {
      coverSlot.firstElementChild.replaceWith(coverElement(book));
      uploadBtn.textContent = book.cover ? "Cover ändern" : "Cover hochladen";
      resetBtn.hidden = !customCover;
      quickSave.hidden = false; // Speichern-Symbol oben einblenden
    };
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      coverMsg.textContent = "Lade hoch …";
      try {
        const url = await uploadCover(book, file);
        customCover = url;
        book = {
          ...book,
          cover: url,
          originalCover: book.originalCover !== undefined ? book.originalCover : book.cover,
        };
        coverMsg.textContent = "";
        refreshCover();
      } catch (err) {
        coverMsg.textContent = "Upload hat nicht geklappt: " + err.message;
      }
      fileInput.value = "";
    };
    const resetBtn = el("button", { className: "btn secondary small", type: "button" }, "Standard-Cover");
    resetBtn.hidden = !customCover;
    resetBtn.onclick = () => {
      customCover = null;
      book = { ...book, cover: book.originalCover || null };
      coverMsg.textContent = "Standard-Cover. Mit „Speichern“ übernehmen.";
      refreshCover();
    };
    coverSlot.append(el("div", { className: "cover-actions" }, uploadBtn, resetBtn, fileInput), coverMsg);

    // Eigener Titel (nur für dein Regal; leer = Originaltitel)
    const origTitle = book.originalTitle || book.title;
    const titleInput = el("input", { type: "text", maxLength: 200, value: book.title, placeholder: origTitle });
    titleInput.setAttribute("aria-label", "Titel");
    titleInput.oninput = () => (quickSave.hidden = false);
    const titleField = el("div", { className: "field" }, "Titel (nur für dich)", titleInput);
    const readTitle = () => {
      const t = titleInput.value.trim();
      return t && t !== origTitle ? t : null;
    };

    const saveBtn = el("button", { className: "btn", type: "button" }, entry ? "Speichern" : "Zur Bibliothek");
    const msg = el("p", { role: "status", className: "meta" });

    // Kleines Speichern-Symbol oben (nach Cover-Änderung), damit man nicht nach unten scrollen muss
    const quickSave = el("button", { className: "quick-save", type: "button", hidden: true });
    quickSave.setAttribute("aria-label", "Speichern");
    quickSave.title = "Speichern";
    quickSave.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3"/><rect x="7" y="13" width="10" height="8" rx="1"/></svg>';
    quickSave.onclick = () => {
      saveBtn.click();
      // Hinweise (z. B. fehlendes Datum) auch oben anzeigen
      const mirror = () => {
        if (msg.textContent) coverMsg.textContent = msg.textContent;
      };
      mirror();
      setTimeout(mirror, 1500);
    };
    saveBtn.onclick = async () => {
      const status = $("f-status").value || null;
      const owned = $("f-owned").checked;
      if (!status && !owned) {
        msg.textContent = "Wähle eine Leseliste oder setze den Haken für das Bücherregal.";
        return;
      }
      // Unvollständig eingegebene Daten nicht stillschweigend durch "heute" ersetzen
      if ((!startedField.hidden && startedDate.bad()) || (!finishedField.hidden && finishedDate.bad())) {
        msg.textContent = "Bitte gib das Datum als TT.MM.JJJJ ein (z. B. 14.03.2023) oder lösche es ganz.";
        return;
      }
      const startedAt = !startedField.hidden ? startedDate.value() : null;
      const finishedAt = !finishedField.hidden ? finishedDate.value() : null;
      if (startedAt && finishedAt && finishedAt < startedAt) {
        msg.textContent = "Das Enddatum liegt vor dem Startdatum.";
        return;
      }
      saveBtn.disabled = true;
      try {
        const newRating = $("f-rating").value === "" ? null : Number($("f-rating").value);
        await saveEntry(book, {
          status,
          owned,
          audiobook: $("f-audio").checked,
          startedAt,
          finishedAt,
          customCover,
          customTitle: readTitle(),
          pagesTotal: $("f-pages").value !== "" ? Math.max(1, Math.round(Number($("f-pages").value))) : null,
          chaptersTotal: $("f-chapters").value !== "" ? Math.max(1, Math.round(Number($("f-chapters").value))) : null,
          progress: status === "reading" && $("f-progress").value !== "" ? Number($("f-progress").value) : null,
          rating: $("f-rating").value === "" ? null : Number($("f-rating").value),
        });
        // Bewertung geändert: Sterne in automatisierten Pinnwand-Beiträgen zu diesem Buch angleichen
        if (entry && (entry.rating || null) !== newRating) {
          await sb.from("posts").update({ rating: newRating }).eq("user_id", me.id).eq("book_id", book.id).eq("auto", true);
        }
        await reloadMyLibrary();
        $("detail").close();
        $("add-dialog").close();
        renderLibrary();
        renderHome();
        // Neu als "Gelesen" markiert: nach Sternen und Bewertung fragen
        if (status === "read" && !(entry && entry.status === "read")) {
          openFinishDialog(myLibrary.find((b) => b.id === book.id));
        }
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
    content.append(titleField, statusField, startedField, finishedField, ownedField, audioField, progressField, pagesField, chaptersField, ratingField, actions, msg, quickSave);
  }

  $("detail-content").replaceChildren(content);
  $("detail").showModal();
}

// ---------- Bibliothek ----------

async function renderLibrary() {
  $("lib-mine").className = libView === "mine" ? "btn" : "btn secondary";
  $("lib-friend").className = libView === "friend" ? "btn" : "btn secondary";
  $("lib-friend").hidden = false; // immer sichtbar; ohne Verbindung erscheint ein Hinweis
  $("lib-friend").textContent = `${friendNick}s Bücher`;
  $("lib-mine").className = libView === "mine" ? "btn" : "btn secondary";
  $("lib-friend").className = libView === "friend" ? "btn" : "btn secondary";
  try {
    localStorage.setItem("coread-lib-view", libView);
  } catch (e) {}

  if (libView === "mine") {
    renderLists(myLibrary, false);
  } else if (!friend) {
    $("lib-lists").replaceChildren();
    $("library").replaceChildren();
    $("library-status").textContent = `Du bist noch nicht mit ${friendNick} verbunden. Im Reiter „${friendNick}“ (zwei Personen unten) kannst du den Einladungscode eingeben oder teilen.`;
  } else if (friend) {
    $("lib-friend").hidden = false;
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

let libBooks = [];
let libReadOnly = false;
let libQuery = "";
let libSort = "added";

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Alle Suchwörter müssen irgendwo im Buch vorkommen (Titel, Autor:in, Verlag, Genre, ISBN …)
function matchesQuery(book) {
  const words = normalize(libQuery).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalize(
    [book.title, book.subtitle, book.authors.join(" "), book.publisher, book.categories.join(" "), book.isbn, book.publishedDate].join(" ")
  );
  return words.every((w) => hay.includes(w));
}

const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

// Sortierschlüssel Autor:in: Nachname (letztes Wort) des ersten Autors, dann der volle Name
function authorKey(book) {
  const first = book.authors[0] || "";
  const last = first.trim().split(/\s+/).pop() || "";
  return last + " " + first;
}

function sortBooks(list) {
  const sorted = [...list];
  if (libSort === "title") {
    sorted.sort((a, b) => collator.compare(a.title, b.title));
  } else if (libSort === "author") {
    sorted.sort(
      (a, b) =>
        !a.authors.length - !b.authors.length ||
        collator.compare(authorKey(a), authorKey(b)) ||
        collator.compare(a.title, b.title)
    );
  } else if (libSort === "rating") {
    // beste zuerst, Bücher ohne Bewertung ans Ende
    sorted.sort(
      (a, b) => (b.entry.rating || 0) - (a.entry.rating || 0) || collator.compare(a.title, b.title)
    );
  }
  return sorted; // "added": Reihenfolge der Datenbank (zuletzt hinzugefügt zuerst)
}

// Zeigt die Unterlisten (Regal, Ungelesen, Lese ich gerade, Abgeschlossen, Möchte ich lesen)
function renderLists(books, readOnly) {
  libBooks = books;
  libReadOnly = readOnly;
  $("lib-add").hidden = readOnly; // bei der Bibliothek der Freundin nicht hinzufügen
  const searching = normalize(libQuery).trim() !== "";

  const buttons = LISTS.map(([key, label, test]) => {
    const count = books.filter(test).filter(matchesQuery).length;
    const btn = el(
      "button",
      { className: key === libList ? "btn" : "btn secondary", type: "button" },
      `${label} (${count})`
    );
    btn.onclick = () => {
      libList = key;
      renderLists(libBooks, libReadOnly);
    };
    return btn;
  });
  $("lib-lists").replaceChildren(...buttons);

  const [, label, test] = LISTS.find(([key]) => key === libList);
  const shown = sortBooks(books.filter(test).filter(matchesQuery));
  const who = readOnly && friend ? friend.display_name + ": " : "";
  if (shown.length) {
    $("library-status").textContent = searching ? `${who}${label}: ${shown.length} Treffer` : `${who}${label}`;
  } else {
    $("library-status").textContent = searching
      ? `${who}Keine Treffer in „${label}“.`
      : `${who}Noch nichts in „${label}“.`;
  }
  renderGrid($("library"), shown, readOnly, libList);
}

// Vorbelegung je Liste beim Hinzufügen über "+"
const PRESETS = {
  shelf: { owned: true, status: "" },
  unread: { owned: true, status: "want" },
  read: { owned: false, status: "read" },
  want: { owned: false, status: "want" },
};

$("lib-add").onclick = () => {
  addKind = null;
  const [, label] = LISTS.find(([key]) => key === libList);
  $("add-title").textContent = `Buch hinzufügen: ${label}`;
  $("add-query").value = ""; // altes Suchwort nicht stehen lassen
  $("add-status").textContent = "";
  $("add-results").replaceChildren();
  $("add-dialog").showModal();
  $("add-query").focus();
};
$("add-close").onclick = () => $("add-dialog").close();
$("add-dialog").addEventListener("close", () => { addKind = null; });
$("add-form").onsubmit = async (event) => {
  event.preventDefault();
  const preset = PRESETS[libList];
  $("add-status").textContent = "Suche läuft …";
  $("add-results").replaceChildren();
  try {
    let books = await searchBooks($("add-query").value, $("add-lang").value);
    let ownCount = 0;
    if (addKind) {
      // Profil-Listen: zuerst die eigene Bibliothek (inkl. geändertem Cover), dann weitere Treffer
      const own = libraryMatches($("add-query").value);
      ownCount = own.length;
      const ownIds = new Set(own.map((b) => b.id));
      books = [...own, ...books.filter((b) => !ownIds.has(b.id))];
    }
    $("add-status").textContent = books.length
      ? ownCount ? `${ownCount} aus deiner Bibliothek, dazu ${books.length - ownCount} weitere Treffer` : `${books.length} Treffer`
      : "Keine Treffer.";
    $("add-results").replaceChildren(
      ...books.map((book) => {
        const card = bookCard(book, false);
        card.onclick = () => (addKind ? addProfileBook(addKind, book) : showDetail(book, false, preset));
        return card;
      })
    );
  } catch (err) {
    $("add-status").textContent = err.message;
  }
};

$("lib-sort").onchange = (event) => {
  libSort = event.target.value;
  renderLists(libBooks, libReadOnly);
};

$("lib-search").oninput = (event) => {
  libQuery = event.target.value;
  renderLists(libBooks, libReadOnly);
};

// ---------- Startseite ----------

let homeBookId = null;

function todayLocal() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Darstellung des aktuellen Buchs: groß oder kompakt (pro Gerät gemerkt)
let heroCompact = false;
try {
  heroCompact = localStorage.getItem("coread-hero-compact") === "1";
} catch (e) {}
function setHeroCompact(value) {
  heroCompact = value;
  try {
    localStorage.setItem("coread-hero-compact", value ? "1" : "0");
  } catch (e) {}
  renderHome();
}

const PROGRESS_MODES = [
  ["page", "Seite"],
  ["chapter", "Kapitel"],
  ["percent", "%"],
];

function lastProgressMode() {
  try {
    const m = localStorage.getItem("coread-progress-mode");
    if (PROGRESS_MODES.some(([key]) => key === m)) return m;
  } catch (e) {}
  return "page";
}

// Text und Prozentwert für die Anzeige, je nach gespeicherter Variante
function progressInfo(book) {
  const e = book.entry;
  const mode = e.progressMode === "chapter" && !e.chaptersTotal ? "page" : e.progressMode || "page";
  if (mode === "chapter") {
    const ch = e.progressChapter || 0;
    if (e.chaptersTotal) {
      const pct = Math.min(100, Math.round((ch / e.chaptersTotal) * 100));
      return { pct, text: `Kapitel ${ch} von ${e.chaptersTotal} · ${pct} %` };
    }
    return { pct: 0, text: `Kapitel ${ch}` };
  }
  if (mode === "percent") {
    const pct = Math.min(100, e.progressPercent || 0);
    return { pct, text: `${pct} %` };
  }
  const page = e.progress || 0;
  const pct = book.pages ? Math.min(100, Math.round((page / book.pages) * 100)) : null;
  return { pct: pct || 0, text: pct != null ? `Seite ${page} von ${book.pages} · ${pct} %` : `Seite ${page}` };
}

// Fortschritt eintragen (Seite / Kapitel / Prozent): wird auf der Startseite und im BookClub genutzt
function buildProgressForm(book, opts = {}) {
  const e = book.entry;
  // Eingabe: Variante wählen (Seite / Kapitel / Prozent), Wert eintragen
  // "Kapitel" gibt es nur, wenn die Kapitelzahl des Buchs bekannt ist (im Buch eingetragen)
  const modes = PROGRESS_MODES.filter(([key]) => key !== "chapter" || e.chaptersTotal);
  let mode = e.progressMode || lastProgressMode();
  if (!modes.some(([key]) => key === mode)) mode = "page";
  const input = el("input", { type: "number", min: "0", step: "1" });
  const unit = el("span", { className: "progress-unit" });
  // Ohne bekannte Seitenzahl kann kein Balken berechnet werden: Gesamtzahl hier eintragen
  const pagesTotalInput = el("input", { type: "number", min: "1", step: "1", placeholder: "Seiten gesamt", className: "pages-total" });
  pagesTotalInput.setAttribute("aria-label", "Seitenzahl des Buchs");
  const modeSelect = el("select", { className: "mode-select" }, ...modes.map(([key, label]) => el("option", { value: key }, label)));
  modeSelect.setAttribute("aria-label", "Fortschritt angeben in");
  modeSelect.onchange = () => {
    mode = modeSelect.value;
    renderForm();
  };
  function renderForm() {
    modeSelect.value = mode;
    pagesTotalInput.hidden = !(mode === "page" && !book.pages);
    input.removeAttribute("max");
    if (mode === "page") {
      input.value = e.progress != null ? e.progress : "";
      if (book.pages) input.max = String(book.pages);
      input.setAttribute("aria-label", "Aktuelle Seite");
      unit.textContent = "";
    } else if (mode === "chapter") {
      input.value = e.progressChapter != null ? e.progressChapter : "";
      input.max = String(e.chaptersTotal);
      input.setAttribute("aria-label", "Aktuelles Kapitel");
      unit.textContent = "";
    } else {
      input.value = e.progressPercent != null ? e.progressPercent : "";
      input.max = "100";
      input.setAttribute("aria-label", "Fortschritt in Prozent");
      unit.textContent = "%";
    }
  }
  renderForm();

  const msg = el("div", { className: "meta", role: "status" });
  const saveBtn = el("button", { className: "btn", type: "button" }, "Update");
  saveBtn.onclick = async () => {
    if (input.value === "") return;
    const value = Math.max(0, Math.round(Number(input.value)));
    const fields = { progressMode: mode };
    if (mode === "page") {
      fields.progress = value;
      if (!book.pages && pagesTotalInput.value !== "") fields.pagesTotal = Math.max(1, Math.round(Number(pagesTotalInput.value)));
    } else if (mode === "chapter") {
      fields.progressChapter = Math.min(value, e.chaptersTotal);
    } else {
      fields.progressPercent = Math.min(100, value);
      if (book.pages) fields.progress = Math.round((fields.progressPercent / 100) * book.pages); // Seitenzahl mitführen
    }
    saveBtn.disabled = true;
    try {
      await saveEntry(book, { ...e, ...fields });
      try {
        localStorage.setItem("coread-progress-mode", mode);
      } catch (err) {}
      await opts.onSaved();
    } catch (err) {
      msg.textContent = "Speichern hat nicht geklappt: " + err.message;
      saveBtn.disabled = false;
    }
  };
  if (opts.compact) saveBtn.classList.add("small");

  const form = el("div", { className: "progress-form" }, el("div", { className: "progress-input" }, modeSelect, input, unit, pagesTotalInput, saveBtn));
  return { form, msg };
}

function heroCard(book) {
  const e = book.entry;
  const info = progressInfo(book);
  const compact = heroCompact;

  const fill = el("div", { className: "bar-fill" });
  fill.style.width = info.pct + "%";
  const bar = el("div", { className: "bar" }, fill);
  const progressText = el("div", { className: "progress-text" }, info.text);

  const { form, msg } = buildProgressForm(book, {
    compact,
    onSaved: async () => {
      const before = currentPage(book);
      homeBookId = book.id;
      await reloadMyLibrary();
      renderHome();
      if (isBuddyBook(book.id)) checkBuddyUnlocks(book.id, before);
    },
  });

  const toggle = el("button", { className: "hero-toggle", type: "button" });
  toggle.innerHTML = compact
    ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>'
    : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>';
  toggle.setAttribute("aria-label", compact ? "Aktuelles Buch groß anzeigen" : "Aktuelles Buch kompakt anzeigen");
  toggle.onclick = () => setHeroCompact(!heroCompact);
  const labelRow = el("div", { className: "hero-top" }, el("div", { className: "hero-label" }, "Ich lese gerade"), toggle);

  // Cover antippen öffnet die Details
  const cover = el("div", { className: "hero-cover tappable" }, coverElement(book));
  cover.setAttribute("role", "button");
  cover.setAttribute("aria-label", `Details zu ${book.title}`);
  cover.onclick = () => showDetail(book);

  const authors = el("div", { className: "author" }, book.authors.join(", "));
  const body = compact
    ? el("div", { className: "hero-info" }, labelRow, el("div", { className: "hero-title-btn" }, book.title), authors, bar, progressText, form, msg)
    : el("div", { className: "hero-info" }, labelRow, el("h2", {}, book.title), authors, bar, progressText, form, msg);
  return el("div", { className: compact ? "hero compact" : "hero" }, cover, body);
}

// ---------- Meilenstein: Zeitraum + Anzahl Bücher ----------

let goals = [];

async function loadGoals() {
  const { data, error } = await sb
    .from("reading_goals")
    .select("id, period_start, period_end, target")
    .eq("user_id", me.id)
    .order("created_at", { ascending: false });
  goals = error ? [] : data; // ohne Migration 012 einfach kein Meilenstein
}

// Meilenstein, der heute gilt (neuester zuerst)
function activeGoal() {
  const today = todayLocal();
  return goals.find((g) => g.period_start <= today && today <= g.period_end) || null;
}

function booksReadBetween(start, end) {
  return myLibrary.filter(
    (b) => b.entry.status === "read" && b.entry.finishedAt && b.entry.finishedAt >= start && b.entry.finishedAt <= end
  );
}

function goalLabel(goal) {
  const y = goal.period_start.slice(0, 4);
  if (goal.period_start === `${y}-01-01` && goal.period_end === `${y}-12-31`) return `Gelesen ${y}`;
  return `Gelesen ${formatDate(goal.period_start)} – ${formatDate(goal.period_end)}`;
}

function renderYearTile() {
  const goal = activeGoal();
  if (goal) {
    $("year-label").textContent = goalLabel(goal);
    $("year-count").textContent = `${booksReadBetween(goal.period_start, goal.period_end).length}/${goal.target}`;
    return;
  }
  const year = String(new Date().getFullYear());
  $("year-label").textContent = `Gelesen ${year}`;
  $("year-count").textContent = booksReadIn(year).length;
}

function openGoalDialog() {
  const goal = activeGoal();
  const year = new Date().getFullYear();
  $("goal-title").textContent = goal ? "Meilenstein bearbeiten" : "Meilenstein hinzufügen";
  const from = makeDateField(goal ? goal.period_start : `${year}-01-01`);
  const to = makeDateField(goal ? goal.period_end : `${year}-12-31`);
  const target = el("input", { type: "number", min: "1", max: "1000", step: "1", placeholder: "z. B. 15", inputMode: "numeric" });
  if (goal) target.value = goal.target;
  const msg = el("p", { role: "status", className: "meta" });
  const progress = el("p", { className: "meta" });
  const updateProgress = () => {
    const s = from.value();
    const e = to.value();
    if (s && e && e >= s && target.value) {
      progress.textContent = `Stand: ${booksReadBetween(s, e).length}/${Math.round(Number(target.value))} Büchern`;
    } else {
      progress.textContent = "";
    }
  };
  target.oninput = updateProgress;
  updateProgress();

  const save = el("button", { className: "btn", type: "button" }, "Speichern");
  save.onclick = async () => {
    if (from.bad() || to.bad() || !from.value() || !to.value()) {
      msg.textContent = "Bitte gib Beginn und Ende als TT.MM.JJJJ ein.";
      return;
    }
    if (to.value() < from.value()) {
      msg.textContent = "Das Ende liegt vor dem Beginn.";
      return;
    }
    const n = Math.round(Number(target.value));
    if (!n || n < 1 || n > 1000) {
      msg.textContent = "Bitte gib eine Anzahl Bücher zwischen 1 und 1000 ein.";
      return;
    }
    save.disabled = true;
    const fields = { period_start: from.value(), period_end: to.value(), target: n };
    const { error } = goal
      ? await sb.from("reading_goals").update(fields).eq("id", goal.id)
      : await sb.from("reading_goals").insert(fields);
    if (error) {
      msg.textContent = "Speichern hat nicht geklappt: " + error.message;
      save.disabled = false;
      return;
    }
    await loadGoals();
    $("goal-dialog").close();
    renderHome();
  };
  const actions = el("div", { className: "actions" }, save);
  if (goal) {
    const del = el("button", { className: "btn secondary", type: "button" }, "Löschen");
    del.onclick = async () => {
      if (!confirm("Diesen Meilenstein wirklich löschen?")) return;
      const { error } = await sb.from("reading_goals").delete().eq("id", goal.id);
      if (error) {
        msg.textContent = "Löschen hat nicht geklappt: " + error.message;
        return;
      }
      await loadGoals();
      $("goal-dialog").close();
      renderHome();
    };
    actions.append(del);
  }
  $("goal-content").replaceChildren(
    el("div", { className: "field" }, "Zeitraum von", from.root),
    el("div", { className: "field" }, "Zeitraum bis", to.root),
    el("label", { className: "field" }, "Anzahl der Bücher", target),
    progress,
    actions,
    msg
  );
  $("goal-dialog").showModal();
}
$("goal-close").onclick = () => $("goal-dialog").close();

function renderHome() {
  // Neueste zuerst: nach Beginn-Datum absteigend (ohne Datum = frisch hinzugefügt, ganz vorn); gleiche Werte behalten die Bibliotheks-Reihenfolge
  const reading = myLibrary
    .filter((b) => b.entry.status === "reading")
    .map((b, i) => ({ b, i, k: b.entry.startedAt || "9999-12-31" }))
    .sort((x, y) => (x.k < y.k ? 1 : x.k > y.k ? -1 : x.i - y.i))
    .map((x) => x.b);
  const hero = $("home-hero");

  if (!reading.length) {
    homeBookId = null;
    const searchBtn = el("button", { className: "btn", type: "button" }, "Buch suchen");
    searchBtn.onclick = () => {
      showTab("library");
      $("lib-add").click(); // Buch hinzufügen über das "+"
    };
    hero.replaceChildren(
      el("div", { className: "hero empty" }, el("p", {}, "Du liest gerade kein Buch."), searchBtn)
    );
  } else {
    let index = reading.findIndex((b) => b.id === homeBookId);
    if (index < 0) index = 0;
    homeBookId = reading[index].id;

    // Mehrere Bücher: seitlich wischen (Swipe), Punkte zeigen die Position
    const track = el(
      "div",
      { className: "carousel" },
      ...reading.map((b) => el("div", { className: "slide" }, heroCard(b)))
    );
    const dots = reading.map((b, i) => {
      const dot = el("button", {
        className: i === index ? "dot active" : "dot",
        type: "button",
        "aria-label": `Buch ${i + 1}: ${b.title}`,
      });
      dot.onclick = () => track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" });
      return dot;
    });
    track.onscroll = () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (reading[i]) {
        homeBookId = reading[i].id;
        dots.forEach((dot, j) => dot.classList.toggle("active", j === i));
      }
    };
    hero.replaceChildren(track, ...(reading.length > 1 ? [el("div", { className: "dots" }, ...dots)] : []));
    if (index > 0) requestAnimationFrame(() => (track.scrollLeft = index * track.clientWidth));
  }

  const owned = myLibrary.filter((b) => b.entry.owned).length;
  $("shelf-count").textContent = owned;

  renderYearTile();
  renderYearOverview(); // liegt im Bookjournal, bleibt nach Änderungen aktuell

  $("stack-count").textContent = stackBooks().length;
  renderRecs();
  refreshRecs();
}

// Stapel ungelesener Bücher (SuB): gekauft (Bücherregal) und noch zu lesen
function stackBooks() {
  return myLibrary.filter(isUnread);
}


// Bücher, die im angegebenen Jahr beendet wurden (neueste zuerst)
function booksReadIn(year) {
  if (year === "none") return myLibrary.filter((b) => b.entry.status === "read" && !b.entry.finishedAt);
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

let overviewYear = String(new Date().getFullYear());

// Jahre für den Filter: die letzten vier plus alle Jahre mit Einträgen
function overviewYears() {
  const current = new Date().getFullYear();
  const years = new Set([0, 1, 2, 3].map((i) => String(current - i)));
  for (const b of myLibrary) {
    if (b.entry.status === "read" && b.entry.finishedAt) years.add(b.entry.finishedAt.slice(0, 4));
  }
  const list = [...years].sort().reverse();
  return list;
}

const yearLabel = (year) => (year === "none" ? "Ohne Datum" : year);

function renderYearOverview() {
  const box = $("year-overview");
  box.hidden = false; // Jahreslisten bleiben immer sichtbar

  const filter = el(
    "div",
    { className: "actions subtabs" },
    ...overviewYears().map((year) => {
      const chip = el(
        "button",
        { className: year === overviewYear ? "btn" : "btn secondary", type: "button" },
        `${yearLabel(year)} (${booksReadIn(year).length})`
      );
      chip.onclick = () => {
        overviewYear = year;
        renderYearOverview();
      };
      return chip;
    })
  );

  const books = booksReadIn(overviewYear);
  if (!books.length) {
    box.replaceChildren(
      filter,
      el("p", { className: "meta" }, `Kein Buch in ${yearLabel(overviewYear)} beendet.`)
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
    row.append(cover, info, audioBadge(book));
    row.onclick = () => showDetail(book);
    return row;
  });
  box.replaceChildren(
    filter,
    ...rows
  );
}

$("tile-shelf").onclick = () => {
  libView = "mine";
  libList = "shelf";
  showTab("library");
};
$("tile-year").onclick = () => openGoalDialog();
$("tile-stack").onclick = () => {
  libView = "mine";
  libList = "unread";
  showTab("library");
};

// ---------- Pinnwand ----------

const FEED_PAGE = 20;
const MAX_PHOTOS = 4;
let feedLimit = FEED_PAGE;
let pendingPhotos = []; // ausgewählte Fotos für den neuen Eintrag

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadFeed() {
  $("feed-status").textContent = "Lade …";
  const { data, error } = await sb
    .from("posts")
    .select("id, user_id, title, body, images, rating, auto, started_at, finished_at, created_at, books(id, title, authors, cover), profiles(display_name)")
    .order("created_at", { ascending: false })
    .range(0, feedLimit); // ein Eintrag mehr als angezeigt, um "mehr laden" zu erkennen
  if (error) {
    $("feed-status").textContent = "Die Pinnwand konnte nicht geladen werden: " + error.message;
    return;
  }
  const hasMore = data.length > feedLimit;
  const posts = data.slice(0, feedLimit);

  // Fotos liegen in einem privaten Speicher: zeitlich begrenzte Links holen
  const urls = {};
  const paths = posts.flatMap((p) => p.images || []);
  if (paths.length) {
    const { data: signed } = await sb.storage.from("post-images").createSignedUrls(paths, 3600);
    for (const item of signed || []) if (item.signedUrl) urls[item.path] = item.signedUrl;
  }

  if (posts.length) markFeedSeen(posts[0].created_at);
  $("feed-status").textContent = posts.length ? "" : "Noch keine Einträge. Schreib den ersten!";
  $("feed").replaceChildren(...posts.map((p) => postCard(p, urls)));
  $("feed-more").hidden = !hasMore;
  requestAnimationFrame(checkClamps);
}

// "Mehr anzeigen" nur bei Beiträgen, die länger als 8 Zeilen sind
function checkClamps() {
  for (const body of document.querySelectorAll("#feed .post-body.clamp")) {
    body.nextElementSibling.hidden = body.scrollHeight <= body.clientHeight + 1;
  }
}
window.addEventListener("resize", checkClamps);

// Lesezeitraum eines Beitrags: aus dem Beitrag, bei eigenen alten Beiträgen ersatzweise aus der Bibliothek
function postPeriod(post, mine) {
  const entry = (mine && (myLibrary.find((b) => b.id === post.books.id) || {}).entry) || {};
  return readingPeriod({
    startedAt: post.started_at || entry.startedAt || null,
    finishedAt: post.finished_at || entry.finishedAt || null,
  });
}

// Großes Cover links, Angaben rechts: Titel, Autor:in, Sterne, Zeitraum, Nachricht
function finishedBlock(post, stars, period, message) {
  const cover = { title: post.books.title, cover: post.books.cover, fallbackCover: null };
  return el(
    "div",
    { className: "auto-body" },
    el("div", { className: "auto-cover" }, coverElement(cover)),
    el(
      "div",
      { className: "auto-info" },
      el("h3", {}, post.books.title),
      el("div", { className: "author" }, (post.books.authors || []).join(", ")),
      stars || "",
      period ? el("div", { className: "meta" }, period) : "",
      el("p", { className: "auto-text" }, message)
    )
  );
}

// Lange Texte: nur die ersten 8 Zeilen zeigen, Rest aufklappbar
function clampedBody(text) {
  const body = el("p", { className: "post-body clamp" }, text);
  const more = el("button", { className: "post-more", type: "button", hidden: true }, "Mehr anzeigen");
  more.onclick = () => {
    const open = body.classList.toggle("clamp") === false;
    more.textContent = open ? "Weniger anzeigen" : "Mehr anzeigen";
  };
  return [body, more];
}

function postCard(post, urls) {
  const mine = post.user_id === me.id;
  const name = mine ? "Du" : (post.profiles && post.profiles.display_name) || "Freundin";
  const authorName = mine ? me.display_name : (post.profiles && post.profiles.display_name) || "Freundin";
  const card = el(
    "article",
    { className: post.auto ? "post auto" : "post" },
    el("div", { className: "post-head" }, el("strong", {}, name), el("span", { className: "meta" }, formatDateTime(post.created_at)))
  );
  const stars = post.rating
    ? el("div", { className: "post-stars", "aria-label": `${post.rating} von 5 Sternen` }, "★".repeat(post.rating) + "☆".repeat(5 - post.rating))
    : null;
  const hasImages = (post.images || []).length > 0;
  // Bewertung = geschriebener Beitrag zu einem Buch mit Sternen (kommt aus dem "Buch abgeschlossen"-Fenster)
  const isReview = !post.auto && !!post.books && !!post.rating;

  if (post.auto && post.books) {
    // Automatischer Beitrag: nur Cover + Angaben
    card.append(finishedBlock(post, stars, postPeriod(post, mine), post.body));
  } else if (isReview && !hasImages) {
    // Bewertung ohne Foto: wie der automatische Beitrag, darunter der Text
    card.append(finishedBlock(post, stars, postPeriod(post, mine), `${authorName} hat „${post.books.title}“ abgeschlossen.`));
    if (post.title) card.append(el("h3", { className: "review-title" }, post.title));
    card.append(...clampedBody(post.body));
  } else {
    if (post.title) card.append(el("h3", {}, post.title));
    if (stars && !post.auto) card.append(stars);
    card.append(...clampedBody(post.body));
    if (stars && post.auto) card.append(stars);

    const images = (post.images || []).map((path) => urls[path]).filter(Boolean);
    if (images.length) {
      card.append(
        el(
          "div",
          { className: "post-images n" + images.length },
          ...images.map((url) => el("img", { src: url, alt: "Foto", loading: "lazy" }))
        )
      );
    }
    if (post.books) {
      const book = { title: post.books.title, cover: post.books.cover, fallbackCover: null };
      const period = isReview ? postPeriod(post, mine) : "";
      card.append(
        el(
          "div",
          { className: "post-book" },
          el("div", { className: "row-cover" }, coverElement(book)),
          el(
            "div",
            {},
            el("div", { className: "title" }, post.books.title),
            el("div", { className: "author" }, (post.books.authors || []).join(", ")),
            period ? el("div", { className: "meta" }, period) : ""
          )
        )
      );
    }
  }
  if (mine) {
    const del = el("button", { className: "btn secondary small", type: "button" }, "Löschen");
    del.onclick = async () => {
      if (!confirm("Diesen Eintrag wirklich löschen?")) return;
      del.disabled = true;
      if ((post.images || []).length) await sb.storage.from("post-images").remove(post.images);
      const { error } = await sb.from("posts").delete().eq("id", post.id);
      if (error) {
        del.disabled = false;
        $("feed-status").textContent = "Löschen hat nicht geklappt: " + error.message;
        return;
      }
      loadFeed();
    };
    const edit = el("button", { className: "btn secondary small", type: "button" }, "Bearbeiten");
    edit.onclick = () => openEditPost(post);
    // Automatisierte Beiträge nur löschen; ihre Sterne folgen der Bewertung in der Bibliothek
    card.append(el("div", { className: "actions" }, ...(post.auto ? [del] : [edit, del])));
  }
  return card;
}

function renderPhotoList(list, box, addBtn) {
  box.replaceChildren(
    ...list.map((file, i) => {
      const remove = el("button", { className: "preview-remove", type: "button", "aria-label": "Foto entfernen" }, "×");
      remove.onclick = () => {
        list.splice(i, 1);
        renderPhotoList(list, box, addBtn);
      };
      return el("div", { className: "preview" }, el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }), remove);
    })
  );
  addBtn.hidden = list.length >= MAX_PHOTOS;
}

function renderPreviews() {
  renderPhotoList(pendingPhotos, $("post-previews"), $("post-photo-btn"));
}

// Lädt Fotos in den privaten Speicher und gibt die Pfade zurück
async function uploadPostPhotos(files) {
  const uploaded = [];
  try {
    for (const file of files) {
      const blob = await resizeToJpeg(file, 1000);
      const path = `${me.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from("post-images").upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
      if (error) throw error;
      uploaded.push(path);
    }
  } catch (err) {
    if (uploaded.length) await sb.storage.from("post-images").remove(uploaded);
    throw err;
  }
  return uploaded;
}

async function createPost(fields) {
  const { error } = await sb.from("posts").insert(fields);
  if (error) throw error;
}

$("tab-feed").onclick = () => showTab("feed");
$("feed-more").onclick = () => {
  feedLimit += FEED_PAGE;
  loadFeed();
};

$("post-new").onclick = () => {
  $("post-form").reset();
  pendingPhotos = [];
  renderPreviews();
  $("post-status").textContent = "";
  $("post-submit").disabled = false;
  const select = $("post-book");
  select.replaceChildren(el("option", { value: "" }, "– kein Buch –"));
  for (const b of [...myLibrary].sort((a, c) => collator.compare(a.title, c.title))) {
    select.append(el("option", { value: b.id }, b.title));
  }
  $("post-dialog").showModal();
};
$("post-close").onclick = () => $("post-dialog").close();
$("post-photo-btn").onclick = () => $("post-photos").click();
$("post-photos").onchange = (event) => {
  const room = MAX_PHOTOS - pendingPhotos.length;
  pendingPhotos.push(...[...event.target.files].slice(0, room));
  event.target.value = "";
  renderPreviews();
};

$("post-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = $("post-body").value.trim();
  if (!body) return;
  $("post-submit").disabled = true;
  $("post-status").textContent = pendingPhotos.length ? "Lade Fotos hoch …" : "Veröffentliche …";
  let uploaded = [];
  try {
    uploaded = await uploadPostPhotos(pendingPhotos);
    await createPost({
      title: $("post-title").value.trim() || null,
      body,
      images: uploaded,
      book_id: $("post-book").value || null,
    });
    $("post-dialog").close();
    feedLimit = FEED_PAGE;
    loadFeed();
  } catch (err) {
    if (uploaded.length) await sb.storage.from("post-images").remove(uploaded);
    $("post-status").textContent = "Das hat nicht geklappt: " + err.message;
    $("post-submit").disabled = false;
  }
};

// ---------- Eintrag bearbeiten ----------

let editPost = null;
let editRating = 0;

function renderEditStars() {
  $("edit-post-stars").replaceChildren(
    ...[1, 2, 3, 4, 5].map((n) => {
      const star = el(
        "button",
        { type: "button", className: n <= editRating ? "star on" : "star" },
        n <= editRating ? "★" : "☆"
      );
      star.setAttribute("aria-label", `${n} ${n === 1 ? "Stern" : "Sterne"}`);
      star.onclick = () => {
        editRating = n;
        renderEditStars();
      };
      return star;
    })
  );
}

function openEditPost(post) {
  editPost = post;
  editRating = post.rating || 0;
  $("edit-post-title").value = post.title || "";
  $("edit-post-title").hidden = !!post.auto;
  $("edit-post-body").value = post.body || "";
  $("edit-post-stars-wrap").hidden = !post.rating;
  if (post.rating) renderEditStars();
  $("edit-post-status").textContent = "";
  $("edit-post-submit").disabled = false;
  $("edit-post-dialog").showModal();
}
$("edit-post-close").onclick = () => $("edit-post-dialog").close();

$("edit-post-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = $("edit-post-body").value.trim();
  if (!body || !editPost) return;
  $("edit-post-submit").disabled = true;
  $("edit-post-status").textContent = "Speichere …";
  const fields = { body };
  if (!editPost.auto) fields.title = $("edit-post-title").value.trim() || null;
  if (editPost.rating) fields.rating = editRating;
  const { error } = await sb.from("posts").update(fields).eq("id", editPost.id);
  if (error) {
    $("edit-post-status").textContent = "Das hat nicht geklappt: " + error.message;
    $("edit-post-submit").disabled = false;
    return;
  }
  $("edit-post-dialog").close();
  loadFeed();
};

// ---------- Buch abgeschlossen: Sterne + Bewertung ----------

let finishBook = null;
let finishRating = 0;
let finishPhotos = [];

function renderFinishStars() {
  $("finish-stars").replaceChildren(
    ...[1, 2, 3, 4, 5].map((n) => {
      const star = el(
        "button",
        { type: "button", className: n <= finishRating ? "star on" : "star", "aria-label": `${n} ${n === 1 ? "Stern" : "Sterne"}` },
        n <= finishRating ? "★" : "☆"
      );
      star.onclick = () => {
        finishRating = n;
        renderFinishStars();
      };
      return star;
    })
  );
}

function openFinishDialog(book) {
  finishBook = book;
  finishRating = book.entry.rating || 0;
  finishPhotos = [];
  $("finish-form").reset();
  $("finish-book").replaceChildren(
    el("div", { className: "row-cover" }, coverElement(book)),
    el("div", {}, el("div", { className: "title" }, book.title), el("div", { className: "author" }, book.authors.join(", ")))
  );
  renderFinishStars();
  renderPhotoList(finishPhotos, $("finish-previews"), $("finish-photo-btn"));
  $("finish-form").hidden = true;
  $("finish-choice").hidden = false;
  $("finish-status").textContent = "";
  $("finish-submit").disabled = false;
  $("finish-dialog").showModal();
}

// Sterne auch in der eigenen Bibliothek speichern
async function applyFinishRating() {
  if (!finishRating) return;
  await saveEntry(finishBook, { ...finishBook.entry, rating: finishRating });
  await reloadMyLibrary();
  renderLibrary();
  renderHome();
}

function finishDone() {
  $("finish-dialog").close();
  showTab("feed"); // Beitrag auf der Pinnwand ansehen
}

$("finish-close").onclick = () => $("finish-dialog").close();
$("finish-skip").onclick = () => $("finish-dialog").close();
$("finish-write").onclick = () => {
  $("finish-choice").hidden = true;
  $("finish-form").hidden = false;
  $("finish-status").textContent = "";
  $("finish-text").focus();
};
$("finish-back").onclick = () => {
  $("finish-form").hidden = true;
  $("finish-choice").hidden = false;
};
$("finish-photo-btn").onclick = () => $("finish-photos").click();
$("finish-photos").onchange = (event) => {
  finishPhotos.push(...[...event.target.files].slice(0, MAX_PHOTOS - finishPhotos.length));
  event.target.value = "";
  renderPhotoList(finishPhotos, $("finish-previews"), $("finish-photo-btn"));
};

// Option 2: nur Sterne -> automatischer Beitrag "<Name> hat <Buch> abgeschlossen."
$("finish-stars-only").onclick = async () => {
  if (!finishRating) {
    $("finish-status").textContent = "Bitte wähle zuerst Sterne aus.";
    return;
  }
  $("finish-status").textContent = "Veröffentliche …";
  try {
    await applyFinishRating();
    await createPost({
      body: `${me.display_name} hat „${finishBook.title}“ abgeschlossen.`,
      book_id: finishBook.id,
      rating: finishRating,
      auto: true,
      started_at: finishBook.entry.startedAt || null,
      finished_at: finishBook.entry.finishedAt || null,
    });
    finishDone();
  } catch (err) {
    $("finish-status").textContent = "Das hat nicht geklappt: " + err.message;
  }
};

// Option 1: eigene Bewertung mit Überschrift, Text, Fotos und Sternen
$("finish-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = $("finish-text").value.trim();
  if (!body) return;
  $("finish-submit").disabled = true;
  $("finish-status").textContent = finishPhotos.length ? "Lade Fotos hoch …" : "Veröffentliche …";
  let uploaded = [];
  try {
    uploaded = await uploadPostPhotos(finishPhotos);
    await createPost({
      title: $("finish-headline").value.trim() || `Meine Bewertung zu „${finishBook.title}“`,
      body,
      images: uploaded,
      book_id: finishBook.id,
      rating: finishRating || null,
      started_at: finishBook.entry.startedAt || null,
      finished_at: finishBook.entry.finishedAt || null,
    });
    await applyFinishRating();
    finishDone();
  } catch (err) {
    if (uploaded.length) await sb.storage.from("post-images").remove(uploaded);
    $("finish-status").textContent = "Das hat nicht geklappt: " + err.message;
    $("finish-submit").disabled = false;
  }
};

// ---------- Verbindung ----------

function renderFriendPanel() {
  $("my-code").textContent = me.invite_code;
  $("friend-info").textContent = friend
    ? `Verbunden mit ${friend.display_name}.`
    : "Noch nicht verbunden. Schick deiner Freundin deinen Code oder gib hier ihren ein.";
  $("connect-form").hidden = !!friend;
  $("friend-connect").hidden = !!friend; // ist verbunden: Einladungscode wird nicht mehr gebraucht
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


// ---------- BookClub: Buddy Read ----------

// Startbestand (wird einmalig angelegt, wenn noch kein Buddy Read existiert): [Suche, Status, Autorenname]
const TRACKER_YEAR = "2027";
const BUDDY_SEED = [
  ["Iron Flame Rebecca Yarros", "active", "yarros"],
  ["Emma Jane Austen", "proposed", "austen"],
];

const LOCK_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
let buddy = { reads: [], votes: [], comments: [], locked: [], friendLib: [] };
let buddySeeding = false;

function currentPage(b) {
  if (!b || !b.entry) return 0;
  const e = b.entry;
  if (e.status === "read") return Infinity;
  if (e.progressMode === "percent" && b.pages) return Math.round(((e.progressPercent || 0) / 100) * b.pages);
  if (e.progressMode === "chapter" && e.chaptersTotal && b.pages) return Math.round(((e.progressChapter || 0) / e.chaptersTotal) * b.pages);
  return e.progress || 0;
}

async function seedBuddy() {
  if (buddySeeding) return;
  buddySeeding = true;
  try {
    for (const [query, status, authorPart] of BUDDY_SEED) {
      const found = await searchBooks(query, "de");
      const book = found.find((b) => b.authors.join(" ").toLowerCase().includes(authorPart) && b.cover) || found.find((b) => b.authors.join(" ").toLowerCase().includes(authorPart)) || found[0];
      if (!book) continue;
      const { error: be } = await sb.from("books").upsert(bookToDb(book), { onConflict: "id", ignoreDuplicates: true });
      if (be) throw be;
      const { error } = await sb.from("buddy_reads").upsert({ book_id: book.id, status, proposed_by: me.id }, { onConflict: "book_id", ignoreDuplicates: true });
      if (error) throw error;
    }
  } finally {
    buddySeeding = false;
  }
}

async function loadBuddy() {
  let res = await sb.from("buddy_reads").select("id, book_id, status, proposed_by, created_at, rank, books(*)").order("created_at");
  if (res.error) throw res.error;
  if (!res.data.length) {
    await seedBuddy();
    res = await sb.from("buddy_reads").select("id, book_id, status, proposed_by, created_at, rank, books(*)").order("created_at");
    if (res.error) throw res.error;
  }
  buddy.reads = res.data.map((r) => ({ ...r, book: dbToBook(r.books) }));
  const [votes, comments] = await Promise.all([
    sb.from("buddy_votes").select("read_id, user_id, vote"),
    sb.from("buddy_comments").select("id, read_id, user_id, body, page, created_at").order("created_at", { ascending: false }),
  ]);
  buddy.votes = votes.data || [];
  buddy.comments = comments.data || [];
  // Gesperrte Kommentare der anderen Person (nur Seite und Anzahl, der Text wird von der Datenbank nicht ausgeliefert)
  buddy.locked = [];
  const act = buddy.reads.find((r) => r.status === "active");
  if (act) {
    try {
      const { data } = await sb.rpc("buddy_locked_counts", { p_read: act.id });
      buddy.locked = (data || []).map((r) => ({ page: Number(r.page), n: Number(r.n) }));
    } catch (e) {}
  }
  try {
    buddy.friendLib = friend ? await fetchLibrary(friend.id) : [];
  } catch (e) {
    buddy.friendLib = [];
  }
}


function isBuddyBook(bookId) {
  return buddy.reads.some((r) => r.status === "active" && r.book_id === bookId);
}

// Aktiver Buddy Read landet einmalig automatisch unter "Ich lese gerade"
async function ensureBuddyInLibrary() {
  const active = buddy.reads.find((r) => r.status === "active");
  if (!active) return false;
  const key = "coread-buddy-joined-" + active.id;
  try {
    if (localStorage.getItem(key)) return false;
  } catch (e) {}
  const mine = myLibrary.find((b) => b.id === active.book_id);
  if (mine && (mine.entry.status === "reading" || mine.entry.status === "read")) {
    try { localStorage.setItem(key, "1"); } catch (e) {}
    return false;
  }
  const base = mine ? mine.entry : { owned: false, audiobook: false, finishedAt: null, progress: null, rating: null };
  await saveEntry(mine || active.book, { ...base, status: "reading", startedAt: (mine && mine.entry.startedAt) || todayLocal() });
  try { localStorage.setItem(key, "1"); } catch (e) {}
  await reloadMyLibrary();
  return true;
}

async function syncBuddy() {
  try {
    await loadBuddy();
    if (await ensureBuddyInLibrary()) renderHome();
    else renderHome();
  } catch (e) {}
}

function buddyProgressRow(label, lib) {
  const row = el("div", { className: "buddy-prog" });
  const head = el("div", { className: "buddy-prog-head" }, el("strong", {}, label));
  if (!lib || !lib.entry || (!lib.entry.status && lib.entry.progress == null)) {
    const empty = el("div", { className: "bar-fill" });
    empty.style.width = "0%";
    row.append(head, el("div", { className: "bar" }, empty), el("div", { className: "meta" }, "0 % · noch nicht begonnen"));
    return row;
  }
  if (lib.entry.status === "read") {
    const full = el("div", { className: "bar-fill" });
    full.style.width = "100%";
    row.append(head, el("div", { className: "bar" }, full), el("div", { className: "meta" }, "Fertig gelesen"));
    return row;
  }
  const info = progressInfo(lib);
  const fill = el("div", { className: "bar-fill" });
  fill.style.width = info.pct + "%";
  row.append(head, el("div", { className: "bar" }, fill), el("div", { className: "meta" }, info.text));
  return row;
}

function buddyCover(book) {
  const own = myLibrary.find((b) => b.id === book.id);
  return coverElement(own ? { ...book, cover: own.cover } : book);
}


function buddySeenAt(readId) {
  try {
    return localStorage.getItem("coread-buddy-seen-" + readId) || "1970-01-01T00:00:00Z";
  } catch (e) {
    return "1970-01-01T00:00:00Z";
  }
}


async function renderBuddyThread() {
  const box = $("buddy-thread");
  try {
    await loadBuddy();
  } catch (err) {
    box.replaceChildren(el("p", { className: "meta" }, "Konnte nicht geladen werden: " + err.message));
    return;
  }
  const active = buddy.reads.find((r) => r.status === "active");
  if (!active) {
    $("buddy-title").textContent = "Buddy Read";
    box.replaceChildren(el("p", { className: "meta" }, "Gerade läuft kein Buddy Read."));
    $("buddy-composer").hidden = true;
    return;
  }
  $("buddy-composer").hidden = false;
  const book = active.book;
  $("buddy-title").textContent = book.title;
  const nick = friendNick || "deine Freundin";
  const mine = myLibrary.find((b) => b.id === book.id);
  const myPage = currentPage(mine);
  const total = (mine && mine.pages) || book.pages || 0;
  const pctText = (p) => (total ? ` (${Math.min(100, Math.round((p / total) * 100))} %)` : "");
  const pageIn = $("buddy-page");
  if (pageIn.dataset.read !== active.id) {
    pageIn.value = Number.isFinite(myPage) && myPage > 0 ? String(myPage) : "";
    pageIn.dataset.read = active.id;
  }

  const comments = buddy.comments.filter((c) => c.read_id === active.id).sort((a, b) => ((a.page ?? -1) - (b.page ?? -1)) || (a.created_at < b.created_at ? -1 : 1));
  if (!comments.length && !buddy.locked.length) {
    box.replaceChildren(el("p", { className: "meta" }, "Noch keine Kommentare. Schreib den ersten unten."));
    return;
  }
  const seen = buddySeenAt(active.id);
  // Nach Seite gruppieren (wie im Buch), verdeckte Kommentare einer Seite zu einer Karte bündeln
  const groups = new Map();
  for (const c of comments) {
    const key = c.page == null ? "all" : String(c.page);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const l of buddy.locked) if (!groups.has(String(l.page))) groups.set(String(l.page), []);
  const keys = [...groups.keys()].sort((x, y) => (x === "all" ? -1 : y === "all" ? 1 : Number(x) - Number(y)));
  for (const key of keys) {
    const list = groups.get(key);
    const page = key === "all" ? null : Number(key);
    const title = page == null ? "Allgemein" : `Seite ${page}${pctText(page)}`;
    const lockedN = page == null ? 0 : (buddy.locked.find((l) => l.page === page) || { n: 0 }).n;
    const card = el("div", { className: "buddy-group" }, el("div", { className: "buddy-group-title" }, title));
    for (const c of list) {
      const own = c.user_id === me.id;
      const item = el("div", { className: "buddy-comment" + (own ? " own" : "") });
      item.append(el("div", { className: "meta" }, `${own ? "Du" : nick} · ${new Date(c.created_at).toLocaleDateString("de-DE")}${!own && c.created_at > seen ? " · neu" : ""}`), el("div", { className: "buddy-body" }, c.body));
      if (own) {
        const del = el("button", { className: "link-btn", type: "button" }, "Löschen");
        del.onclick = async () => {
          if (!confirm("Kommentar löschen?")) return;
          await sb.from("buddy_comments").delete().eq("id", c.id);
          renderBuddyThread();
        };
        item.append(del);
      }
      card.append(item);
    }
    if (lockedN) {
      const lock = el("div", { className: "buddy-lock" });
      lock.innerHTML = LOCK_SVG;
      lock.append(
        el("span", { className: "buddy-lock-text" }, el("strong", {}, lockedN === 1 ? "1 Kommentar gesperrt" : `${lockedN} Kommentare gesperrt`), el("span", { className: "meta" }, `Er wird sichtbar, sobald du Seite ${page}${pctText(page)} erreichst.`))
      );
      card.append(lock);
    }
    out.push(card);
  }
  box.replaceChildren(...out);
  // Beim Ansehen gelten Kommentare als gelesen
  const newest = comments.reduce((m, c) => (c.created_at > m ? c.created_at : m), seen);
  try {
    localStorage.setItem("coread-buddy-seen-" + active.id, newest);
  } catch (e) {}
}

$("buddy-composer").onsubmit = async (event) => {
  event.preventDefault();
  const active = buddy.reads.find((r) => r.status === "active");
  const area = $("buddy-text");
  if (!active || !area.value.trim()) return;
  const send = $("buddy-send");
  send.disabled = true;
  const pageVal = $("buddy-page").value;
  const { error } = await sb.from("buddy_comments").insert({ read_id: active.id, body: area.value.trim(), page: pageVal === "" ? null : Math.max(0, Math.round(Number(pageVal))) });
  send.disabled = false;
  if (error) {
    alert("Das hat nicht geklappt: " + error.message);
    return;
  }
  area.value = "";
  renderBuddyThread();
};
$("buddy-back").onclick = () => showTab("bookclub");

// Nach einem Fortschritts-Update: sind Kommentare der anderen Person freigeschaltet worden?
async function checkBuddyUnlocks(bookId, beforePage) {
  try {
    await loadBuddy();
    const active = buddy.reads.find((r) => r.status === "active" && r.book_id === bookId);
    if (!active) return;
    const now = currentPage(myLibrary.find((b) => b.id === bookId));
    const count = buddy.comments.filter((c) => c.read_id === active.id && c.user_id !== me.id && c.page != null && c.page > beforePage && c.page <= now).length;
    if (!count) return;
    $("unlock-text").textContent = count === 1 ? "1 neuer Kommentar freigeschaltet" : `${count} neue Kommentare freigeschaltet`;
    $("unlock-dialog").showModal();
  } catch (e) {}
}
$("unlock-open").onclick = () => {
  $("unlock-dialog").close();
  showTab("buddy");
};
$("unlock-close").onclick = () => $("unlock-dialog").close();

function libPct(lib) {
  if (!lib || !lib.entry) return 0;
  if (lib.entry.status === "read") return 100;
  if (lib.entry.status !== "reading" && lib.entry.progress == null) return 0;
  return progressInfo(lib).pct || 0;
}

function libLabel(lib) {
  if (!lib || !lib.entry || (!lib.entry.status && lib.entry.progress == null)) return "0 % · S. 0";
  if (lib.entry.status === "read") return "100 % · fertig";
  const info = progressInfo(lib);
  const page = currentPage(lib);
  return `${info.pct} % · S. ${Number.isFinite(page) && page > 0 ? page : 0}`;
}

async function renderBuddy() {
  const box = $("buddy");
  let first = !buddy.reads.length;
  if (first) box.replaceChildren(el("p", { className: "meta" }, "Lade Buddy Read …"));
  try {
    await loadBuddy();
  } catch (err) {
    box.replaceChildren(el("h3", {}, "Buddy Read"), el("p", { className: "meta" }, "Konnte nicht geladen werden: " + err.message));
    return;
  }
  try {
    if (await ensureBuddyInLibrary()) renderHome();
  } catch (e) {}
  const nick = friendNick || "deine Freundin";
  const active = buddy.reads.find((r) => r.status === "active");
  const proposals = buddy.reads.filter((r) => r.status === "proposed");
  box.replaceChildren();

  // --- aktuelles Buch: kompakte weiße Karte mit gemeinsamem Lesepfad ---
  if (active) {
    const b = active.book;
    const mine = myLibrary.find((x) => x.id === b.id);
    const theirs = buddy.friendLib.find((x) => x.id === b.id);
    const myPct = libPct(mine);
    const theirPct = libPct(theirs);
    const myPage = currentPage(mine);
    const total = (mine && mine.pages) || b.pages || 0;
    const day = Math.max(1, Math.floor((Date.now() - new Date(active.created_at).getTime()) / 86400000) + 1);

    // Groß/klein umschalten (wie bei "Ich lese gerade" auf der Startseite)
    let big = false;
    try { big = localStorage.getItem("coread-buddy-big") === "1"; } catch (e) {}
    const chevDown = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>';
    const chevUp = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>';
    const toggle = el("button", { className: "hero-toggle bcard-toggle", type: "button" });
    const card = el("div", { className: "bcard" + (big ? " big" : "") });
    const paintToggle = () => {
      toggle.innerHTML = big ? chevUp : chevDown;
      toggle.setAttribute("aria-label", big ? "Buddy Read kompakt anzeigen" : "Buddy Read groß anzeigen");
      card.classList.toggle("big", big);
    };
    toggle.onclick = () => {
      big = !big;
      try { localStorage.setItem("coread-buddy-big", big ? "1" : "0"); } catch (e) {}
      paintToggle();
    };
    paintToggle();
    const cover = el("div", { className: "bcard-cover" });
    cover.append(buddyCover(b));
    cover.onclick = () => showDetail(mine || b, false);
    const head = el(
      "div",
      { className: "bcard-head" },
      el("div", { className: "bcard-titleline" }, el("div", { className: "bcard-title" }, b.title), toggle),
      el("div", { className: "meta" }, b.authors.join(", "), el("span", { className: "bcard-day" }, ` · Tag ${day}`))
    );

    // Fortschritt: zwei Balken (du und die Freundin)
    const initial = (name) => ((name || "?").trim()[0] || "?").toUpperCase();
    const trackBox = el("div", {});
    const statsBox = el("div", {});
    const buildBars = () => {
      const row = (cls, name, pct, label) => {
        const fill = el("div", { className: "bbar-fill " + cls });
        fill.style.width = pct + "%";
        const bar = el("div", { className: "bbar" }, el("div", { className: "bbar-bg" }, fill));
        return el("div", { className: "bbar-row" }, el("div", { className: "btrack-mark bbar-badge " + cls }, initial(name)), bar, el("span", { className: "bbar-text" }, label));
      };
      const wrap = el("div", { className: "bbars" }, row("mine", me.display_name, myPct, libLabel(mine)), row("friend", friend ? friend.display_name : nick, theirPct, libLabel(theirs)));
      return { track: wrap, stats: null };
    };
    trackBox.replaceChildren(buildBars().track);
    const topRow = el("div", { className: "bcard-top" }, cover, el("div", { className: "bcard-main" }, head, trackBox));
    card.append(topRow, statsBox);


    // Update + Kommentare in einer Zeile
    const actions = el("div", { className: "bcard-actions" });
    if (!mine) {
      const add = el("button", { className: "btn", type: "button" }, "In meine Bibliothek");
      add.onclick = () => showDetail(b, false, { owned: false, status: "reading" });
      actions.append(add);
    } else if (mine.entry.status === "reading") {
      const { form, msg } = buildProgressForm(mine, {
        compact: true,
        onSaved: async () => {
          const before = currentPage(mine);
          await reloadMyLibrary();
          renderHome();
          renderBuddy();
          checkBuddyUnlocks(mine.id, before);
        },
      });
      actions.append(el("div", { className: "bcard-form" }, form, msg));
    }
    const others = buddy.comments.filter((c) => c.read_id === active.id && c.user_id !== me.id);
    const seen = buddySeenAt(active.id);
    const fresh = others.filter((c) => c.created_at > seen && (c.page == null || c.page <= myPage)).length;
    const commentCount = buddy.comments.filter((c) => c.read_id === active.id).length + buddy.locked.reduce((s, l) => s + l.n, 0);
    const open = el("button", { className: "bcard-comments" + (fresh ? " has-new" : ""), type: "button" });
    open.setAttribute("aria-label", fresh ? `${commentCount} Kommentare, ${fresh} neu` : `${commentCount} Kommentare`);
    open.append(el("span", { className: "bcard-count" }, String(commentCount)));
    open.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 21l1.9-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg>');
    open.onclick = () => showTab("buddy");
    actions.append(open);
    card.append(actions);
    box.append(card);
  } else {
    box.append(el("p", { className: "meta" }, "Gerade läuft kein Buddy Read. Schlagt unten eins vor."));
  }

  // --- Rangliste: bis zu drei Vorschläge, per Drag and Drop auf Platz 1 bis 3 ziehen ---
  const ranked = [...proposals].sort((x, y) => (x.rank ?? 999) - (y.rank ?? 999) || (x.created_at < y.created_at ? -1 : 1));
  const head = el("div", { className: "bprop-head" }, el("span", {}, "Next Read:"));
  if (ranked.length < 3) {
    const addBtn = el("button", { className: "bprop-add", type: "button" }, "+");
    addBtn.setAttribute("aria-label", "Buch vorschlagen");
    addBtn.onclick = () => {
      addKind = "buddy";
      $("add-title").textContent = "Buddy Read vorschlagen";
      $("add-query").value = "";
      $("add-status").textContent = "";
      $("add-dialog").showModal();
      showLibraryMatches();
      $("add-query").focus();
    };
    head.append(addBtn);
  }
  box.append(head);
  if (!ranked.length) box.append(el("p", { className: "meta" }, "Noch keine Vorschläge. Mit + schlägst du ein Buch vor (bis zu drei)."));
  const thumb = thumbSvg;
  const gal = el("div", { className: "bgal" });
  const voteOf = (p, uid) => buddy.votes.find((v) => v.read_id === p.id && (uid ? v.user_id === uid : v.user_id !== me.id));
  const castVote = async (p, value) => {
    const myVote = buddy.votes.find((v) => v.read_id === p.id && v.user_id === me.id);
    const { error } = myVote && myVote.vote === value
      ? await sb.from("buddy_votes").delete().eq("read_id", p.id).eq("user_id", me.id)
      : await sb.from("buddy_votes").upsert({ read_id: p.id, user_id: me.id, vote: value }, { onConflict: "read_id,user_id" });
    if (error) return alert("Das hat nicht geklappt: " + error.message);
    await renderBuddy();
  };
  ranked.forEach((p, i) => {
    const myVote = voteOf(p, me.id);
    const theirVote = voteOf(p, null);
    const item = el("div", { className: "bgal-item" });
    item.dataset.id = p.id;
    const cover = el("button", { className: "bgal-cover", type: "button" });
    cover.setAttribute("aria-label", `${p.book.title}: Details, Reihenfolge und Kommentare`);
    cover.append(buddyCover(p.book), el("span", { className: "bgal-rank" }, String(i + 1)));
    cover.onclick = () => openProposal(p.id);
    const up = el("button", { className: "bprop-btn" + (myVote && myVote.vote ? " on" : ""), type: "button", title: "Daumen hoch" });
    const down = el("button", { className: "bprop-btn no" + (myVote && !myVote.vote ? " on" : ""), type: "button", title: "Daumen runter" });
    up.innerHTML = thumb(true);
    down.innerHTML = thumb(false);
    up.setAttribute("aria-label", "Daumen hoch");
    down.setAttribute("aria-label", "Daumen runter");
    up.onclick = () => castVote(p, true);
    down.onclick = () => castVote(p, false);
    const theirs = el("span", { className: "bgal-chip " + (theirVote ? (theirVote.vote ? "yes" : "no") : "") }, theirVote ? (theirVote.vote ? `${nick}: dafür` : `${nick}: dagegen`) : `${nick}: offen`);
    const nComments = buddy.comments.filter((c) => c.read_id === p.id).length;
    const meta = el("div", { className: "bgal-votes" }, up, down);
    item.append(cover, el("div", { className: "bgal-title" }, p.book.title), meta, theirs);
    if (nComments) item.append(el("div", { className: "bgal-cmt meta" }, `${nComments} Kommentar${nComments === 1 ? "" : "e"}`));
    gal.append(item);
  });
  if (ranked.length) box.append(gal);
  enableGalleryDrag(gal);
  const agreed = ranked.find((p) => {
    const mv = voteOf(p, me.id), tv = voteOf(p, null);
    return mv && mv.vote && tv && tv.vote;
  });
  if (agreed) {
    const start = el("button", { className: "btn bgal-start", type: "button" }, `${agreed.book.title} starten · ihr seid euch einig`);
    start.onclick = () => startProposal(agreed);
    box.append(start);
  }

  // --- Tracker 2027: gelesene Bücher und Seiten, beide Konten zusammen ---
  const readIn = (lib) => (lib || []).filter((b) => b.entry && b.entry.status === "read" && b.entry.finishedAt && b.entry.finishedAt.startsWith(TRACKER_YEAR));
  const mineRead = readIn(myLibrary);
  const theirRead = readIn(buddy.friendLib);
  const pages = (list) => list.reduce((sum, b) => sum + (b.pages || 0), 0);
  const fmtN = (n) => n.toLocaleString("de-DE");
  const tile = (label, mineVal, theirVal) =>
    el(
      "div",
      { className: "btile" },
      el("div", { className: "btile-label" }, label),
      el("div", { className: "btile-number" }, fmtN(mineVal + theirVal)),
      el("div", { className: "btile-sub" }, `Du ${fmtN(mineVal)} · ${nick} ${fmtN(theirVal)}`)
    );
  box.append(
    el("div", { className: "btiles" }, tile(`Gelesene Bücher ${TRACKER_YEAR}`, mineRead.length, theirRead.length), tile(`Gelesene Seiten ${TRACKER_YEAR}`, pages(mineRead), pages(theirRead)))
  );
}

// Rangliste per Finger/Maus verschieben (Ziehgriff links); speichert die neue Reihenfolge
function thumbSvg(up) {
  return up
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9h3zM7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7a2 2 0 0 1-2 1.7H7"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13V4h3v9h-3zM17 13l-4 8a2 2 0 0 1-2-2v-4H5.5a2 2 0 0 1-2-2.3l1.2-7a2 2 0 0 1 2-1.7H17"/></svg>';
}

async function startProposal(p) {
  const active = buddy.reads.find((r) => r.status === "active");
  if (active) await sb.from("buddy_reads").update({ status: "done" }).eq("id", active.id);
  await sb.from("buddy_reads").update({ status: "active", rank: null }).eq("id", p.id);
  if ($("prop-dialog").open) $("prop-dialog").close();
  renderBuddy();
}

// Detailfenster eines Next-Read-Vorschlags: Reihenfolge, Abstimmung, kurze Debatte, Entfernen
function openProposal(id) {
  const ranked = [...buddy.reads.filter((r) => r.status === "proposed")].sort((x, y) => (x.rank ?? 999) - (y.rank ?? 999) || (x.created_at < y.created_at ? -1 : 1));
  const idx = ranked.findIndex((r) => r.id === id);
  if (idx < 0) {
    if ($("prop-dialog").open) $("prop-dialog").close();
    return;
  }
  const p = ranked[idx];
  const nick = friendNick || "deine Freundin";
  const votes = buddy.votes.filter((v) => v.read_id === p.id);
  const myVote = votes.find((v) => v.user_id === me.id);
  const theirVote = votes.find((v) => v.user_id !== me.id);
  const fmt = (v) => (v ? (v.vote ? "dafür" : "dagegen") : "noch offen");
  const refresh = async () => {
    await renderBuddy();
    openProposal(id);
  };
  const vote = async (value) => {
    const { error } = myVote && myVote.vote === value
      ? await sb.from("buddy_votes").delete().eq("read_id", p.id).eq("user_id", me.id)
      : await sb.from("buddy_votes").upsert({ read_id: p.id, user_id: me.id, vote: value }, { onConflict: "read_id,user_id" });
    if (error) return alert("Das hat nicht geklappt: " + error.message);
    await refresh();
  };

  const top = el("div", { className: "prop-top" }, el("div", { className: "bprop-cover" }, buddyCover(p.book)),
    el("div", {}, el("div", { className: "bprop-title" }, p.book.title), el("div", { className: "meta" }, p.book.authors.join(", ")), el("div", { className: "meta" }, `Platz ${idx + 1} · Du: ${fmt(myVote)} · ${nick}: ${fmt(theirVote)}`)));
  const upBtn = el("button", { className: "btn prop-thumb" + (myVote && myVote.vote ? "" : " secondary"), type: "button" });
  const downBtn = el("button", { className: "btn prop-thumb" + (myVote && !myVote.vote ? "" : " secondary"), type: "button" });
  upBtn.innerHTML = thumbSvg(true);
  downBtn.innerHTML = thumbSvg(false);
  upBtn.setAttribute("aria-label", "Daumen hoch");
  downBtn.setAttribute("aria-label", "Daumen runter");
  upBtn.onclick = () => vote(true);
  downBtn.onclick = () => vote(false);
  const rows = [top, el("div", { className: "actions" }, upBtn, downBtn)];

  if (myVote && myVote.vote && theirVote && theirVote.vote) {
    const start = el("button", { className: "btn", type: "button" }, "Als Buddy Read starten");
    start.onclick = () => startProposal(p);
    rows.push(el("div", { className: "actions" }, start));
  }

  // Kurze Debatte (nutzt dieselben Kommentare wie der Buddy Read, ohne Seitenzahl)
  const list = el("div", { className: "prop-comments" });
  const cs = buddy.comments.filter((c) => c.read_id === p.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  if (!cs.length) list.append(el("p", { className: "meta" }, "Noch keine Kommentare. Warum dafür oder dagegen?"));
  for (const c of cs) {
    const mineC = c.user_id === me.id;
    const line = el("div", { className: "prop-comment" + (mineC ? " mine" : "") }, el("strong", {}, (mineC ? "Du" : nick) + ": "), c.body);
    if (mineC) {
      const x = el("button", { className: "bprop-x", type: "button" }, "löschen");
      x.onclick = async () => {
        await sb.from("buddy_comments").delete().eq("id", c.id);
        await refresh();
      };
      line.append(" ", x);
    }
    list.append(line);
  }
  const area = el("textarea", { rows: 2, maxLength: 300, placeholder: "Kurz begründen …" });
  area.setAttribute("aria-label", "Kommentar");
  const send = el("button", { className: "btn", type: "button" }, "Senden");
  send.onclick = async () => {
    const body = area.value.trim();
    if (!body) return;
    send.disabled = true;
    const { error } = await sb.from("buddy_comments").insert({ read_id: p.id, body });
    if (error) {
      send.disabled = false;
      return alert("Das hat nicht geklappt: " + error.message);
    }
    await refresh();
  };
  rows.push(el("div", { className: "pref-label" }, "Kommentar:"), list, area, el("div", { className: "actions" }, send));

  // Entfernen: wer vorgeschlagen hat, jederzeit; sonst, wenn ihr beide dagegen seid
  const bothNo = myVote && !myVote.vote && theirVote && !theirVote.vote;
  if (p.proposed_by === me.id || bothNo) {
    const del = el("button", { className: "bprop-x", type: "button" }, p.proposed_by === me.id ? "Vorschlag zurückziehen" : "Vorschlag entfernen (ihr seid beide dagegen)");
    del.onclick = async () => {
      if (!confirm("Vorschlag entfernen?")) return;
      await sb.from("buddy_reads").delete().eq("id", p.id);
      $("prop-dialog").close();
      renderBuddy();
    };
    rows.push(del);
  }
  $("prop-content").replaceChildren(...rows);
  if (!$("prop-dialog").open) $("prop-dialog").showModal();
}
$("prop-close").onclick = () => $("prop-dialog").close();

// Drag and Drop in der Next-Read-Galerie: gedrückt halten, dann auf die Position eines anderen Buchs ziehen
let galDragging = false;
window.addEventListener("touchmove", (e) => { if (galDragging) e.preventDefault(); }, { passive: false });
function enableGalleryDrag(gal) {
  for (const item of gal.querySelectorAll(".bgal-item")) {
    const cover = item.querySelector(".bgal-cover");
    cover.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      const sx = e.clientX, sy = e.clientY;
      const startOrder = [...gal.children].map((c) => c.dataset.id).join();
      let dragging = false;
      const timer = setTimeout(() => {
        dragging = true;
        galDragging = true;
        item.classList.add("dragging");
      }, 300);
      const renumber = () => [...gal.children].forEach((c, i) => (c.querySelector(".bgal-rank").textContent = String(i + 1)));
      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) end(true);
          return;
        }
        for (const other of gal.children) {
          if (other === item) continue;
          const r = other.getBoundingClientRect();
          if (ev.clientX > r.left && ev.clientX < r.right && ev.clientY > r.top && ev.clientY < r.bottom) {
            if (other.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) gal.insertBefore(item, other);
            else other.after(item);
            renumber();
            break;
          }
        }
      };
      const end = async (cancel) => {
        clearTimeout(timer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        const was = dragging;
        dragging = false;
        galDragging = false;
        item.classList.remove("dragging");
        if (!was) return;
        // Antippen nach dem Ziehen nicht als Klick werten
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        cover.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => cover.removeEventListener("click", stop, true), 400);
        const ids = [...gal.children].map((c) => c.dataset.id);
        if (ids.join() === startOrder) return;
        await Promise.all(ids.map((id, i) => sb.from("buddy_reads").update({ rank: i + 1 }).eq("id", id)));
        renderBuddy();
      };
      const up = () => end(false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }
}

function enableRankDrag(list) {
  for (const grip of list.querySelectorAll(".bprop-grip")) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const row = grip.closest(".bprop");
      grip.setPointerCapture(e.pointerId);
      row.classList.add("dragging");
      const renumber = () => [...list.children].forEach((r, i) => (r.querySelector(".bprop-place").textContent = String(i + 1)));
      const move = (ev) => {
        for (const other of list.children) {
          if (other === row) continue;
          const r = other.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          const rowAfter = other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
          if (ev.clientY < mid && rowAfter) {
            list.insertBefore(row, other);
            renumber();
            break;
          }
          if (ev.clientY > mid && !rowAfter) {
            other.after(row);
            renumber();
            break;
          }
        }
      };
      const done = async () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
        row.classList.remove("dragging");
        const ids = [...list.children].map((r) => r.dataset.id);
        await Promise.all(ids.map((id, i) => sb.from("buddy_reads").update({ rank: i + 1 }).eq("id", id)));
        renderBuddy();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    });
  }
}

// ---------- BookClub: Gemeinsame Klassiker ----------

// [Schlüssel, Titel, Autor:in, Deckelfarbe]. Neue Titel einfach hier anhängen (keine Migration nötig).
// Der Schlüssel wird in der Datenbank gespeichert und darf sich nicht mehr ändern.
const CLASSICS = [
  ["faust", "Faust", "Goethe", "#7a1f2b", "faust.jpg"],
  ["moby-dick", "Moby Dick", "Melville", "#1f4e6b"],
  ["anna-karenina", "Anna Karenina", "Tolstoi", "#5b2a5e", "anna-karenina.jpg"],
  ["unendliche-geschichte", "Die unendliche Geschichte", "Michael Ende", "#a5530f"],
  ["kleiner-prinz", "Der kleine Prinz", "Saint-Exupéry", "#2f6b5e", "kleiner-prinz.jpg"],
  ["1984", "1984", "George Orwell", "#9e1b1b", "1984.jpg"],
  ["stolz-und-vorurteil", "Stolz und Vorurteil", "Jane Austen", "#8a4b6b", "stolz-und-vorurteil.jpg"],
  ["reise-zum-mittelpunkt-der-erde", "Die Reise zum Mittelpunkt der Erde", "Jules Verne", "#3f5f2a"],
  ["krieg-und-frieden", "Krieg und Frieden", "Tolstoi", "#4a4a5e", "krieg-und-frieden.jpg"],
  ["hamlet", "Hamlet", "Shakespeare", "#1e2a4a", "hamlet.jpg"],
  ["wer-die-nachtigall-stoert", "Wer die Nachtigall stört", "Harper Lee", "#6b4a2b"],
  ["faenger-im-roggen", "Der Fänger im Roggen", "J. D. Salinger", "#b0402a"],
  ["die-raeuber", "Die Räuber", "Friedrich Schiller", "#5c2e1b"],
  ["great-gatsby", "The Great Gatsby", "F. Scott Fitzgerald", "#7a5c0e", "great-gatsby.jpg"],
  ["don-quijote", "Don Quijote", "Cervantes", "#a0522d", "don-quijote.jpg"],
  ["jane-eyre", "Jane Eyre", "Charlotte Brontë", "#3b3f6e"],
  ["wuthering-heights", "Wuthering Heights", "Emily Brontë", "#3e4a52", "wuthering-heights.jpg"],
  ["sommernachtstraum", "Ein Sommernachtstraum", "Shakespeare", "#4b2e83", "sommernachtstraum.jpg"],
  ["mord-im-orientexpress", "Mord im Orientexpress", "Agatha Christie", "#2b2b2b"],
  ["tom-sawyer", "Die Abenteuer des Tom Sawyer", "Mark Twain", "#8a5a00"],
  ["huckleberry-finn", "Die Abenteuer des Huckleberry Finn", "Mark Twain", "#4f6f3a"],
  ["odyssee", "Die Odyssee", "Homer", "#0e5a7a", "odyssee.jpg"],
  ["zeitmaschine", "Die Zeitmaschine", "H. G. Wells", "#a33c6b"],
  ["im-westen-nichts-neues", "Im Westen nichts Neues", "Erich Maria Remarque", "#4b4f3a"],
  ["little-women", "Little Women", "Louisa May Alcott", "#c8596a", "little-women.jpg"],
  ["phantom-der-oper", "Das Phantom der Oper", "Gaston Leroux", "#2f3441", "phantom-der-oper.jpg"],
];

async function loadClassics() {
  const { data, error } = await sb.from("classic_reads").select("user_id, classic_id");
  if (error) {
    $("classics-status").textContent =
      "Die Klassiker konnten nicht geladen werden. Wurde Migration 013 im Supabase SQL Editor ausgeführt? (" + error.message + ")";
    return;
  }
  $("classics-status").textContent = "";
  classicReads = data;
}

// Namen derer, die das Buch gelesen haben (ich zuerst)
function classicReaders(id) {
  const names = [];
  if (classicReads.some((r) => r.classic_id === id && r.user_id === me.id)) names.push(me.display_name);
  if (friend && classicReads.some((r) => r.classic_id === id && r.user_id === friend.id)) names.push(friend.display_name);
  return names;
}

function classicCard([id, title, author, color, image]) {
  const readers = classicReaders(id);
  const mine = classicReads.some((r) => r.classic_id === id && r.user_id === me.id);
  const done = readers.length > 0;

  const cover = el("div", { className: "classic-cover" + (done ? " done" : "") });
  cover.style.setProperty("--cover", color);
  if (image) {
    // Buchdeckel als Bild (schwarz-weiß, bis ein Buch gelesen ist)
    cover.classList.add("has-img");
    const img = el("img", { src: `assets/classics/${image}?v=1`, alt: "", loading: "lazy" });
    img.onerror = () => {
      cover.classList.remove("has-img");
      img.remove();
      cover.prepend(el("div", { className: "classic-cover-title" }, title));
    };
    cover.append(img);
  } else {
    cover.append(el("div", { className: "classic-cover-title" }, title));
  }
  if (done) {
    const check = el("span", { className: "classic-check" }, "✓");
    check.setAttribute("aria-hidden", "true");
    cover.append(check);
  }

  const card = el("button", { className: "classic", type: "button" });
  card.setAttribute("aria-pressed", String(mine));
  card.setAttribute(
    "aria-label",
    `${title}: ` + (done ? `gelesen von ${readers.join(" und ")}` : "noch offen") + (mine ? ", Markierung zurücknehmen" : ", als gelesen markieren")
  );
  card.append(
    cover,
    el("div", { className: "classic-title" }, title),
    el("div", { className: "classic-author" }, author),
    el("div", { className: "classic-readers" }, done ? "von " + readers.join(" & ") : "")
  );
  card.onclick = () => toggleClassic(id);
  return card;
}

function renderClassics() {
  if (!me) return;
  // Erklärung verschwindet, sobald das Prinzip einmal benutzt wurde
  let understood = classicReads.some((r) => r.user_id === me.id);
  try {
    understood = understood || localStorage.getItem("coread-classics-hint-done") === "1";
  } catch (e) {}
  $("classics-hint").hidden = understood;
  $("classics-grid").replaceChildren(...CLASSICS.map(classicCard));
}

async function toggleClassic(id) {
  const has = classicReads.some((r) => r.classic_id === id && r.user_id === me.id);
  const { error } = has
    ? await sb.from("classic_reads").delete().eq("user_id", me.id).eq("classic_id", id)
    : await sb.from("classic_reads").insert({ classic_id: id });
  if (error) {
    $("classics-status").textContent = "Das hat nicht geklappt: " + error.message;
    return;
  }
  $("classics-status").textContent = "";
  try {
    localStorage.setItem("coread-classics-hint-done", "1");
  } catch (e) {}
  classicReads = has
    ? classicReads.filter((r) => !(r.classic_id === id && r.user_id === me.id))
    : [...classicReads, { user_id: me.id, classic_id: id }];
  renderClassics();
}


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
    classicReads = [];
    $("bell").hidden = true;
    $("tab-profile").hidden = true;
    $("open-settings").hidden = true;
    for (const id of ["view-home", "view-library", "view-journal", "view-feed", "view-bookclub", "view-profile", "view-friend"]) $(id).hidden = true;
    return;
  }

  try {
    const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
    if (error) throw error;
    me = data;
    await loadFriend();
    // Reiter der Freundin: Zaza sieht "Lindi", alle anderen sehen "Zaza"
    const friendName = /zaza/i.test(me.display_name || "") ? "Lindi" : "Zaza";
    friendNick = friendName;
    $("tab-friend").setAttribute("aria-label", friendName);
    $("tab-friend").title = friendName;
    $("tab-profile").hidden = false;
    $("open-settings").hidden = false;
    await reloadMyLibrary();
    await loadGoals();
    renderFriendPanel();
    refreshBell();
    syncBuddy();
    showTab(resumeView());
    scheduleImageOptimization();
  } catch (err) {
    $("view-auth").hidden = false;
    authMessage("Konnte deine Daten nicht laden: " + err.message);
  }
}

// ---------- Bedienung ----------

// ---------- Glöckchen: neue Beiträge der Freundin ----------

function setBell(count) {
  const badge = $("bell-badge");
  badge.hidden = count < 1;
  badge.textContent = count > 9 ? "9+" : String(count);
  $("bell").setAttribute("aria-label", count ? `${count} Neuigkeiten` : "Neuigkeiten");
}

let bellPosts = 0;
let bellEvents = 0;

async function countEvents(table, extra) {
  let q = sb.from(table).select("user_id", { count: "exact", head: true }).eq("user_id", friend.id).gt("created_at", me.events_seen_at);
  if (extra) q = q.eq("kind", extra);
  const { count, error } = await q;
  return error ? 0 : count || 0;
}

async function refreshBell() {
  const bell = $("bell");
  // ohne Migration 009 (Spalte fehlt) bleibt das Glöckchen unsichtbar
  if (!me || !me.feed_seen_at) {
    bell.hidden = true;
    return;
  }
  bell.hidden = false;
  const { count, error } = await sb
    .from("posts")
    .select("id", { count: "exact", head: true })
    .neq("user_id", me.id)
    .gt("created_at", me.feed_seen_at);
  if (!error) bellPosts = count || 0;
  // Neue Lieblingsbücher und abgehakte Klassiker der anderen Person (ab Migration 016)
  bellEvents = 0;
  if (friend && me.events_seen_at) {
    bellEvents = (await countEvents("profile_books", "favorite")) + (await countEvents("profile_books", "recommendation")) + (await countEvents("classic_reads"));
    const { count: proposalCount, error: proposalError } = await sb
      .from("buddy_reads")
      .select("id", { count: "exact", head: true })
      .eq("proposed_by", friend.id)
      .eq("status", "proposed")
      .gt("created_at", me.events_seen_at);
    if (!proposalError) bellEvents += proposalCount || 0;
  }
  setBell(bellPosts + bellEvents);
}

// Pinnwand wurde angesehen: alles bis zum neuesten Beitrag gilt als gelesen
async function markFeedSeen(newestIso) {
  if (!me || !me.feed_seen_at || !newestIso || newestIso <= me.feed_seen_at) return;
  me.feed_seen_at = newestIso;
  bellPosts = 0;
  setBell(bellEvents);
  await sb.from("profiles").update({ feed_seen_at: newestIso }).eq("id", me.id);
}

// Neuigkeiten-Liste: Pinnwand, neue Lieblingsbücher, abgehakte Klassiker
$("bell").onclick = async () => {
  const nick = friendNick || "Deine Freundin";
  const rows = [];
  if (bellPosts > 0) {
    rows.push({ text: `${nick} hat ${bellPosts === 1 ? "einen neuen Beitrag" : bellPosts + " neue Beiträge"} auf der Pinnwand gepostet.`, go: "feed", fresh: true });
  }
  let newest = null;
  if (friend && me.events_seen_at) {
    const [fav, cls, rec, prop] = await Promise.all([
      sb.from("profile_books").select("created_at, books(title)").eq("user_id", friend.id).eq("kind", "favorite").order("created_at", { ascending: false }).limit(8),
      sb.from("classic_reads").select("created_at, classic_id").eq("user_id", friend.id).order("created_at", { ascending: false }).limit(8),
      sb.from("profile_books").select("created_at, books(title)").eq("user_id", friend.id).eq("kind", "recommendation").order("created_at", { ascending: false }).limit(8),
      sb.from("buddy_reads").select("created_at, books(title)").eq("proposed_by", friend.id).eq("status", "proposed").order("created_at", { ascending: false }).limit(8),
    ]);
    const events = [];
    for (const r of rec.data || []) events.push({ at: r.created_at, text: `${nick} hat dir eine Buchempfehlung eingetragen: ${r.books ? r.books.title : ""}`, go: "friend" });
    for (const r of prop.data || []) events.push({ at: r.created_at, text: `${nick} hat einen Next-Read-Vorschlag eingetragen: ${r.books ? r.books.title : ""}`, go: "bookclub" });
    for (const r of fav.data || []) events.push({ at: r.created_at, text: `${nick} hat ein neues Lieblingsbuch markiert: ${r.books ? r.books.title : ""}`, go: "friend" });
    for (const r of cls.data || []) {
      const c = CLASSICS.find((x) => x[0] === r.classic_id);
      events.push({ at: r.created_at, text: `${nick} hat einen Klassiker abgehakt: ${c ? c[1] : r.classic_id}`, go: "bookclub" });
    }
    events.sort((a, b) => (a.at < b.at ? 1 : -1));
    for (const e of events) rows.push({ ...e, fresh: e.at > me.events_seen_at });
    if (events.length) newest = events[0].at;
  }
  $("bell-list").replaceChildren(
    ...(rows.length
      ? rows.map((r) => {
          const b = el("button", { className: "bell-row" + (r.fresh ? " fresh" : ""), type: "button" }, r.text);
          b.onclick = () => {
            $("bell-dialog").close();
            showTab(r.go);
          };
          return b;
        })
      : [el("p", { className: "meta" }, "Noch keine Neuigkeiten.")])
  );
  $("bell-dialog").showModal();
  if (newest && newest > me.events_seen_at) {
    me.events_seen_at = newest;
    bellEvents = 0;
    setBell(bellPosts);
    await sb.from("profiles").update({ events_seen_at: newest }).eq("id", me.id);
  }
};
$("bell-close").onclick = () => $("bell-dialog").close();
setInterval(refreshBell, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshBell();
});

// Letzte Ansicht merken: nach höchstens einer Stunde Pause öffnet die App dort wieder
const RESUME_MS = 60 * 60 * 1000;
const RESUMABLE = ["home", "library", "journal", "feed", "bookclub", "profile", "settings", "buddy", "friend"];
function rememberView(name) {
  try {
    if (name) localStorage.setItem("coread-view", name);
    localStorage.setItem("coread-view-ts", String(Date.now()));
  } catch (e) {}
}
function resumeView() {
  try {
    const v = localStorage.getItem("coread-view");
    const ts = Number(localStorage.getItem("coread-view-ts"));
    if (v && RESUMABLE.includes(v) && ts && Date.now() - ts < RESUME_MS) return v;
  } catch (e) {}
  return "home";
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) rememberView();
  else if (me && Date.now() - (Number(localStorage.getItem("coread-view-ts")) || Date.now()) >= RESUME_MS) showTab("home");
});
window.addEventListener("pagehide", () => rememberView());

function showTab(name) {
  rememberView(name);
  const navName = name === "settings" ? "profile" : name === "buddy" ? "bookclub" : name;
  for (const n of ["home", "library", "journal", "feed", "bookclub", "profile", "settings", "buddy", "friend"]) {
    $("view-" + n).hidden = n !== name;
    if (n !== "settings" && n !== "buddy") $("tab-" + n).classList.toggle("active", n === navName);
  }
  window.scrollTo(0, 0);
  if (name === "library") renderLibrary();
  if (name === "journal") renderYearOverview();
  if (name === "home") renderHome();
  if (name === "profile") renderProfile();
  if (name === "settings") renderSettings();
  if (name === "buddy") renderBuddyThread();
  if (name === "friend") renderFriendShelves();
  if (name === "bookclub") {
    renderBuddy();
    renderClassics();
    loadClassics().then(renderClassics);
  }
  if (name === "feed") {
    feedLimit = FEED_PAGE;
    loadFeed();
  }
}

$("tab-home").onclick = () => showTab("home");
$("logo-home").onclick = () => {
  if (me) showTab("home");
};
$("logo-home").onkeydown = (e) => {
  if ((e.key === "Enter" || e.key === " ") && me) {
    e.preventDefault();
    showTab("home");
  }
};
$("tab-bookclub").onclick = () => showTab("bookclub");
$("tab-profile").onclick = () => showTab("profile");


// ---------- Profil: Lieblingsbücher, Buchempfehlung, Ausgeliehen ----------

const SHELVES = {
  favorite: { add: "Lieblingsbuch hinzufügen", notePlaceholder: "Was liebst du an diesem Buch? (optional)", noteLabel: "Deine Notiz", empty: "Noch kein Lieblingsbuch. Mit + fügst du eins hinzu." },
  recommendation: { add: "Buchempfehlung hinzufügen", notePlaceholder: "Warum sollte sie es lesen? (optional)", noteLabel: "Deine Empfehlung", empty: "Noch keine Empfehlung. Mit + fügst du eine hinzu." },
  borrowed: { add: "Ausgeliehenes Buch hinzufügen", notePlaceholder: "An wen oder von wem, bis wann? (optional)", noteLabel: "Ausgeliehen an/von", empty: "Nichts ausgeliehen. Mit + merkst du dir ein Buch." },
};

let profileBooks = []; // eigene
let friendProfileBooks = []; // von der anderen Person (ohne "Ausgeliehen")
let addKind = null; // gesetzt, wenn die Buchsuche für das Profil geöffnet wurde

async function fetchProfileBooks(userId) {
  const { data, error } = await sb
    .from("profile_books")
    .select("id, kind, note, created_at, books(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  // Hat die Person in ihrer Bibliothek ein eigenes Cover gesetzt, gilt dieses auch hier
  let covers = {};
  try {
    const { data: lib } = await sb.from("library_entries").select("book_id, custom_cover").eq("user_id", userId).not("custom_cover", "is", null);
    for (const l of lib || []) covers[l.book_id] = l.custom_cover;
  } catch (e) {}
  return data.map((r) => {
    const book = dbToBook(r.books);
    return { ...book, cover: covers[book.id] || book.cover, pbId: r.id, kind: r.kind, note: r.note || "" };
  });
}

function slideCard(item, readOnly) {
  const card = el("button", { className: "pslide", type: "button" });
  card.append(coverElement(item), el("div", { className: "title" }, item.title), el("div", { className: "author" }, item.authors.join(", ")));
  if (item.note) card.append(el("div", { className: "pslide-note" }, item.note));
  card.onclick = () => openProfileBook(item, readOnly);
  return card;
}

function renderShelf(container, items, kind, readOnly, emptyText) {
  const list = items.filter((i) => i.kind === kind);
  if (!list.length) {
    container.replaceChildren(el("p", { className: "meta shelf-empty" }, emptyText));
    return;
  }
  container.replaceChildren(...list.map((i) => slideCard(i, readOnly)));
}

// ---------- Vorlieben (Lieblingsautoren, Interessen & Genres) ----------

const PREF_GENRES = ["Fantasy", "Romantasy", "Krimi", "Thriller", "Liebesroman", "Historischer Roman", "Science-Fiction", "Klassiker", "Young Adult", "Sachbuch", "Biografie", "Humor", "Horror", "Dystopie", "Dark Romance", "Mythologie", "Psychothriller", "Abenteuer"];

const prefKey = (s) => s.trim().toLocaleLowerCase("de");

async function savePrefs(authors, interests) {
  const status = $("pref-status");
  const { error } = await sb.from("profiles").update({ favorite_authors: authors, interests }).eq("id", me.id);
  if (error) {
    status.textContent = "Konnte nicht gespeichert werden: " + error.message;
    return false;
  }
  me.favorite_authors = authors;
  me.interests = interests;
  status.textContent = "";
  renderPrefs();
  return true;
}

function prefChip(text, onRemove) {
  const chip = el("span", { className: "chip" }, text);
  if (onRemove) {
    const x = el("button", { className: "chip-x", type: "button" }, "×");
    x.setAttribute("aria-label", text + " entfernen");
    x.onclick = onRemove;
    chip.append(x);
  }
  return chip;
}

function renderPrefs() {
  const authors = me.favorite_authors || [];
  const interests = me.interests || [];
  $("pref-authors").replaceChildren(...authors.map((n) => prefChip(n, () => savePrefs(authors.filter((x) => x !== n), interests))));
  const have = new Set(interests.map(prefKey));
  $("pref-genres").replaceChildren(
    ...PREF_GENRES.map((g) => {
      const on = have.has(prefKey(g));
      const b = el("button", { className: "chip toggle" + (on ? " on" : ""), type: "button" }, g);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.onclick = () => savePrefs(authors, on ? interests.filter((x) => prefKey(x) !== prefKey(g)) : [...interests, g]);
      return b;
    })
  );
  const presets = new Set(PREF_GENRES.map(prefKey));
  $("pref-custom").replaceChildren(
    ...interests.filter((x) => !presets.has(prefKey(x))).map((n) => prefChip(n, () => savePrefs(authors, interests.filter((x) => x !== n))))
  );
}

function addPref(inputId, field) {
  const input = $(inputId);
  const value = input.value.trim().replace(/\s+/g, " ");
  if (!value) return;
  const authors = me.favorite_authors || [];
  const interests = me.interests || [];
  const list = field === "authors" ? authors : interests;
  if (list.some((x) => prefKey(x) === prefKey(value))) {
    input.value = "";
    return;
  }
  const limit = field === "authors" ? 40 : 60;
  if (list.length >= limit) {
    $("pref-status").textContent = "Das sind schon genug Einträge.";
    return;
  }
  input.value = "";
  savePrefs(field === "authors" ? [...authors, value] : authors, field === "authors" ? interests : [...interests, value]);
}
// Autorensuche: gleicht die Eingabe mit Open Library und deinen Büchern ab, damit Namen richtig geschrieben sind
const normName = (s) => s.toLocaleLowerCase("de").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function editRatio(x, y) {
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}
function nameScore(query, name) {
  const q = normName(query), n = normName(name);
  if (!q || !n) return 0;
  if (n === q) return 1;
  const full = editRatio(q, n);
  const qt = q.split(" "), nt = n.split(" ");
  const tok = qt.reduce((s, t) => s + Math.max(...nt.map((u) => (u.startsWith(t) && t.length >= 2 ? 0.95 : editRatio(t, u)))), 0) / qt.length;
  return Math.max(full, tok * 0.97);
}
let authorSuggestions = [];
let authorSeq = 0;
let authorTimer = null;
function localAuthors() {
  const set = new Set();
  for (const b of [...myLibrary, ...(buddy.friendLib || [])]) for (const n of b.authors || []) set.add(n);
  return [...set];
}
function renderAuthorSuggest(query, remoteDone) {
  const box = $("pref-author-suggest");
  const have = new Set((me.favorite_authors || []).map(prefKey));
  const q = query.trim();
  if (q.length < 2) {
    box.hidden = true;
    authorSuggestions = [];
    return;
  }
  const rows = authorSuggestions.filter((s) => !have.has(prefKey(s.name))).slice(0, 6);
  box.replaceChildren(
    ...rows.map((s) => {
      const b = el("button", { className: "suggest-item", type: "button" }, s.name, s.top ? el("span", { className: "meta" }, " · " + s.top) : "");
      b.onclick = () => chooseAuthor(s.name);
      return b;
    })
  );
  if (!rows.length) {
    if (remoteDone) {
      const keep = el("button", { className: "suggest-item", type: "button" }, `Nichts gefunden. „${q}“ trotzdem übernehmen`);
      keep.onclick = () => chooseAuthor(q);
      box.replaceChildren(keep);
    } else {
      box.replaceChildren(el("div", { className: "meta" }, "Suche …"));
    }
  }
  box.hidden = false;
}
function chooseAuthor(name) {
  $("pref-author-input").value = "";
  $("pref-author-suggest").hidden = true;
  authorSuggestions = [];
  const authors = me.favorite_authors || [];
  if (authors.some((x) => prefKey(x) === prefKey(name))) return;
  if (authors.length >= 40) {
    $("pref-status").textContent = "Das sind schon genug Einträge.";
    return;
  }
  savePrefs([...authors, name], me.interests || []);
}
async function searchAuthors(query) {
  const seq = ++authorSeq;
  const q = query.trim();
  const words = q.split(/\s+/).filter(Boolean);
  const found = new Map();
  const add = (name, top) => {
    if (!name) return;
    const s = nameScore(q, name);
    if (s < 0.6) return;
    const k = prefKey(name);
    if (!found.has(k) || found.get(k).score < s) found.set(k, { name, top, score: s });
  };
  for (const n of localAuthors()) add(n, "");
  const publish = (done) => {
    if (seq !== authorSeq) return;
    authorSuggestions = [...found.values()].sort((x, y) => y.score - x.score);
    renderAuthorSuggest(q, done);
  };
  publish(false);
  const queries = [q, words.map((w) => w + "~").join(" "), words[words.length - 1] + "*"];
  try {
    const results = await Promise.all(
      queries.map((term) =>
        fetch(`https://openlibrary.org/search/authors.json?limit=12&q=${encodeURIComponent(term)}`)
          .then((r) => (r.ok ? r.json() : { docs: [] }))
          .catch(() => ({ docs: [] }))
      )
    );
    for (const res of results) for (const d of res.docs || []) add(d.name, d.top_work || "");
  } catch (e) {}
  publish(true);
}
$("pref-author-input").oninput = () => {
  clearTimeout(authorTimer);
  const v = $("pref-author-input").value;
  if (v.trim().length < 2) {
    authorSeq++;
    renderAuthorSuggest(v, false);
    return;
  }
  authorTimer = setTimeout(() => searchAuthors(v), 300);
};
$("pref-author-form").onsubmit = (e) => {
  e.preventDefault();
  const v = $("pref-author-input").value.trim();
  if (!v) return;
  const best = authorSuggestions.find((s) => !(me.favorite_authors || []).some((x) => prefKey(x) === prefKey(s.name)));
  if (best && best.score >= 0.75) chooseAuthor(best.name);
  else searchAuthors(v);
};
$("pref-interest-form").onsubmit = (e) => {
  e.preventDefault();
  addPref("pref-interest-input", "interests");
};

// ---------- Buchempfehlungen "Für dich" (Startseite) ----------

const RECS_KEY = "coread-recs-v2";
const RECS_DISMISS_KEY = "coread-recs-dismissed";
const RECS_MAX_AGE = 12 * 60 * 60 * 1000;
const GENRE_SUBJECT = {
  Fantasy: "fantasy", Romantasy: "fantasy romance", Krimi: "mystery", Thriller: "thriller", Liebesroman: "romance",
  "Historischer Roman": "historical fiction", "Science-Fiction": "science fiction", Klassiker: "classics", "Young Adult": "young adult fiction",
  Sachbuch: "nonfiction", Biografie: "biography", Humor: "humor", Horror: "horror", Dystopie: "dystopian",
  "Dark Romance": "dark romance", Mythologie: "mythology", Psychothriller: "psychological thriller", Abenteuer: "adventure",
};
const RECS_JUNK = /zusammenfassung|analyse|lektürehilfe|study guide|summary|erläuterungen|arbeitsheft|sammelband|\b(box|bundle)\b|gesamtausgabe|trivia|workbook/i;
let recsBusy = false;

const recBookKey = (b) => normName(b.title) + "|" + normName((b.authors || [])[0] || "");
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);
function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}
let recFeedback = []; // Rückmeldungen aus der Datenbank
let recFeedbackLoaded = false;
async function loadRecFeedback() {
  const { data, error } = await sb.from("rec_feedback").select("book_key, authors, block_author").eq("user_id", me.id);
  if (!error) {
    recFeedback = data || [];
    recFeedbackLoaded = true;
  }
}
const recDismissed = () => new Set([...readJson(RECS_DISMISS_KEY, []), ...recFeedback.map((f) => f.book_key)]);
const recBlockedAuthors = () => new Set(recFeedback.filter((f) => f.block_author).flatMap((f) => (f.authors || []).map(normName)));
const authorBlocked = (b, blocked) => (b.authors || []).some((x) => blocked.has(normName(x)));

const RECS_REASONS = ["Falsche Sprache", "Habe ich schon gelesen", "Kein passendes Buch (z. B. wissenschaftlich)", "Interessiert mich nicht", "Anderes"];
function openRecFeedback(item) {
  const b = item.book;
  let reason = null;
  const msg = el("p", { className: "meta", role: "status" });
  const chips = el("div", { className: "chips" });
  const blockBox = el("input", { type: "checkbox" });
  const blockRow = el("label", { className: "check" }, blockBox, " Auch keine weiteren Bücher dieser Autorin/dieses Autors vorschlagen");
  blockRow.hidden = true;
  const note = el("textarea", { rows: 3, maxLength: 500, placeholder: "Weil … (optional)" });
  note.setAttribute("aria-label", "Anmerkung");
  const send = el("button", { className: "btn", type: "button" }, "Senden");
  const draw = () => {
    chips.replaceChildren(
      ...RECS_REASONS.map((r) => {
        const c = el("button", { className: "chip toggle" + (reason === r ? " on" : ""), type: "button" }, r);
        c.setAttribute("aria-pressed", reason === r ? "true" : "false");
        c.onclick = () => {
          reason = r;
          blockRow.hidden = r !== "Interessiert mich nicht";
          msg.textContent = "";
          draw();
        };
        return c;
      })
    );
  };
  draw();
  // Ähnliche Bücher aus meinem Regal (für "Habe ich schon gelesen": evtl. steht es dort unter anderem Namen)
  const similarOwned = () => {
    const ct = coreTitle(b.title);
    const words = new Set(ct.split(" ").filter((w) => w.length > 2));
    const score = (m) => {
      const t = [m.title, m.originalTitle].filter(Boolean).map(coreTitle);
      const ratio = Math.max(...t.map((x) => editRatio(x, ct)));
      const mw = new Set(t.join(" ").split(" ").filter((w) => w.length > 2));
      const inter = [...words].filter((w) => mw.has(w)).length;
      const jac = words.size && mw.size ? inter / Math.min(words.size, mw.size) : 0;
      return Math.max(ratio, jac * 0.9);
    };
    return myLibrary
      .map((m) => ({ m, s: score(m), same: (m.authors || []).some((x) => (b.authors || []).some((y) => sameAuthor(x, y))) }))
      .filter((x) => (x.same ? x.s >= 0.3 : x.s >= 0.7))
      .sort((x, y) => y.s - x.s)
      .slice(0, 4);
  };
  const store = async (extra) => {
    const userNote = note.value.trim();
    const row = {
      book_key: recBookKey(b),
      title: b.title,
      authors: b.authors || [],
      source: item.src || null,
      category: reason,
      note: [userNote, extra].filter(Boolean).join(" | ").slice(0, 500) || null,
      block_author: reason === "Interessiert mich nicht" && blockBox.checked,
    };
    const { error } = await sb.from("rec_feedback").insert(row);
    if (error) {
      msg.textContent = "Konnte nicht gespeichert werden: " + error.message;
      return false;
    }
    recFeedback.push(row);
    return true;
  };
  send.onclick = async () => {
    if (!reason) {
      if (!note.value.trim()) {
        msg.textContent = "Bitte wähle zuerst oben einen Grund aus.";
        return;
      }
      reason = "Anderes"; // nur Text eingegeben: als "Anderes" speichern
    }
    send.disabled = true;
    if (reason === "Habe ich schon gelesen") {
      const cands = similarOwned();
      if (cands.length) {
        // Zweiter Schritt: steht es evtl. schon im Regal?
        const rows = cands.map(({ m }) => {
          const r = el("button", { className: "suggest-item", type: "button" }, m.title, el("span", { className: "meta" }, ` · ${(m.authors || []).join(", ")}`));
          r.onclick = async () => {
            if (!(await store(`Steht schon im Regal als: ${m.title}`))) return;
            $("rec-dialog").close();
            renderRecs();
            showDetail(m);
          };
          return r;
        });
        const fresh = el("button", { className: "btn", type: "button" }, "Nein, noch nicht in meiner Bibliothek");
        fresh.onclick = async () => {
          fresh.disabled = true;
          if (!(await store(""))) {
            fresh.disabled = false;
            return;
          }
          $("rec-dialog").close();
          renderRecs();
          showDetail(b, false, { status: "read" });
        };
        $("rec-content").replaceChildren(
          el("p", { className: "meta" }, `${b.title} · ${(b.authors || []).join(", ")}`),
          el("div", { className: "pref-label" }, "Steht das Buch schon in deinem Regal?"),
          el("div", { className: "suggest" }, ...rows),
          el("div", { className: "actions" }, fresh),
          msg
        );
        return;
      }
    }
    if (!(await store(""))) {
      send.disabled = false;
      return;
    }
    $("rec-dialog").close();
    renderRecs();
    if (reason === "Habe ich schon gelesen") showDetail(b, false, { status: "read" });
  };
  const cancel = el("button", { className: "btn secondary", type: "button" }, "Abbrechen");
  cancel.onclick = () => $("rec-dialog").close();
  $("rec-content").replaceChildren(
    el("p", { className: "meta" }, `${b.title} · ${(b.authors || []).join(", ")}`),
    el("div", { className: "pref-label" }, "Was passt nicht?"),
    chips,
    blockRow,
    note,
    el("div", { className: "actions" }, send, cancel),
    msg
  );
  $("rec-dialog").showModal();
}
$("rec-close").onclick = () => $("rec-dialog").close();

// Titel auf den Kern reduzieren: "Origin - Text" und "Origin" sind dasselbe Buch
function coreTitle(t) {
  let s = String(t || "").toLocaleLowerCase("de").replace(/[(\[].*?[)\]]/g, " ");
  s = s.split(/\s[-–—]\s|:/)[0];
  s = normName(s).replace(/\b(roman|band|bd|teil|buch|ausgabe)\s*\d*\b/g, " ").replace(/\s\d+$/, "").replace(/\s+/g, " ").trim();
  return s;
}
const surname = (n) => normName(n).split(" ").pop();
const sameAuthor = (x, y) => nameScore(x, y) >= 0.8 || (surname(x).length >= 3 && surname(x) === surname(y));
function sameBook(a, b) {
  const aa = a.authors || [], ab = b.authors || [];
  if (aa.length && ab.length && !aa.some((x) => ab.some((y) => sameAuthor(x, y)))) return false;
  const ca = coreTitle(a.title), cb = coreTitle(b.title);
  if (!ca || !cb) return false;
  if (ca === cb || editRatio(ca, cb) >= 0.88) return true;
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  return short.length >= 4 && long.startsWith(short + " ") && long.split(" ").length - short.split(" ").length <= 2;
}
function ownedBooks() {
  const list = [];
  for (const b of myLibrary) {
    list.push({ id: b.id, title: b.title, authors: b.authors });
    if (b.originalTitle && b.originalTitle !== b.title) list.push({ id: b.id, title: b.originalTitle, authors: b.authors });
  }
  return list;
}
const isOwned = (book, own) => own.some((o) => o.id === book.id || sameBook(o, book));

// Nur deutschsprachige Bücher
function germanOk(b) {
  const l = String(b.language || "").toLowerCase();
  return l === "ger" || l.startsWith("de");
}
// Keine Dissertationen, Lektürehilfen oder wissenschaftlichen Arbeiten
const SCI_TITLE = /dissertation|doctoral|thesis|habilitation|masterarbeit|bachelorarbeit|diplomarbeit|magisterarbeit|hausarbeit|seminararbeit|facharbeit|wissenschaftlich|\bstudie\b|untersuchung|tagungsband|proceedings|festschrift|interpretation|textanalyse|abitur|klausur|referat|handbuch|beiträge zur|zur frage|empirische/i;
const SCI_PUBLISHER = /universit|hochschule|akademikerverlag|grin\b|diplomica|vdm\b|lap lambert|springer|de gruyter|tectum|waxmann|kovač|peter lang|nomos|duncker|mohr siebeck|wissenschaftlich|academic|press\b/i;
const SCI_CATEGORY = /literary criticism|study aids|education|dissertation|thesis|academic|reference|language arts|social science|philosophy|psychology|political science|law\b|medical|computers|technology & engineering|business & economics/i;
function scienceLike(b) {
  const text = `${b.title || ""} ${b.subtitle || ""}`;
  if (SCI_TITLE.test(text)) return true;
  if (SCI_PUBLISHER.test(b.publisher || "")) return true;
  if ((b.categories || []).some((c) => SCI_CATEGORY.test(String(c)))) return true;
  if (b.pages && b.pages < 60) return true;
  return false;
}

async function authorBooksForRecs(name) {
  let res = [];
  try {
    res = await searchGoogle(`inauthor:"${name}"`, "de");
  } catch (e) {
    try {
      res = await searchOpenLibrary(`author:"${name}"`, "");
    } catch (e2) {
      res = [];
    }
  }
  return res.filter((b) => (b.authors || []).some((a) => nameScore(name, a) >= 0.8));
}
async function subjectBooksForRecs(term) {
  const q = GENRE_SUBJECT[term] ? `subject:${GENRE_SUBJECT[term]}` : term;
  try {
    return await searchGoogle(q, "de");
  } catch (e) {
    try {
      return await searchOpenLibrary(GENRE_SUBJECT[term] || term, "");
    } catch (e2) {
      return [];
    }
  }
}

async function buildRecs() {
  const own = ownedBooks();
  const dismissed = recDismissed();
  const blocked = recBlockedAuthors();
  const chosen = [];
  const ok = (b, src) => {
    if (!b || !b.cover || !b.title || RECS_JUNK.test(b.title)) return false;
    if (src !== "friend" && (!germanOk(b) || scienceLike(b))) return false;
    if (isOwned(b, own) || dismissed.has(recBookKey(b)) || authorBlocked(b, blocked)) return false;
    return !chosen.some((c) => sameBook(c, b));
  };
  const take = (list, n, reason, src) => {
    const out = [];
    for (const b of list) {
      if (out.length >= n) break;
      if (!ok(b, src)) continue;
      chosen.push(b);
      out.push({ book: b, reason, src });
    }
    return out;
  };

  // 1. Bücher, die der Freundin gefallen haben
  const groups = { friend: [], rated: [], fav: [], genre: [] };
  if (friend) {
    let flib = [];
    try {
      flib = await fetchLibrary(friend.id);
    } catch (e) {}
    const liked = flib.filter((b) => b.entry.status === "read" && (b.entry.rating || 0) >= 4).sort((x, y) => y.entry.rating - x.entry.rating);
    for (const b of liked) {
      const book = { ...b, id: b.id };
      delete book.entry;
      groups.friend.push(...take([book], 1, `Gefällt ${friendNick} (${"★".repeat(b.entry.rating)}) und könnte dir auch gefallen!`, "friend"));
      if (groups.friend.length >= 3) break;
    }
  }

  // 2. Weitere Bücher der Autoren, die ich hoch bewertet habe, 3. Lieblingsautoren, 4. Interessen
  const usedAuthors = new Set();
  const seeds = [];
  const readBooks = myLibrary.filter((b) => b.entry.status === "read" && (b.authors || []).length);
  const pool = [...shuffled(readBooks.filter((b) => b.entry.rating === 5)), ...shuffled(readBooks.filter((b) => b.entry.rating === 4)), ...shuffled(readBooks.filter((b) => !b.entry.rating))];
  for (const b of pool) {
    const a = b.authors[0];
    if (usedAuthors.has(prefKey(a))) continue;
    usedAuthors.add(prefKey(a));
    const why = b.entry.rating === 5 ? `Weil du „${b.title}“ mit 5 Sternen bewertet hast.` : b.entry.rating === 4 ? `Weil dir „${b.title}“ gefallen hat (4 Sterne).` : `Weil du „${b.title}“ gelesen hast.`;
    seeds.push({ kind: "rated", author: a, reason: "Kennst du schon? " + why });
    if (seeds.length >= 3) break;
  }
  for (const name of shuffled(me.favorite_authors || [])) {
    if (usedAuthors.has(prefKey(name))) continue;
    usedAuthors.add(prefKey(name));
    seeds.push({ kind: "fav", author: name, reason: `Kennst du schon? ${name} gehört zu deinen Lieblingsautoren.` });
    if (seeds.filter((s) => s.kind === "fav").length >= 3) break;
  }
  const topics = shuffled(me.interests || []).slice(0, 3);

  const results = await Promise.all([
    ...seeds.map((s) => authorBooksForRecs(s.author).then((list) => ({ s, list }))),
    ...topics.map((t) => subjectBooksForRecs(t).then((list) => ({ t, list }))),
  ]);
  for (const r of results) {
    if (r.s) groups[r.s.kind].push(...take(r.list, 2, r.s.reason, r.s.kind));
    else groups.genre.push(...take(shuffled(r.list).slice(0, 12), 2, `Passt zu deinem Interesse „${r.t}“.`, "genre"));
  }

  // abwechselnd mischen
  const order = ["friend", "rated", "fav", "genre"];
  const out = [];
  for (let i = 0; out.length < 10 && i < 10; i++) for (const g of order) if (groups[g][i] && out.length < 10) out.push(groups[g][i]);
  return out;
}

function recsSignature() {
  return JSON.stringify([me.favorite_authors || [], me.interests || [], friend ? friend.id : null]);
}

async function refreshRecs(force) {
  if (!me || recsBusy) return;
  if (!recFeedbackLoaded) {
    await loadRecFeedback();
    renderRecs();
  }
  const cache = readJson(RECS_KEY, null);
  if (!force && cache && cache.sig === recsSignature() && Date.now() - cache.ts < RECS_MAX_AGE) return;
  recsBusy = true;
  try {
    const items = await buildRecs();
    try {
      localStorage.setItem(RECS_KEY, JSON.stringify({ ts: Date.now(), sig: recsSignature(), items }));
    } catch (e) {}
    renderRecs();
  } catch (e) {
    // Empfehlungen sind optional: bei Fehlern bleibt der Bereich einfach leer
  } finally {
    recsBusy = false;
  }
}

function renderRecs() {
  const box = $("home-recs");
  if (!box) return;
  const cache = readJson(RECS_KEY, null);
  const own = ownedBooks();
  const dismissed = recDismissed();
  const blocked = recBlockedAuthors();
  const items = ((cache && cache.items) || []).filter((it) => !isOwned(it.book, own) && !dismissed.has(recBookKey(it.book)) && !authorBlocked(it.book, blocked));
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const cards = items.map((it) => {
    const b = it.book;
    const card = el("div", { className: "rec" });
    const cover = el("button", { className: "rec-cover", type: "button" }, coverElement(b));
    cover.setAttribute("aria-label", b.title + " ansehen");
    cover.onclick = () => showDetail(b, false, { status: "want" });
    const add = el("button", { className: "btn small", type: "button" }, "+ Merken");
    add.onclick = async () => {
      add.disabled = true;
      try {
        await saveEntry(b, { status: "want", owned: false, audiobook: false, startedAt: null, finishedAt: null, progress: null, rating: null, customCover: null });
        await reloadMyLibrary();
        renderHome();
      } catch (err) {
        add.disabled = false;
        add.textContent = "Fehler, nochmal";
      }
    };
    const no = el("button", { className: "btn secondary small", type: "button" }, "Feedback");
    no.onclick = () => openRecFeedback(it);
    card.append(
      cover,
      el(
        "div",
        { className: "rec-body" },
        el("div", { className: "title" }, b.title),
        el("div", { className: "author" }, (b.authors || []).join(", ")),
        el("div", { className: "rec-reason" }, it.reason),
        el("div", { className: "rec-actions" }, add, no)
      )
    );
    return card;
  });
  box.replaceChildren(el("h3", {}, "Das könnte dir auch gefallen:"), el("div", { className: "recs-row" }, ...cards));
}

async function renderProfile() {
  renderPrefs();
  const nick = friendNick || "deine Freundin";
  $("rec-title").textContent = friend ? `Buchempfehlung für ${nick}` : "Buchempfehlung";
  try {
    profileBooks = await fetchProfileBooks(me.id);
  } catch (err) {
    profileBooks = [];
    for (const k of Object.keys(SHELVES)) $("shelf-" + k).replaceChildren(el("p", { className: "meta" }, "Konnte nicht geladen werden: " + err.message));
    return;
  }
  for (const k of Object.keys(SHELVES)) renderShelf($("shelf-" + k), profileBooks, k, false, SHELVES[k].empty);
}

// Karte "liest gerade" für die Freundin: wie auf der Startseite, nur zum Ansehen
function friendHeroCard(book, nick) {
  const info = progressInfo(book);
  const compact = heroCompact;
  const fill = el("div", { className: "bar-fill" });
  fill.style.width = info.pct + "%";
  const bar = el("div", { className: "bar" }, fill);
  const labelRow = el("div", { className: "hero-top" }, el("div", { className: "hero-label" }, `${nick} liest gerade`));
  const cover = el("div", { className: "hero-cover tappable" }, coverElement(book));
  cover.setAttribute("role", "button");
  cover.setAttribute("aria-label", `Details zu ${book.title}`);
  cover.onclick = () => showDetail(book, true);
  const authors = el("div", { className: "author" }, book.authors.join(", "));
  const title = compact ? el("div", { className: "hero-title-btn" }, book.title) : el("h2", {}, book.title);
  const body = el("div", { className: "hero-info" }, labelRow, title, authors, bar, el("div", { className: "progress-text" }, info.text));
  return el("div", { className: compact ? "hero compact" : "hero" }, cover, body);
}

async function renderFriendShelves() {
  const box = $("friend-shelves");
  if (!friend) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const nick = friendNick || friend.display_name;
  $("friend-fav-title").textContent = `${nick}s Lieblingsbücher`;

  let lib = [];
  let fGoals = [];
  try {
    lib = await fetchLibrary(friend.id);
  } catch (err) {}
  try {
    const { data } = await sb.from("reading_goals").select("period_start, period_end, target").eq("user_id", friend.id).order("created_at", { ascending: false });
    fGoals = data || [];
  } catch (err) {}

  // Liest gerade (neueste zuerst, wie auf der Startseite)
  const reading = lib
    .filter((b) => b.entry.status === "reading")
    .map((b, i) => ({ b, i, k: b.entry.startedAt || "9999-12-31" }))
    .sort((x, y) => (x.k < y.k ? 1 : x.k > y.k ? -1 : x.i - y.i))
    .map((x) => x.b);
  const hero = $("friend-hero");
  if (!reading.length) {
    hero.replaceChildren(el("div", { className: "hero empty" }, el("p", {}, `${nick} liest gerade kein Buch.`)));
  } else {
    const track = el("div", { className: "carousel" }, ...reading.map((b) => el("div", { className: "slide" }, friendHeroCard(b, nick))));
    const dots = reading.map((b, i) => {
      const dot = el("button", { className: i === 0 ? "dot active" : "dot", type: "button", "aria-label": `Buch ${i + 1}: ${b.title}` });
      dot.onclick = () => track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" });
      return dot;
    });
    track.onscroll = () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      dots.forEach((dot, j) => dot.classList.toggle("active", j === i));
    };
    hero.replaceChildren(track, ...(reading.length > 1 ? [el("div", { className: "dots" }, ...dots)] : []));
  }

  // Kacheln
  $("friend-shelf-count").textContent = lib.filter((b) => b.entry.owned).length;
  $("friend-stack-count").textContent = lib.filter(isUnread).length;
  const today = todayLocal();
  const goal = fGoals.find((g) => g.period_start <= today && today <= g.period_end);
  const readIn = (from, to) => lib.filter((b) => b.entry.status === "read" && b.entry.finishedAt && b.entry.finishedAt >= from && b.entry.finishedAt <= to);
  if (goal) {
    $("friend-year-label").textContent = goalLabel(goal);
    $("friend-year-count").textContent = `${readIn(goal.period_start, goal.period_end).length}/${goal.target}`;
  } else {
    const year = String(new Date().getFullYear());
    $("friend-year-label").textContent = `Gelesen ${year}`;
    $("friend-year-count").textContent = readIn(`${year}-01-01`, `${year}-12-31`).length;
  }

  // Lieblingsbücher als Galerie
  try {
    friendProfileBooks = await fetchProfileBooks(friend.id);
  } catch (err) {
    friendProfileBooks = [];
  }
  renderShelf($("friend-shelf-favorite"), friendProfileBooks, "favorite", true, "Noch nichts eingetragen.");
}

function openProfileBook(item, readOnly) {
  const cfg = SHELVES[item.kind];
  const box = $("pb-content");
  const top = el("div", { className: "detail-top" });
  const cover = el("div", { className: "cover-slot" });
  cover.append(coverElement(item));
  top.append(cover, el("div", {}, el("h2", {}, item.title), el("div", { className: "meta" }, item.authors.join(", "))));
  box.replaceChildren(top);
  if (readOnly) {
    box.append(item.note ? el("p", { className: "pre" }, item.note) : el("p", { className: "meta" }, "Keine Notiz."));
  } else {
    const area = el("textarea", { rows: 4, maxLength: 500, placeholder: cfg.notePlaceholder });
    area.value = item.note;
    const msg = el("p", { className: "meta", role: "status" });
    const save = el("button", { className: "btn", type: "button" }, "Speichern");
    save.onclick = async () => {
      save.disabled = true;
      const { error } = await sb.from("profile_books").update({ note: area.value.trim() || null }).eq("id", item.pbId);
      if (error) {
        msg.textContent = "Das hat nicht geklappt: " + error.message;
        save.disabled = false;
        return;
      }
      $("pb-dialog").close();
      renderProfile();
    };
    const remove = el("button", { className: "btn secondary", type: "button" }, "Entfernen");
    remove.onclick = async () => {
      if (!confirm("Dieses Buch aus der Liste entfernen?")) return;
      const { error } = await sb.from("profile_books").delete().eq("id", item.pbId);
      if (error) {
        msg.textContent = "Das hat nicht geklappt: " + error.message;
        return;
      }
      $("pb-dialog").close();
      renderProfile();
    };
    box.append(el("label", { className: "field" }, cfg.noteLabel, area), msg, el("div", { className: "actions" }, save, remove));
  }
  $("pb-dialog").showModal();
}
$("pb-close").onclick = () => $("pb-dialog").close();


function libraryMatches(query) {
  const q = (query || "").trim().toLowerCase();
  const list = myLibrary.filter((b) => !q || `${b.title} ${b.authors.join(" ")} ${b.isbn || ""}`.toLowerCase().includes(q));
  return list.map((b) => ({ ...b, entry: undefined })); // ohne Statuszeile, aber mit eigenem Cover
}

function showLibraryMatches() {
  const own = libraryMatches($("add-query").value).slice(0, 40);
  $("add-status").textContent = own.length ? `Aus deiner Bibliothek (${own.length}) – oder oben nach weiteren Büchern suchen` : "";
  $("add-results").replaceChildren(
    ...own.map((book) => {
      const card = bookCard(book, false);
      card.onclick = () => addProfileBook(addKind, book);
      return card;
    })
  );
}
$("add-query").addEventListener("input", () => {
  if (addKind) showLibraryMatches();
});

async function addProfileBook(kind, book) {
  $("add-status").textContent = "Speichere …";
  try {
    const { error: bookError } = await sb.from("books").upsert(bookToDb(book), { onConflict: "id", ignoreDuplicates: true });
    if (bookError) throw bookError;
    if (kind === "buddy") {
      const { error } = await sb.from("buddy_reads").upsert({ book_id: book.id, status: "proposed", proposed_by: me.id, rank: buddy.reads.filter((r) => r.status === "proposed").length + 1 }, { onConflict: "book_id", ignoreDuplicates: true });
      if (error) throw error;
      $("add-dialog").close();
      addKind = null;
      await renderBuddy();
      return;
    }
    const { error } = await sb.from("profile_books").upsert({ user_id: me.id, kind, book_id: book.id }, { onConflict: "user_id,kind,book_id", ignoreDuplicates: true });
    if (error) throw error;
    $("add-dialog").close();
    addKind = null;
    await renderProfile();
  } catch (err) {
    $("add-status").textContent = "Das hat nicht geklappt: " + err.message;
  }
}

for (const btn of document.querySelectorAll(".shelf-add")) {
  btn.onclick = () => {
    addKind = btn.dataset.kind;
    $("add-title").textContent = SHELVES[addKind].add;
    $("add-query").value = "";
    $("add-status").textContent = "";
    $("add-dialog").showModal();
    showLibraryMatches();
    $("add-query").focus();
  };
}

$("open-settings").onclick = () => showTab("settings");
$("settings-back").onclick = () => showTab("profile");

// ---------- Profil / Einstellungen ----------

let appInfo = {};

async function renderSettings() {
  const { data } = await sb.auth.getUser();
  const email = data && data.user ? data.user.email : "";
  $("profile-info").textContent = `${me.display_name}${email ? " · " + email : ""}`;

  const { data: rows, error } = await sb.from("app_info").select("key, value");
  appInfo = {};
  if (!error) for (const r of rows || []) appInfo[r.key] = r.value;

  let number = (appInfo.support_whatsapp || "").replace(/\D/g, "");
  if (number.startsWith("00")) number = number.slice(2);
  else if (number.startsWith("0")) number = "49" + number.slice(1);
  const link = $("support-link");
  const webLink = $("support-link-web");
  if (number) {
    const text = encodeURIComponent("Hallo Lindi mir ist folgendes im BookClub aufgefallen: ");
    link.href = `whatsapp://send?phone=${number}&text=${text}`;
    link.removeAttribute("target");
    webLink.href = `https://wa.me/${number}?text=${text}`;
    link.hidden = false;
    webLink.hidden = false;
    $("support-status").textContent = "";
  } else {
    link.hidden = true;
    webLink.hidden = true;
    $("support-status").textContent = "Der Kontakt ist noch nicht eingerichtet.";
  }
  $("impressum-address").textContent = appInfo.impressum_address || "Die Angaben sind noch nicht eingetragen.";
  $("impressum-note").textContent = appInfo.impressum_note || "";
}

$("pw-form").onsubmit = async (event) => {
  event.preventDefault();
  const status = $("pw-status");
  const pw = $("pw-new").value;
  if (pw.length < 8) {
    status.textContent = "Das Passwort braucht mindestens 8 Zeichen.";
    return;
  }
  if (pw !== $("pw-repeat").value) {
    status.textContent = "Die beiden Passwörter sind nicht gleich.";
    return;
  }
  status.textContent = "Speichere …";
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    status.textContent = "Das hat nicht geklappt: " + error.message;
    return;
  }
  $("pw-form").reset();
  status.textContent = "Passwort geändert.";
};

$("mail-form").onsubmit = async (event) => {
  event.preventDefault();
  const status = $("mail-status");
  status.textContent = "Speichere …";
  const { error } = await sb.auth.updateUser({ email: $("mail-new").value.trim() });
  if (error) {
    status.textContent = "Das hat nicht geklappt: " + error.message;
    return;
  }
  $("mail-form").reset();
  status.textContent = "Fast fertig: Schau in dein Postfach und bestätige die Änderung über den Link in der E-Mail.";
};
$("tab-library").onclick = () => showTab("library");
$("tab-journal").onclick = () => showTab("journal");
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

// Beim Laden und Neuladen alle Suchfelder leeren (der Browser stellt sonst alte Eingaben wieder her)
function clearSearchFields() {
  $("add-form").reset();
  $("lib-search").value = "";
  $("lib-sort").value = "added";
  libQuery = "";
  libSort = "added";
}
clearSearchFields();
window.addEventListener("pageshow", clearSearchFields);
setTimeout(clearSearchFields, 0);

// Auf Login/Logout reagieren (nicht direkt in der Callback-Funktion auf Supabase warten)
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(async () => {
    await onSession(session);
    if (session) hideSplash();
    else showAuth();
  }, 0);
});

// Startbild: bleibt mindestens ~1,3 Sekunden sichtbar.
// Eingeloggt: es blendet aus. Ausgeloggt: das Buch wandert nach oben, darunter erscheint der Login.
function hideSplash() {
  const splash = $("splash");
  if (!splash || splash.dataset.leaving) return;
  splash.dataset.leaving = "1";
  splash.dataset.shown = "1";
  document.body.classList.remove("auth-mode", "auth-up", "auth-instant");
  const wait = Math.max(0, 1300 - performance.now());
  setTimeout(() => {
    splash.classList.add("leave");
    setTimeout(() => {
      splash.hidden = true;
      delete splash.dataset.leaving;
    }, 500);
  }, wait);
}

function showAuth() {
  const splash = $("splash");
  const first = !splash.dataset.shown;
  splash.dataset.shown = "1";
  delete splash.dataset.leaving;
  splash.hidden = false;
  splash.classList.remove("leave");
  if (splash.classList.contains("up")) {
    document.body.classList.add("auth-mode", "auth-up", "auth-instant");
    return;
  }
  // Erst das Logo als Vollbild, dann wandert es nach oben, danach erscheint das Formular
  const wait = first ? Math.max(0, 1800 - performance.now()) : 0;
  if (!first) {
    splash.classList.add("instant");
    document.body.classList.add("auth-instant");
  }
  setTimeout(() => {
    document.body.classList.add("auth-mode");
    splash.classList.add("up");
    document.body.classList.add("auth-up");
  }, wait);
}
setTimeout(() => {
  if (!$("splash").dataset.shown) showAuth();
}, 8000); // Sicherheitsnetz, falls etwas hängt


// Farbwelt (Petrol / Dunkel / Flieder hell / Flieder dunkel)
const THEMES = {
  petrol: { bar: "#345457", set: "petrol" },
  dark: { bar: "#345457", set: "petrol" },
  "flieder-hell": { bar: "#44435d", set: "flieder" },
  "flieder-dunkel": { bar: "#44435d", set: "flieder" },
  pastel: { bar: "#866886", set: "pastel" },
};
const THEME_ASSETS = {
  petrol: { fav: "assets/favicon-32.png?v=2", touch: "assets/apple-touch-icon.png?v=2", book: "assets/header-book.png", word: "assets/header-bookclub.png" },
  flieder: { fav: "assets/favicon-flieder-32.png?v=1", touch: "assets/apple-touch-icon-flieder.png?v=1", book: "assets/header-book-flieder.png?v=1", word: "assets/header-bookclub.png" },
  pastel: { fav: "assets/favicon-pastel-32.png?v=1", touch: "assets/apple-touch-icon-pastel.png?v=1", book: "assets/header-book-pastel.png?v=1", word: "assets/header-bookclub.png" },
};
function applyTheme(t) {
  if (!THEMES[t]) t = "petrol";
  if (t === "petrol") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("coread-theme", t); } catch (e) {}
  document.querySelectorAll("[data-theme-pick]").forEach((b) => {
    const on = b.dataset.themePick === t;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const meta = $("theme-meta"); if (meta) meta.setAttribute("content", THEMES[t].bar);
  const set = THEME_ASSETS[THEMES[t].set];
  const fav = $("fav-link"), touch = $("touch-link"), li = $("logo-img"), lw = $("logo-word");
  if (fav) fav.setAttribute("href", set.fav);
  if (touch) touch.setAttribute("href", set.touch);
  if (li) li.setAttribute("src", set.book);
  if (lw) lw.setAttribute("src", set.word);
}
document.querySelectorAll("[data-theme-pick]").forEach((b) => { b.onclick = () => applyTheme(b.dataset.themePick); });
applyTheme(document.documentElement.getAttribute("data-theme") || "petrol");
