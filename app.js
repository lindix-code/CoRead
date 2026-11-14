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
    .select("status, owned, audiobook, started_at, finished_at, custom_cover, progress_page, progress_mode, progress_chapter, chapters_total, progress_percent, pages_total, rating, books(*)")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    ...dbToBook(r.books),
    pages: r.pages_total || r.books.pages, // eigene Seitenzahl hat Vorrang
    catalogPages: r.books.pages,
    cover: r.custom_cover || r.books.cover,
    originalCover: r.books.cover,
    entry: {
      customCover: r.custom_cover,
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

// Kleines Kopfhörer-Symbol für Hörbücher
function audioBadge(book) {
  if (!book.entry || !book.entry.audiobook) return "";
  const badge = el("span", { className: "badge-audio", title: "Hörbuch" });
  badge.append(el("img", { src: "assets/kopfhoerer.png", alt: "" }));
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Hörbuch");
  return badge;
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
  card.append(audioBadge(book));
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
  if (!readOnly && mine) book = { ...book, cover: mine.cover, originalCover: mine.originalCover };
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
        coverMsg.textContent = "Cover hochgeladen. Mit „Speichern“ übernehmen.";
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
    content.append(statusField, startedField, finishedField, ownedField, audioField, progressField, pagesField, chaptersField, ratingField, actions, msg, quickSave);
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
  renderGrid($("library"), shown, readOnly);
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
    const books = await searchBooks($("add-query").value, $("add-lang").value);
    $("add-status").textContent = books.length ? `${books.length} Treffer` : "Keine Treffer.";
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

function heroCard(book) {
  const e = book.entry;
  const info = progressInfo(book);
  const compact = heroCompact;

  const fill = el("div", { className: "bar-fill" });
  fill.style.width = info.pct + "%";
  const bar = el("div", { className: "bar" }, fill);
  const progressText = el("div", { className: "progress-text" }, info.text);

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
      homeBookId = book.id;
      await reloadMyLibrary();
      renderHome();
    } catch (err) {
      msg.textContent = "Speichern hat nicht geklappt: " + err.message;
      saveBtn.disabled = false;
    }
  };
  if (compact) saveBtn.classList.add("small");

  const toggle = el("button", { className: "hero-toggle", type: "button" });
  toggle.innerHTML = compact
    ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>'
    : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>';
  toggle.setAttribute("aria-label", compact ? "Aktuelles Buch groß anzeigen" : "Aktuelles Buch kompakt anzeigen");
  toggle.onclick = () => setHeroCompact(!heroCompact);
  const labelRow = el("div", { className: "hero-top" }, el("div", { className: "hero-label" }, "Ich lese gerade"), toggle);

  const form = el("div", { className: "progress-form" }, el("div", { className: "progress-input" }, modeSelect, input, unit, pagesTotalInput, saveBtn));

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
  const reading = myLibrary.filter((b) => b.entry.status === "reading");
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
  renderYearOverview();

  $("stack-count").textContent = stackBooks().length;
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

// ---------- BookClub: Gemeinsame Klassiker ----------

// [Schlüssel, Titel, Autor:in, Deckelfarbe]. Neue Titel einfach hier anhängen (keine Migration nötig).
// Der Schlüssel wird in der Datenbank gespeichert und darf sich nicht mehr ändern.
const CLASSICS = [
  ["faust", "Faust", "Goethe", "#7a1f2b"],
  ["moby-dick", "Moby Dick", "Melville", "#1f4e6b"],
  ["anna-karenina", "Anna Karenina", "Tolstoi", "#5b2a5e"],
  ["unendliche-geschichte", "Die unendliche Geschichte", "Michael Ende", "#a5530f"],
  ["kleiner-prinz", "Der kleine Prinz", "Saint-Exupéry", "#2f6b5e"],
  ["1984", "1984", "George Orwell", "#9e1b1b"],
  ["stolz-und-vorurteil", "Stolz und Vorurteil", "Jane Austen", "#8a4b6b"],
  ["reise-zum-mittelpunkt-der-erde", "Die Reise zum Mittelpunkt der Erde", "Jules Verne", "#3f5f2a"],
  ["krieg-und-frieden", "Krieg und Frieden", "Tolstoi", "#4a4a5e"],
  ["hamlet", "Hamlet", "Shakespeare", "#1e2a4a"],
  ["wer-die-nachtigall-stoert", "Wer die Nachtigall stört", "Harper Lee", "#6b4a2b"],
  ["faenger-im-roggen", "Der Fänger im Roggen", "J. D. Salinger", "#b0402a"],
  ["die-raeuber", "Die Räuber", "Friedrich Schiller", "#5c2e1b"],
  ["great-gatsby", "The Great Gatsby", "F. Scott Fitzgerald", "#7a5c0e"],
  ["don-quijote", "Don Quijote", "Cervantes", "#a0522d"],
  ["jane-eyre", "Jane Eyre", "Charlotte Brontë", "#3b3f6e"],
  ["wuthering-heights", "Wuthering Heights", "Emily Brontë", "#3e4a52"],
  ["sommernachtstraum", "Ein Sommernachtstraum", "Shakespeare", "#4b2e83"],
  ["mord-im-orientexpress", "Mord im Orientexpress", "Agatha Christie", "#2b2b2b"],
  ["tom-sawyer", "Die Abenteuer des Tom Sawyer", "Mark Twain", "#8a5a00"],
  ["huckleberry-finn", "Die Abenteuer des Huckleberry Finn", "Mark Twain", "#4f6f3a"],
  ["odyssee", "Die Odyssee", "Homer", "#0e5a7a"],
  ["zeitmaschine", "Die Zeitmaschine", "H. G. Wells", "#a33c6b"],
  ["im-westen-nichts-neues", "Im Westen nichts Neues", "Erich Maria Remarque", "#4b4f3a"],
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

function classicCard([id, title, author, color]) {
  const readers = classicReaders(id);
  const mine = classicReads.some((r) => r.classic_id === id && r.user_id === me.id);
  const done = readers.length > 0;

  const cover = el("div", { className: "classic-cover" + (done ? " done" : "") });
  cover.style.setProperty("--cover", color);
  cover.append(
    el("div", { className: "classic-cover-title" }, title),
    el("div", { className: "classic-cover-author" }, author)
  );
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
    el("div", { className: "classic-readers" }, done ? "von " + readers.join(" & ") : "")
  );
  card.onclick = () => toggleClassic(id);
  return card;
}

function renderClassics() {
  if (!me) return;
  const readCount = CLASSICS.filter(([id]) => classicReaders(id).length > 0).length;
  $("classics-count").textContent = `${readCount} / ${CLASSICS.length}`;
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
  classicReads = has
    ? classicReads.filter((r) => !(r.classic_id === id && r.user_id === me.id))
    : [...classicReads, { user_id: me.id, classic_id: id }];
  renderClassics();
}

$("tile-classics").onclick = () => $("classics").scrollIntoView({ behavior: "smooth", block: "start" });

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
    for (const id of ["view-home", "view-library", "view-feed", "view-bookclub", "view-profile", "view-friend"]) $(id).hidden = true;
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
    await reloadMyLibrary();
    await loadGoals();
    renderFriendPanel();
    refreshBell();
    showTab("home");
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
  $("bell").setAttribute("aria-label", count ? `${count} neue Beiträge auf der Pinnwand` : "Pinnwand");
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
  if (!error) setBell(count || 0);
}

