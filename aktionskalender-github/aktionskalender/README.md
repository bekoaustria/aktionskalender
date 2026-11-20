# Aktionskalender Fachhandel

Aktionskalender für den österreichischen Fachhandel mit den Marken elektrabregenz, Beko und Indesit. Er umfasst Tagesaktionen und Zeitraum-Aktionen, Warenkorb und Bestellung, Freigabeprozess, Flyer (PDF und online) sowie das Speichern von Aktionen als Vorlage und im Archiv.

Betrieb über **Cloudflare Pages** mit **Cloudflare KV** als Speicher. Kein eigener Server und kein Build-Schritt nötig.

| Adresse | Für wen | Inhalt |
|---|---|---|
| `/` | Händler | Kalender, Tagesaktion, Warenkorb, Bestellung |
| `/admin` | Beko-Team | Verwaltung, Flyer, Bestellungen, Aktionen, Freigabe-Personen, Zugänge |
| `/#flyer` | alle mit dem Link | nur der Online-Flyer (nachdem er unter Flyer → „Online stellen“ online gestellt wurde) |
| `/?k=…` | Freigebende | persönlicher Freigabe-Link (wird in der Verwaltung erzeugt) |
| `/?einladung=…` | neue Zugänge | Erstanmeldung im Konten-Modus |

## Aufbau

| Datei / Ordner | Zweck |
|---|---|
| `public/index.html` | die komplette Seite (Kalender, Verwaltung, Flyer, Katalog mit 233 Geräten) |
| `public/_redirects` | `/admin` zeigt dieselbe Seite |
| `public/_headers` | kein Caching der Seite, keine Suchmaschinen-Indexierung |
| `functions/api/[[route]].js` | alle Server-Endpunkte unter `/api/…` |
| `functions/api/_lib.js` | gemeinsame Logik: Anmeldung, Freigabe, Bestellprüfung, Mailversand |
| `tools/worker-entry.js` | Einstieg für die Variante „Direct Upload“ (`npm run build:direct`) |
| `tests/` | automatische Tests der Schnittstellen (nur lokal ausführen) |

## Einrichtung (einmalig, ca. 15 Minuten)

| Schritt | Wo | Was |
|---|---|---|
| 1 | GitHub | Neues **privates** Repository anlegen und den Inhalt dieses Ordners hochladen („Add file → Upload files“, Ordner per Drag & Drop) |
| 2 | Cloudflare → Workers & Pages → KV | Namespace anlegen, z. B. `aktionskalender` |
| 3 | Cloudflare → Workers & Pages → Create → Pages → **Connect to Git** | Repository wählen. Framework: *None*. Build command: leer. **Build output directory: `public`** |
| 4 | Pages-Projekt → Settings → **Bindings** | KV-Namespace hinzufügen, Variablenname **`KALENDER`** |
| 5 | Pages-Projekt → Settings → **Variables and Secrets** | `ADMIN_PASSWORD` als *Secret* anlegen (langes Passwort) |
| 6 | Pages-Projekt → Deployments | **Retry deployment** (damit Bindung und Secret aktiv werden) |
| 7 | Browser | `https://<projekt>.pages.dev/admin` öffnen und mit dem Passwort anmelden |

Eigene Domain: Pages-Projekt → Custom domains (z. B. `aktionen.bekoaustria.com`).

## Einstellungen (Variables and Secrets)

| Name | Pflicht | Wirkung |
|---|---|---|
| `ADMIN_PASSWORD` | ja | Passwort für `/admin` (Secret) |
| `ADMIN_USERS` | nein | Schaltet den **Konten-Modus** ein. Händler melden sich dann mit eigenem Zugang an, der Kalender ist nicht mehr öffentlich. Format: `Name <mail@beko.com>; Name 2 <mail2@beko.com>` |
| `INITIAL_PASSWORD` | nein | Startpasswort für Einladungen (Standard `bekoblackweeks`) |
| `RESEND_API_KEY` + `MAIL_FROM` | nein | Mailversand Variante A über Resend (Absender-Domain muss bei Resend verifiziert sein) |
| `ORDER_WEBHOOK_URL` | nein | Mailversand Variante B über Webhook, z. B. Power Automate → Outlook. Empfängt JSON mit `to`, `cc`, `subject`, `text`, `html`, `order` |
| `MAIL_COPY_TO_CUSTOMER` | nein | `false` schaltet die Kopie an den Händler ab |

Ohne Mailversand werden Bestellungen nur gespeichert. Sie stehen in der Verwaltung unter „Bestellungen“ (mit CSV-Export).

**Konten-Modus, erste Anmeldung im Team:** `/admin` öffnen, den eigenen Namen wählen und als Passwort das `ADMIN_PASSWORD` eingeben. Danach legen Sie sofort ein eigenes Passwort fest. Händler-Zugänge legen Sie in der Verwaltung unter „Zugänge“ an und laden sie per E-Mail ein.

## Was der Server prüft

| Thema | Regel |
|---|---|
| Speichern der Planung | nur mit Admin-Passwort bzw. Team-Anmeldung; max. 2 MB; vorheriger Stand wird 90 Tage als Sicherung aufbewahrt (`backup:<Zeitpunkt>`) |
| Bestellung | nur Aktionen, die heute laufen (Wiener Zeit); Preis kommt aus der Planung, nicht vom Browser; Kontingent wird abgezogen; max. 8 Bestellungen pro Minute und Adresse; Nummer `AK-JJJJMMTT-XXXX` |
| Freigabe | nur über den persönlichen Link und nur für die eigene Stufe; Ablehnung nur mit Kommentar |
| Freigabe-Links | werden nur an Admins ausgeliefert und bleiben beim Speichern erhalten |
| Konten | Passwörter nur als PBKDF2-Hash; Zurücksetzen meldet sofort ab; max. 10 Anmeldeversuche pro Minute |
| Datenblätter | nur PDF, max. 20 MB |

## Aktualisieren

Neue Version der Seite: nur `public/index.html` im Repository ersetzen. Cloudflare veröffentlicht automatisch, die Planung im KV bleibt erhalten.

## Daten aus dem Claude-Artifact übernehmen

Im Claude-Artifact unter Aktionen eine gespeicherte Aktion als Datei herunterladen. In dieser Installation unter Aktionen → „Aus Datei laden“ übernehmen. Bilder eigener Produkte und hochgeladene Datenblätter liegen im Claude-Artifact und müssen hier neu hochgeladen werden.

## Lokal testen (optional, Node.js 18+)

```
npm install
cp .dev.vars.example .dev.vars      # Passwort eintragen
npm run dev                         # http://localhost:8788
npm test                            # Schnittstellen-Test (Passwort-Modus) – nur lokal!
```

## Variante ohne GitHub (Direct Upload)

`npm run build:direct` erzeugt `dist-direct/` mit `index.html` und `_worker.js`. Diesen Ordner als ZIP unter Workers & Pages → Create → Pages → **Upload assets** hochladen. Bindung `KALENDER` und Secret `ADMIN_PASSWORD` wie oben anlegen und neu deployen.
