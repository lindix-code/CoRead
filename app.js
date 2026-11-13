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
// Ungelesen = gekauft (im Bücherregal) und will ich noch lesen
function isUnread(b) {
  return b.entry.owned && b.entry.status === "want";
}

const LISTS = [
  ["shelf", "Mein Bücherregal", (b) => b.entry.owned],
  ["unread", "Ungelesene Bücher", isUnread],
  ["reading", "Lese ich gerade", (b) => b.entry.status === "reading"],
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
    .select("status, owned, started_at, finished_at, custom_cover, progress_page, rating, books(*)")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    ...dbToBook(r.books),
    cover: r.custom_cover || r.books.cover,
    originalCover: r.books.cover,
    entry: {
      customCover: r.custom_cover,
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
async function resizeToJpeg(file, maxWidth = 600) {
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
      0.85
    );
  });
}

async function uploadCover(book, file) {
  const blob = await resizeToJpeg(file);
  const safeId = book.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `${me.id}/${safeId}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from("covers").upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return sb.storage.from("covers").getPublicUrl(path).data.publicUrl;
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
    const ownedField = el("label", { className: "check" }, ownedBox, " In meinem Bücherregal (gekauft)");
    const startedInput = el("input", { type: "date", value: (entry && entry.startedAt) || "" });
    const finishedInput = el("input", { type: "date", value: (entry && entry.finishedAt) || "" });
    const startedField = el("label", { className: "field" }, "Begonnen am", startedInput);
    const finishedField = el("label", { className: "field" }, "Beendet am", finishedInput);
    const statusSelect = statusField.querySelector("select");
    const updateDateFields = () => {
      const st = statusSelect.value;
      startedField.hidden = !["reading", "read"].includes(st);
      finishedField.hidden = st !== "read";
      progressField.hidden = st !== "reading";
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
    saveBtn.onclick = async () => {
      const status = $("f-status").value || null;
      const owned = $("f-owned").checked;
      if (!status && !owned) {
        msg.textContent = "Wähle eine Leseliste oder setze den Haken für das Bücherregal.";
        return;
      }
      // Unvollständig eingegebene Daten nicht stillschweigend durch "heute" ersetzen
      if (
        (!startedField.hidden && startedInput.validity.badInput) ||
        (!finishedField.hidden && finishedInput.validity.badInput)
      ) {
        msg.textContent = "Bitte gib das Datum vollständig ein (Tag, Monat und Jahr) oder lösche es ganz.";
        return;
      }
      const startedAt = !startedField.hidden ? startedInput.value || null : null;
      const finishedAt = !finishedField.hidden ? finishedInput.value || null : null;
      if (startedAt && finishedAt && finishedAt < startedAt) {
        msg.textContent = "Das Enddatum liegt vor dem Startdatum.";
        return;
      }
      saveBtn.disabled = true;
      try {
        await saveEntry(book, {
          status,
          owned,
          startedAt,
          finishedAt,
          customCover,
          progress: status === "reading" && $("f-progress").value !== "" ? Number($("f-progress").value) : null,
          rating: $("f-rating").value === "" ? null : Number($("f-rating").value),
        });
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
  reading: { owned: false, status: "reading" },
  read: { owned: false, status: "read" },
  want: { owned: false, status: "want" },
};

$("lib-add").onclick = () => {
  const [, label] = LISTS.find(([key]) => key === libList);
  $("add-title").textContent = `Buch hinzufügen: ${label}`;
  $("add-status").textContent = "";
  $("add-results").replaceChildren();
  $("add-dialog").showModal();
  $("add-query").focus();
};
$("add-close").onclick = () => $("add-dialog").close();
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
        card.onclick = () => showDetail(book, false, preset);
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

function heroCard(book) {
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
      homeBookId = book.id;
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
  return el("div", { className: "hero" }, el("div", { className: "hero-cover" }, coverElement(book)), info);
}

function renderHome() {
  const reading = myLibrary.filter((b) => b.entry.status === "reading");
  const hero = $("home-hero");

  if (!reading.length) {
    homeBookId = null;
    const searchBtn = el("button", { className: "btn", type: "button" }, "Buch suchen");
    searchBtn.onclick = () => showTab("search");
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
  $("shelf-sub").textContent =
    myLibrary.length === 1 ? "1 Buch insgesamt eingetragen" : `${myLibrary.length} Bücher insgesamt eingetragen`;

  const year = String(new Date().getFullYear());
  $("year-label").textContent = `Gelesen ${year}`;
  $("year-count").textContent = booksReadIn(year).length;
  renderYearOverview();

  $("stack-count").textContent = stackBooks().length;
}

// Stapel ungelesener Bücher (SuB): gekauft (Bücherregal) und noch zu lesen
function stackBooks() {
  return myLibrary.filter(isUnread);
}

let yearOpen = false;

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
  if (booksReadIn("none").length) list.push("none"); // gelesene Bücher ohne Datum
  return list;
}

const yearLabel = (year) => (year === "none" ? "Ohne Datum" : year);

function renderYearOverview() {
  const box = $("year-overview");
  $("tile-year").setAttribute("aria-expanded", String(yearOpen));
  box.hidden = !yearOpen;
  if (!yearOpen) return;

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
    row.append(cover, info);
    row.onclick = () => showDetail(book);
    return row;
  });
  box.replaceChildren(
    filter,
    el("h3", {}, `Gelesen ${yearLabel(overviewYear)}: ${books.length} ${books.length === 1 ? "Buch" : "Bücher"}`),
    ...rows
  );
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
    card.append(el("div", { className: "actions" }, del));
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
      const blob = await resizeToJpeg(file, 1200);
      const path = `${me.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from("post-images").upload(path, blob, { contentType: "image/jpeg" });
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
    for (const id of ["view-home", "view-search", "view-library", "view-feed", "view-friend"]) $(id).hidden = true;
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
  for (const n of ["home", "search", "library", "feed", "friend"]) {
    $("view-" + n).hidden = n !== name;
    $("tab-" + n).classList.toggle("active", n === name);
  }
  if (name === "library") renderLibrary();
  if (name === "home") renderHome();
  if (name === "feed") {
    feedLimit = FEED_PAGE;
    loadFeed();
  }
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

// Beim Laden und Neuladen alle Suchfelder leeren (der Browser stellt sonst alte Eingaben wieder her)
function clearSearchFields() {
  for (const id of ["search-form", "add-form"]) $(id).reset();
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
  setTimeout(() => onSession(session), 0);
});
