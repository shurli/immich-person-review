# Immich Tag Manager

Eigenstaendige Web-App fuer die KI-Tag-Taxonomie, ausgelagert aus
`shurli/immich-person-review` (Ausgangsstand `724b58b8343b6b3f425ec51d92ab00fd96eb2aac`).
Version **0.1.0**. Keine Laufzeit-, Build- oder Repository-Abhaengigkeit von Person Review.

## Funktionen

- Taxonomie-Baum, Suche nach Tags, Pfaden, Labels und Prompts.
- Tags und Kategorien anlegen, bearbeiten, kopieren, loeschen und per Drag & Drop verschieben.
- Deutsche Labels, englische Prompts, Aktivierung, Aggregation und individuelle Thresholds.
- JSON explizit speichern, Validierung, atomarer Dateiaustausch und `.bak` der vorherigen Datei.
- Vollstaendige mitgelieferte Taxonomie mit 350 Konzepten; vorhandene Daten werden nicht ueberschrieben.
- SigLIP2-Preview mit Text-Embeddings vom Immich-ML-Dienst und vorhandenen `smart_search`-Embeddings.
- Live-Threshold, Einzel-Prompt-Scores, Thumbnail-Galerie und Uebernahme in die Taxonomie.
- Warnung beim Verlassen mit ungespeicherten Aenderungen.

**Abgrenzung:** Diese App verwaltet die JSON-Taxonomie und kalibriert Prompts. Wie die
urspruengliche Tag-Funktion vergibt oder entfernt sie keine Tags an Immich-Assets.
Es gibt keinen automatischen Klassifikationsjob. Personen, Gesichtskorrekturen und
Face-Cluster gehoeren ausschliesslich zu `immich-person-review`.

## Docker Compose

```sh
cp .env.example .env
# .env bearbeiten, insbesondere fuer Previews die Zugangsdaten setzen
# Fuer bereits bearbeitete Tags ZUERST MIGRATION.md lesen.
docker compose up -d --build
```

Oberflaeche: `http://DEIN-SERVER:3031`. Person Review kann parallel auf Port 3030 laufen.
Das Netzwerk heisst standardmaessig `immich_default`; mit `IMMICH_NETWORK` anpassen.
Das persistente Volume heisst `immich-tag-manager-data`; `TAG_TAXONOMY_VOLUME` kann
es aendern. Die Container laufen als Benutzer `node` (UID 1000).

Die lokale Taxonomie-Bearbeitung ist auch ohne erreichbares Immich, PostgreSQL oder ML
moeglich. Nur die Preview braucht diese Dienste. Der Status prueft die Immich-Verbindung
und das Smart-Search-Schema, nicht die Face-Tabellen. ML wird beim Preview-Aufruf geprueft.

## Konfiguration

| Variable | Bedeutung / Standard |
| --- | --- |
| `IMMICH_URL` | interne Immich-Basisadresse, fuer Preview erforderlich |
| `IMMICH_EXTERNAL_URL` | externe Webadresse; kein API-Key im Browser |
| `IMMICH_API_PREFIX` | `/api` |
| `IMMICH_API_KEY` | serverseitiger Immich-Key |
| `IMMICH_MACHINE_LEARNING_URL` | `http://immich-machine-learning:3003` |
| `IMMICH_DB_URL` | alternative PostgreSQL-Verbindungszeichenfolge |
| `IMMICH_DB_HOST`, `IMMICH_DB_PORT` | DB-Host; Port `5432` |
| `IMMICH_DB_USER`, `IMMICH_DB_PASSWORD`, `IMMICH_DB_NAME` | Read-only-Zugang; Standardbenutzer `immich_tag_manager`, Datenbank `immich` |
| `IMMICH_DB_SSL` | `false`; mit `true` TLS mit Zertifikatspruefung |
| `TAG_TAXONOMY_PATH` | lokal `storage/tags.json`, Docker `/app/storage/tags.json` |
| `TAG_TAXONOMY_DEFAULT_PATH` | lokal `data/tags.json`, Docker `/app/defaults/tags.json` |
| `TAG_MANAGER_PORT` | Compose-Hostport `3031` |
| `TAG_TAXONOMY_VOLUME` | Compose-Volume `immich-tag-manager-data` |
| `IMMICH_NETWORK` | externes Docker-Netz `immich_default` |
| `PORT` | Prozessport `3000`; Compose setzt ihn fest |

Das konfigurierte `target_model` muss exakt dem Modell der gespeicherten Bild-Embeddings
entsprechen. Eine passende Vektordimension allein beweist keine Modellgleichheit.
Nach einem Modellwechsel den Bestand in Immich vollstaendig neu indizieren.
Der Standard ist `ViT-SO400M-16-SigLIP2-384__webli`.

## Rechte und Sicherheit

Fuer Benutzerpruefung und Previews braucht der API-Key `user.read`, `asset.read` und
`asset.view`. Keine `person.*`, `face.*` oder Tag-Schreibrechte werden benoetigt.
Die Preview begrenzt SQL-Kandidaten auf den Eigentuemer des API-Keys und auf Timeline-
und Archiv-Assets. Versteckte, gesperrte und geloeschte Assets werden nicht abgefragt.
Geteilte Assets anderer Benutzer gehoeren nicht zu diesem Preview-Bestand.

Read-only-Rolle als PostgreSQL-Administrator einrichten:

```sql
CREATE ROLE immich_tag_manager LOGIN PASSWORD 'CHANGE_ME'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE immich TO immich_tag_manager;
GRANT USAGE ON SCHEMA public TO immich_tag_manager;
GRANT SELECT ON TABLE public.asset, public.smart_search TO immich_tag_manager;
ALTER ROLE immich_tag_manager SET default_transaction_read_only = on;
```

Die App schreibt niemals in PostgreSQL. Ein separater SELECT-Benutzer bleibt erforderlich,
auch wenn der Verbindungspool zusaetzlich Read-only-Sitzungen anfordert.
API-Key, DB-Passwort und komplette Bild-Embeddings werden nicht an den Browser gesendet.

**Zugriffsschutz:** Die App hat keine eigene Anmeldung. Nur im vertrauenswuerdigen Netz
betreiben oder hinter einem authentifizierenden Reverse Proxy. Jeder Besucher der App
verwendet ihren serverseitigen Immich-Key und kann die Taxonomie bearbeiten. Nicht
ungeschuetzt ins Internet stellen. Kein CORS-Freigeben fuer fremde Webseiten.

## Entwicklung und Tests

Node.js 22:

```sh
npm ci
npm test
npm run check
node --env-file=.env server.mjs
```

`npm start` verwendet die bereits gesetzten Umgebungsvariablen. Ohne Konfiguration kann
man die Taxonomie bearbeiten. Tests benoetigen keine produktiven Immich-Dienste:
Mathematik, Dateipersistenz, Defaults/Backups, API-Isolation und Preview-Vertrag werden
mit isolierten temporaeren Daten und simulierten Diensten geprueft.

HTTP-Endpunkte: `GET /healthz`, `GET /tag-api/status`, `GET|PUT /tag-api/tags`,
`POST /tag-api/tags/:id/calibration-preview`, `GET /tag-api/assets/:id/thumbnail`.
Alte `/review-api`- und Personen-/Face-Routen werden nicht angeboten.
