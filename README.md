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
- Aktuell: reines HTML/CSS/JavaScript, keine Build-Tools nötig
- Geplant: Supabase für Login und Datenbank (zwei Personen teilen ihre Daten)

## Ausprobieren

`index.html` im Browser öffnen (oder `python3 -m http.server` im Ordner starten und `http://localhost:8000` aufrufen).

## Roadmap

- [x] 1. Buchsuche mit Steckbrief und Cover (Google Books + Open Library)
- [ ] 2. Login für zwei Personen, Verbindung "Freundin"
- [ ] 3. Aktuelles Buch mit Fortschritt
- [ ] 4. Bibliothek (inkl. Einsicht in die der anderen)
- [ ] 5. Bewertungen und Kommentare
- [ ] 6. Top-Listen
- [ ] 7. Optional: ISBN-Barcode-Scan mit der Handykamera
