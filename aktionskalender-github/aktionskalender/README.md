# Aktionskalender Fachhandel – elektrabregenz · Beko · Indesit

Adventkalender, Black Friday, Black Week, Black Month oder Monatskalender für den österreichischen Fachhandel.
Jeden Tag ein Aktionsgerät zum Sonder-HEK, bestellbar am Aktionstag von 0:00 bis 23:59 Uhr (Wiener Zeit).

| Adresse | Für wen | Inhalt |
|---|---|---|
| `https://<deine-domain>/` | Händler | Kalender mit Türchen, Tagesaktion, Bestellung per E-Mail |
| `https://<deine-domain>/admin` | Verwaltung (Passwort) | Sortiment, HEK, Aktionspreise, Mengen, Aktionstage, Vorlagen, Design |

## Aufbau

| Datei | Zweck |
|---|---|
| `public/index.html` | Die komplette Seite inkl. Sortiment (233 Geräte), Bildern und weißen Markenlogos |
| `public/_redirects` | Leitet `/admin` auf die Seite um |
| `public/_headers` | Kein Caching der Seite, keine Suchmaschinen-Indexierung |
| `functions/api/config.js` | Liest und speichert den Kalender in Cloudflare KV |
| `functions/api/auth.js` | Prüft das Verwaltungs-Passwort |

Kein Build-Schritt, kein Node.js nötig – alles läuft über die Web-Oberflächen von GitHub und Cloudflare.

## Einrichtung (einmalig, ca. 15 Minuten)

| Schritt | Wo | Was |
|---|---|---|
| 1 | github.com → **New repository** | Name z. B. `aktionskalender`, **Private** wählen, anlegen |
| 2 | Im neuen Repository → **uploading an existing file** | Die Ordner `public` und `functions` sowie `README.md` hineinziehen → **Commit changes** |
| 3 | dash.cloudflare.com → **Storage & Databases → KV** | **Create namespace**, Name `aktionskalender` |
| 4 | **Workers & Pages → Create → Pages → Import an existing Git repository** | GitHub verbinden, Repository `aktionskalender` wählen |
| 5 | Build-Einstellungen | Framework preset: **None** · Build command: *leer lassen* · Build output directory: **public** → **Save and Deploy** |
| 6 | Pages-Projekt → **Settings → Bindings → Add → KV namespace** | Variable name: **KALENDER** · Namespace: `aktionskalender` → speichern |
| 7 | Pages-Projekt → **Settings → Variables and Secrets → Add** | Type: **Secret** · Name: **ADMIN_PASSWORD** · Wert: ein sicheres Passwort → speichern |
| 8 | Pages-Projekt → **Deployments** | Beim letzten Deployment **⋯ → Retry deployment**, damit Bindung und Passwort aktiv werden |
| 9 | optional: **Custom domains → Set up a custom domain** | z. B. `aktionen.bekoaustria.com` (wie bei geraeteschutz.bekoaustria.com) |

Danach `https://<projekt>.pages.dev/admin` öffnen, mit dem Passwort anmelden, Vorlage wählen, Sortiment und Aktionstage pflegen und **Speichern & veröffentlichen**.

## Bedienung Verwaltung

| Bereich | Funktion |
|---|---|
| Einstellungen | Vorlage (Advent, Black Friday, Black Week, Black Month, Ganzer Monat), Design (Weihnachten, Black Deals, Klassisch), Startdatum, Anzahl Tage (1–62), Titel, Bestell-E-Mail, Testdatum |
| Aktionssortiment | Geräte per Klick aufnehmen/entfernen, HEK und UVP anpassen, Gerät direkt einem oder mehreren Aktionstagen zuordnen |
| Tagesbelegung | Pro Tag Gerät, HEK, Aktions-HEK und verfügbare Menge („Nur mehr 5 Stück verfügbar“) |
| Speichern | Erst **Speichern & veröffentlichen** macht Änderungen für Händler sichtbar. Offene Händlerseiten aktualisieren sich spätestens nach einer Minute. |

## Sicherheit und Sicherung

- Lesen ist öffentlich (für alle Händler mit dem Link), Speichern nur mit dem Passwort.
- Bei jedem Speichern wird der vorherige Stand 90 Tage lang als `backup:<Zeitpunkt>` im KV-Namespace aufgehoben (Cloudflare → KV → `aktionskalender` → Einträge).
- Passwort ändern: Schritt 7 wiederholen und neu deployen.

## Aktualisieren

Neue Version der Seite: `public/index.html` im GitHub-Repository ersetzen (**Add file → Upload files**) → Commit. Cloudflare veröffentlicht automatisch. Die gespeicherten Kalenderdaten bleiben erhalten.
