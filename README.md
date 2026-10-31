# 🏔️ zemmat go

**Mitanand an d'Luft.** Statt zwölf WhatsApp-Gruppa für Bika, Rennvelo, Gravla, Jogga, Wandra, Klettra und Schitoura gibt's eine Seite:
du tragst ii, wenn du gosch, und wer will, kunnt mit.

> *I gang morn um 14:00 für a Stund jogga. Wer kunnt mit?*

**👉 App: [paulrigger.github.io/zemmat-go](https://paulrigger.github.io/zemmat-go/)** · [Demo](https://paulrigger.github.io/zemmat-go/?demo)
<sub>Für die echte Version den Link mit Schlüssel (`?k=…`) aus der Gruppe verwenden.</sub>

<p>
  <img src="docs/liste.png" width="260" alt="Liste der nächsten Termine">
  <img src="docs/neu.png" width="260" alt="Neuer Termin als Lückentext">
</p>

---

## Funktionen

- **Liste der nächsten Termine**, nach Tag gruppiert (Hüt / Morn / Übermorn / Wochentag). Vorbei = verschwindet automatisch
- **➕ Neuer Termin als Lückentext** im Bilderbuch-Stil – auf die gelben Wörter tippen zum Ändern:
  - **Wer:** I · Mir · Paul und Anna (Verb passt sich an: *gang / gond*)
  - **Wenn:** hüt, morn, übermorn, Wochentage oder Datum
  - **Uhrzeit:** Schnellauswahl oder genaue Zeit (Uhr-Emoji passt zur Uhrzeit 🕑)
  - **Dauer** (optional), **Sportart** (oder „öppis anders“), **Treffpunkt** (optional, die letzten werden gemerkt)
  - **„Nochher hon i o no Zit für an Drink 🍺“** – Antippen streicht den Satz durch
- **🙋 I bin dabei!** / doch ned – Teilnehmer:innen stehen beim Termin
- **📣 Teilen** (Share-Sheet bzw. WhatsApp) mit direktem Link auf den Termin
- **📆 Kalender** – .ics-Datei zum Importieren
- **Kein Login:** Name wird beim ersten Mal abgefragt und lokal gespeichert
- Absagen kann nur, wer den Termin angelegt hat (Namensvergleich)
- PWA: „Zum Home-Bildschirm“ hinzufügen
- 90er-Look: WordArt, Laufschrift, Under Construction, Besucher-Zähler (= Einträge seit Anfang), Webring 😄

## Architektur

```
 ┌──────────────────────────┐   fetch (JSON)    ┌──────────────────────┐      ┌───────────────────┐
 │ GitHub Pages             │ ────────────────▶ │ Apps Script Web-App  │ ───▶ │ Google Sheet      │
 │ index.html (kein Build)  │ ?k=… / POST text  │ api/Code.gs          │      │ Tab „Events“      │
 └──────────────────────────┘ ◀──────────────── └──────────────────────┘      └───────────────────┘
```

- **Frontend:** eine einzige `index.html`, kein Framework, kein Build. Ist `API_URL` leer → Demo-Modus mit `localStorage`.
- **API:** Apps Script, an das Sheet gebunden. *Ausführen als: Ich*, *Zugriff: Jeder*, geschützt mit einem Schlüssel.
- **Daten:** nur im Google Sheet. Im Repo stehen weder Daten noch Schlüssel.

## Einrichtung (einmalig, ~5 Minuten)

1. Neues **Google Sheet** anlegen, z. B. „zemmat go“.
2. **Erweiterungen → Apps Script** → Inhalt von [`api/Code.gs`](api/Code.gs) einfügen.
   Unter Projekteinstellungen „appsscript.json im Editor anzeigen“ aktivieren und [`api/appsscript.json`](api/appsscript.json) übernehmen.
3. Funktion **`setup`** ausführen (Berechtigungen bestätigen) → im Ausführungsprotokoll stehen **Schlüssel** und **Gruppen-Link**.
4. **Bereitstellen → Neue Bereitstellung → Web-App** · Ausführen als: *Ich* · Zugriff: *Jeder* → `/exec`-URL kopieren.
5. In `index.html` oben eintragen:
   ```js
   const API_URL = 'https://script.google.com/macros/s/…/exec';
   ```
   committen → nach ~1 Minute live.
6. Gruppen-Link `https://paulrigger.github.io/zemmat-go/?k=SCHLÜSSEL` verteilen. Der Schlüssel wird im Browser gespeichert und aus der Adresszeile entfernt; geteilte Termin-Links enthalten ihn wieder.

**Code-Änderungen an der API:** Bereitstellen → Bereitstellungen verwalten → ✏️ → Version „Neu“ (sonst bleibt die alte aktiv, URL bleibt gleich).
**Ohne Schlüssel betreiben:** Skripteigenschaft `KEY` löschen.
**Schlüssel tauschen:** `KEY` ändern → alte Links funktionieren nicht mehr.

## API

| Methode | Body / Parameter | Antwort |
|---|---|---|
| `GET` | `?action=list&k=…` | `{ok, version, events:[…], total}` (ab gestern, ohne abgesagte) |
| `POST` | `{action:"create", k, event:{von, datum, zeit, dauer, sport, sportText, wer, treffpunkt, drink}}` | `{ok, event}` |
| `POST` | `{action:"join"\|"leave", k, id, name}` | `{ok, event}` |
| `POST` | `{action:"cancel", k, id, name}` | `{ok}` – nur Ersteller:in |

POST immer als `Content-Type: text/plain` (kein CORS-Preflight bei Apps Script). Fehler: `{ok:false, error:"…"}`.

## Datenmodell (Tab `Events`, alles Text)

| Spalte | Beispiel | Bemerkung |
|---|---|---|
| id | `a1b2c3d4` | |
| erstellt | `2026-10-31T17:50:00+01:00` | |
| von | `Paul` | Ersteller:in |
| datum / zeit | `2026-11-01` / `14:00` | |
| dauer | `h1` | `h05 h1 h15 h2 h3 halb ganz` oder leer |
| sport | `jogga` | `mtb rennrad gravel jogga wandra klettra schitour langlauf schwimma anders` |
| sportText | | nur bei `anders` |
| wer | `i` / `mir` / `Paul, Anna` | |
| treffpunkt | `Rheinbrugg` | optional |
| drink | `ja` / leer | |
| dabei | `Anna, Ben` | |
| status | leer / `abgsagt` | |

## Entwicklung

`index.html` direkt im Browser öffnen → Demo-Modus. Demo-Daten zurücksetzen: `localStorage.removeItem('zg_demo')`.

## Ideen / Roadmap

- [ ] Kommentar pro Termin („I bin 10 Minuta später“)
- [ ] Filter nach Sportart
- [ ] Wiederkehrende Termine (z. B. jeden Mittwoch Lauftreff)
- [ ] Benachrichtigung bei neuen Terminen (ntfy.sh oder Telegram-Bot)
- [ ] Lustenauer Dialekt-Modus 😉
