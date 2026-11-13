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

function showDetail(book, readOnly = false) {
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
      entry ? entry.status : "want"
    );
    const ownedBox = el("input", { id: "f-owned", type: "checkbox", checked: !!(entry && entry.owned) });
    const ownedField = el("label", { className: "check" }, ownedBox, " In meinem Bücherregal (gekauft)");
    const startedInput = el("input", { type: "date", value: (entry && entry.startedAt) || "" });
    const finishedInput = el("input", { type: "date", value: (entry && entry.finishedAt) || "" });
    // Sobald jemand das Datum selbst anfasst (auch löscht), setzen wir nichts mehr automatisch
    for (const input of [startedInput, finishedInput]) {
      input.oninput = () => (input.dataset.touched = "1");
    }
    const startedField = el("label", { className: "field" }, "Begonnen am", startedInput);
    const finishedField = el("label", { className: "field" }, "Beendet am", finishedInput);
    const statusSelect = statusField.querySelector("select");
    const updateDateFields = () => {
      const st = statusSelect.value;
      startedField.hidden = !["reading", "read"].includes(st);
      finishedField.hidden = st !== "read";
      progressField.hidden = st !== "reading";
      // Vorschlag "heute", solange das Feld leer und noch nicht selbst bearbeitet ist
      if (st === "reading" && !startedInput.value && !startedInput.dataset.touched) startedInput.value = todayLocal();
      if (st === "read" && !finishedInput.value && !finishedInput.dataset.touched) finishedInput.value = todayLocal();
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
  renderStackOverview();
}

let stackOpen = false;

// Stapel ungelesener Bücher (SuB): gekauft (Bücherregal) und noch zu lesen
function stackBooks() {
  return myLibrary.filter(isUnread);
}

function renderStackOverview() {
  const box = $("stack-overview");
  $("tile-stack").setAttribute("aria-expanded", String(stackOpen));
  box.hidden = !stackOpen;
  if (!stackOpen) return;

  const books = stackBooks();
  if (!books.length) {
    box.replaceChildren(
      el("p", { className: "meta" }, "Dein Stapel ist leer. Hier landen gekaufte Bücher (im Bücherregal), die du noch lesen möchtest.")
    );
    return;
  }
  const rows = books.map((book) => {
    const row = el("button", { className: "row", type: "button" });
    const info = el(
      "div",
      { className: "row-info" },
      el("div", { className: "title" }, book.title),
      el("div", { className: "author" }, book.authors.join(", ")),
      el("div", { className: "meta" }, "Gekauft, noch ungelesen")
    );
    row.append(el("div", { className: "row-cover" }, coverElement(book)), info);
    row.onclick = () => showDetail(book);
    return row;
  });
  box.replaceChildren(
    el("h3", {}, `Stapel ungelesener Bücher: ${books.length} ${books.length === 1 ? "Buch" : "Bücher"}`),
    ...rows
  );
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

let overviewYear = String(new Date().getFullYear());

// Jahre für den Filter: die letzten vier plus alle Jahre mit Einträgen
function overviewYears() {
  const current = new Date().getFullYear();
  const years = new Set([0, 1, 2, 3].map((i) => String(current - i)));
  for (const b of myLibrary) {
    if (b.entry.status === "read" && b.entry.finishedAt) years.add(b.entry.finishedAt.slice(0, 4));
  }
  return [...years].sort().reverse();
}

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
        `${year} (${booksReadIn(year).length})`
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
      el("p", { className: "meta" }, `Kein Buch in ${overviewYear} beendet. Gezählt werden Bücher mit Status „Gelesen“ und Datum „Beendet am“.`)
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
    el("h3", {}, `Gelesen ${overviewYear}: ${books.length} ${books.length === 1 ? "Buch" : "Bücher"}`),
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
  if (yearOpen) stackOpen = false;
  renderYearOverview();
  renderStackOverview();
};
$("tile-stack").onclick = () => {
  stackOpen = !stackOpen;
  if (stackOpen) yearOpen = false;
  renderYearOverview();
  renderStackOverview();
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
