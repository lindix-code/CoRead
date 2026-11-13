# CoRead

Bücher-App für mich und meine beste Freundin: Lesefortschritt teilen, gegenseitig in der Bibliothek stöbern, Top-Listen und Bewertungen mit Kommentaren.

## Funktionen (Ziel)

1. **Bücher tracken** – aktuelles Buch und Fortschritt, der andere kann mitverfolgen
2. **Bibliothek** – Bücher im eigenen Besitz mit Cover, die andere kann stöbern
3. **Top-Listen** – eigene Listen anlegen, die die andere als Inspiration sieht
4. **Bewertungen + Kommentare** – jedes Buch bewerten und kommentieren
5. **Datenbasis** – Buchsuche mit vollständigem Steckbrief inkl. Cover

## Datenquellen

Kein Zugriff auf Thalia/Hugendubel (keine öffentliche API, Scraping verstößt gegen die AGB und ist fragil). Stattdessen:

- **Google Books API** – Hauptquelle (Titel, Autor:in, Beschreibung, Seiten, ISBN, Cover)
- **Open Library** – Cover-Fallback per ISBN
- **Deutsche Nationalbibliothek (DNB)** – optional, gute deutsche Metadaten

## Technik

- Web-App (läuft auch auf dem Handy, später als PWA installierbar)
- Reines HTML/CSS/JavaScript, keine Build-Tools nötig
- Supabase für Login und Datenbank (Row Level Security: nur ihr zwei seht eure Daten)
- Datenbank-Schema: `supabase/schema.sql` (einmalig im Supabase SQL Editor ausführen; spätere Änderungen liegen in `supabase/migrations/`)

## Ausprobieren

`index.html` im Browser öffnen (oder `python3 -m http.server` im Ordner starten und `http://localhost:8000` aufrufen).

## Roadmap

- [x] 1. Buchsuche mit Steckbrief und Cover (Google Books + Open Library)
- [x] 2. Login für zwei Personen, Verbindung "Freundin" per Einladungscode
- [x] 3. Lesestatus und Fortschritt (Seite)
- [x] 4. Bibliothek (inkl. Einsicht in die der anderen)
- [ ] 5. Bewertungen (Sterne sind drin) und Kommentare (Tabelle fertig, Oberfläche fehlt)
- [ ] 6. Top-Listen
- [ ] 7. Optional: ISBN-Barcode-Scan mit der Handykamera
- [ ] 8. Wöchentlicher automatischer Aufruf (GitHub Action), damit das kostenlose Supabase-Projekt nicht pausiert