// Pinnwand wurde angesehen: alles bis zum neuesten Beitrag gilt als gelesen
async function markFeedSeen(newestIso) {
  if (!me || !me.feed_seen_at || !newestIso || newestIso <= me.feed_seen_at) return;
  me.feed_seen_at = newestIso;
  setBell(0);
  await sb.from("profiles").update({ feed_seen_at: newestIso }).eq("id", me.id);
}

$("bell").onclick = () => showTab("feed");
setInterval(refreshBell, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshBell();
});

function showTab(name) {
  const navName = name === "settings" ? "profile" : name;
  for (const n of ["home", "library", "feed", "bookclub", "profile", "settings", "friend"]) {
    $("view-" + n).hidden = n !== name;
    if (n !== "settings") $("tab-" + n).classList.toggle("active", n === navName);
  }
  window.scrollTo(0, 0);
  if (name === "library") renderLibrary();
  if (name === "home") renderHome();
  if (name === "profile") renderProfile();
  if (name === "settings") renderSettings();
  if (name === "friend") renderFriendShelves();
  if (name === "bookclub") {
    renderClassics();
    loadClassics().then(renderClassics);
  }
  if (name === "feed") {
    feedLimit = FEED_PAGE;
    loadFeed();
  }
}

$("tab-home").onclick = () => showTab("home");
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
  return data.map((r) => ({ ...dbToBook(r.books), pbId: r.id, kind: r.kind, note: r.note || "" }));
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

async function renderProfile() {
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

async function renderFriendShelves() {
  const box = $("friend-shelves");
  if (!friend) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const nick = friendNick || friend.display_name;
  $("friend-fav-title").textContent = `${nick}s Lieblingsbücher`;
  $("friend-rec-title").textContent = `Empfehlungen von ${nick}`;
  try {
    friendProfileBooks = await fetchProfileBooks(friend.id);
  } catch (err) {
    friendProfileBooks = [];
  }
  renderShelf($("friend-shelf-favorite"), friendProfileBooks, "favorite", true, "Noch nichts eingetragen.");
  renderShelf($("friend-shelf-recommendation"), friendProfileBooks, "recommendation", true, "Noch nichts eingetragen.");
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

async function addProfileBook(kind, book) {
  $("add-status").textContent = "Speichere …";
  try {
    const { error: bookError } = await sb.from("books").upsert(bookToDb(book), { onConflict: "id", ignoreDuplicates: true });
    if (bookError) throw bookError;
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
    $("add-results").replaceChildren();
    $("add-dialog").showModal();
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
    hideSplash();
  }, 0);
});

// Startbild: bleibt mindestens ~1,3 Sekunden sichtbar und verschwindet, sobald Login-Status und Daten geladen sind
function hideSplash() {
  const splash = $("splash");
  if (!splash || splash.dataset.leaving) return;
  splash.dataset.leaving = "1";
  const wait = Math.max(0, 1300 - performance.now());
  setTimeout(() => {
    splash.classList.add("leave");
    setTimeout(() => splash.remove(), 500);
  }, wait);
}
setTimeout(hideSplash, 8000); // Sicherheitsnetz, falls etwas hängt
