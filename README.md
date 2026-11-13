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
- [x] Pinnwand: Blogeinträge mit Fotos und optionalem Buch
- [ ] 8. Wöchentlicher automatischer Aufruf (GitHub Action), damit das kostenlose Supabase-Projekt nicht pausiert
- [x] Glöckchen mit Zähler für neue Pinnwand-Beiträge der anderen (Migration 009)
- [ ] 9. Push-Benachrichtigung "Neuer Beitrag auf der Pinnwand" (App auf dem iPhone-Home-Bildschirm installieren, Web-Push mit Service Worker, Supabase Edge Function + Datenbank-Webhook, geheimer VAPID-Schlüssel nur als Supabase-Secret)

### Ideen für später (gesammelt, noch nicht eingeplant)

- [x] 10. Aktuelles Buch auf der Startseite größer/kleiner stellen können
- [ ] 11. Profil: anlegen, Passwort ändern, Farben ändern usw.
- [ ] 12. Neuer Reiter "BookClub" (Platzhalter in der Navigation ist da, Funktionen fehlen noch)
  - [ ] 12.1 Meilensteine, einzeln und gemeinsam anlegen
  - [ ] 12.2 Badges, die gemeinsam erworben werden
  - [ ] 12.3 Buddy Read: Vorschlag machen, ein Buch parallel gemeinsam zu lesen, inkl. Kommentar-Funktion
- [ ] 13. Zitate hinterlegen oder markieren
- [ ] 14. Seitenanzahl zusammenzählen (einzeln und gemeinsam)
- [ ] 15. Liste mit ausgeliehenen Büchern als Erinnerung (evtl. im Profil)
- [ ] 16. Liste mit absoluten Lieblingsbüchern aller Zeiten
- [ ] 17. Klare Buchempfehlung für die andere Person

- [ ] 18. Inspiration anbieten, wenn gerade kein Buch gelesen wird (z. B. auf der Startseite statt "Du liest gerade kein Buch")
