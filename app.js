// CoRead – Schritt 1: Buchsuche mit Steckbrief und Cover.
// Datenquellen: Google Books API (Metadaten + Cover), Open Library (Cover-Fallback per ISBN).
// Die Bibliothek wird vorerst nur lokal im Browser gespeichert (localStorage),
// bis Login und Datenbank (Supabase) folgen.

const GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes";
const LIBRARY_KEY = "coread-library";

const $ = (id) => document.getElementById(id);

// ---------- Daten holen ----------

function isIsbn(text) {
  const digits = text.replace(/[-\s]/g, "");
  return /^(\d{9}[\dXx]|\d{13})$/.test(digits);
}

function buildQuery(input) {
  const text = input.trim();
  if (isIsbn(text)) return "isbn:" + text.replace(/[-\s]/g, "");
  return text;
}

// Wandelt eine Google-Books-Antwort in unser eigenes, einfaches Buchformat um.
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

function openLibraryCover(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
}

async function searchBooks(input) {
  const params = new URLSearchParams({
    q: buildQuery(input),
    maxResults: "20",
    printType: "books",
  });
  const res = await fetch(`${GOOGLE_BOOKS_URL}?${params}`);
  if (!res.ok) throw new Error("Die Suche ist gerade nicht erreichbar.");
  const data = await res.json();
  return (data.items || []).map(toBook);
}

// ---------- Anzeige ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.append(child);
  }
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

function bookCard(book) {
  const card = el("button", { className: "card", type: "button" });
  card.append(
    coverElement(book),
    el("div", { className: "title" }, book.title),
    el("div", { className: "author" }, book.authors.join(", "))
  );
  card.onclick = () => showDetail(book);
  return card;
}

function renderGrid(container, books) {
  container.replaceChildren(...books.map(bookCard));
}

function fact(label, value) {
  if (!value) return null;
  return el("div", {}, `${label}: ${value}`);
}

function showDetail(book) {
  const inLibrary = loadLibrary().some((b) => b.id === book.id);

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

  const description = el("p", { className: "description" });
  // Beschreibungen von Google können HTML enthalten – wir zeigen nur reinen Text.
  const tmp = document.createElement("div");
  tmp.innerHTML = book.description;
  description.textContent = tmp.textContent || "Keine Beschreibung vorhanden.";

  const actionBtn = el(
    "button",
    { className: "btn", type: "button" },
    inLibrary ? "Aus Bibliothek entfernen" : "Zur Bibliothek"
  );
  actionBtn.onclick = () => {
    toggleLibrary(book);
    $("detail").close();
    renderLibrary();
  };

  $("detail-content").replaceChildren(
    el("div", { className: "detail" }, top, description, el("div", { className: "actions" }, actionBtn))
  );
  $("detail").showModal();
}

// ---------- Bibliothek (vorerst lokal) ----------

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLibrary(books) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(books));
  } catch {
    // Speicher nicht verfügbar – dann bleibt die Bibliothek leer.
  }
}

function toggleLibrary(book) {
  const books = loadLibrary();
  const exists = books.some((b) => b.id === book.id);
  saveLibrary(exists ? books.filter((b) => b.id !== book.id) : [...books, book]);
}

function renderLibrary() {
  const books = loadLibrary();
  $("library-status").textContent = books.length
    ? `${books.length} Buch/Bücher in deiner Bibliothek`
    : "Noch keine Bücher. Suche eins und füge es hinzu.";
  renderGrid($("library"), books);
}

// ---------- Bedienung ----------

function showTab(name) {
  $("view-search").hidden = name !== "search";
  $("view-library").hidden = name !== "library";
  $("tab-search").classList.toggle("active", name === "search");
  $("tab-library").classList.toggle("active", name === "library");
  if (name === "library") renderLibrary();
}

$("tab-search").onclick = () => showTab("search");
$("tab-library").onclick = () => showTab("library");
$("close").onclick = () => $("detail").close();

$("search-form").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("query").value;
  $("status").textContent = "Suche läuft …";
  $("results").replaceChildren();
  try {
    const books = await searchBooks(input);
    $("status").textContent = books.length ? `${books.length} Treffer` : "Keine Treffer.";
    renderGrid($("results"), books);
  } catch (err) {
    $("status").textContent = err.message;
  }
};
