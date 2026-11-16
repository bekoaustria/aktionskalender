# Aktionskalender – Update 13.11.2026: Aktionen speichern, Archiv, Versionen

## Einspielen (GitHub + Cloudflare Pages)
| Datei | Was tun |
|---|---|
| `public/index.html` | ersetzen |
| `functions/api/aktionen.js` | **neu** hinzufügen (neben `_core.js` und `[[path]].js`) |
| alle anderen Dateien | unverändert lassen |

Committen – Cloudflare baut automatisch neu. Planung, Freigaben, Bestellungen und Zugänge im KV bleiben erhalten. Keine neuen Einstellungen nötig (KV-Bindung `KALENDER` wird mitbenutzt).

## Neu
| Funktion | Umsetzung |
|---|---|
| Menüpunkt „Aktionen“ | nur Beko-Team (Verwaltungsrechte) |
| Unter Namen speichern | aktuelle Planung als Vorlage, z. B. „Black Weeks 2026“; auch direkt aus der Verwaltung („Unter Namen sichern“, inkl. nicht veröffentlichter Änderungen) |
| Laden / Kopie für neuen Zeitraum | Kopie verschiebt alle Tages- und Zeitraum-Aktionen auf ein neues Startdatum (Vorschlag: Black-Deals am nächsten Black Friday, Ostern am nächsten Ostern, sonst gleiches Datum nächstes Jahr). Live erst nach „Speichern & veröffentlichen“. |
| Mit Ergebnis archivieren | Planung + Ergebnis aus den Bestellungen: Bestellungen, Händler, Stück, Kontingent, Abverkauf %, Umsatz zum Aktions-HEK, je Aktion; CSV-Export |
| Versionen | automatisch bei jedem Speichern, die letzten 30, „Wiederherstellen“ |
| Automatisches Zwischenspeichern | Entwurf wird beim Bearbeiten im Browser gesichert; nach Absturz/Neuladen „Entwurf wiederherstellen“ |
| Datum zuordnen (Aktionssortiment) | Dropdown enthält jetzt auch „Gesamter Aktionszeitraum“ und „Von – bis wählen …“ → legt eine Zeitraum-Aktion an; Zeiträume erscheinen als Chips am Gerät und lassen sich dort entfernen |
| Datei | Aktion als JSON herunterladen und in einer anderen Installation über „Aus Datei laden“ übernehmen (z. B. vom Claude-Artifact nach Cloudflare) |

Server: `/api/aktionen` prüft die Anmeldung über die bestehende Serverlogik (`/api/session/me`, Rolle admin). KV-Schlüssel `idx:aktionen`, `aktionen:<id>`, `idx:versionen`, `versionen:<id>`.

Direct Upload (nur `index.html` + `_worker.js`): dort lässt sich keine Zusatzdatei ablegen – Speicherfunktion bitte über die GitHub-Variante nutzen.
