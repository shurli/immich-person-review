# Immich Person Review

Kleine, eigenständige Docker-Web-App zum Prüfen und Korrigieren von Immich-Personenzuordnungen.

## Version 0.8.0

Neu ist die Ansicht **Vektor-Cluster** für eine ausgewählte Person:

- liest die Face-Embeddings ausschließlich lesend aus PostgreSQL,
- berechnet den arithmetischen Durchschnittsvektor und die normierte Mittelrichtung,
- misst für jedes Face die Cosinusdistanz zur Mittelrichtung,
- projiziert den lokalen Ausschnitt der 512-dimensionalen Einheitssphäre in eine radiale 2D-Darstellung,
- hält dabei den Radius jedes Punkts exakt gleich seiner echten Cosinusdistanz,
- bietet einen frei einstellbaren Distanzradius sowie P90/P95-Presets,
- zeigt die am wenigsten ähnlichen Gesichter außerhalb des Radius zuerst,
- erlaubt Mehrfachauswahl und das Lösen der Personenzuordnung,
- exportiert die berechneten Cluster-Daten als JSON.

Die App schreibt **nicht direkt** in die Immich-Datenbank. Änderungen an Personenzuordnungen laufen weiterhin über die Immich-REST-API.

## Wichtiger Hinweis zur Datenbankanbindung

Immich stellt die Face-Embeddings derzeit nicht über seine öffentliche REST-API bereit. Die Clusteransicht liest deshalb die internen Tabellen `asset`, `asset_face` und `face_search` direkt. Dieser Teil ist versionsabhängig: Nach größeren Immich-Upgrades sollte die Clusteransicht geprüft werden, bevor Zuordnungen geändert werden.

Für die übrigen Funktionen reicht weiterhin die API-Anbindung. Ohne PostgreSQL-Zugang zeigt die App die bisherigen Review-Ansichten; nur der Tab **Vektor-Cluster** ist nicht verfügbar.

## Funktionsumfang

- Person auswählen oder suchen
- Personen-Timeline paginiert und chronologisch anzeigen
- vollständiges Asset plus Face-Bounding-Box und vergrößerter Gesichtsausschnitt
- Alter zum Aufnahmezeitpunkt aus Geburtsdatum und Aufnahmedatum
- Face einer anderen oder einer neuen Person zuweisen
- Personenzuordnung lösen, ohne Face-Markierung und Embedding zu löschen
- Face-Markierung vollständig entfernen
- Zuordnungen vor dem Geburtsdatum gesammelt prüfen und lösen
- unbenannte Personen anzeigen, verstecken oder zusammenführen
- beste Personen-Thumbnails setzen
- doppelte Face-Boxen einer Person innerhalb desselben Assets bereinigen
- 512D-Vektorcluster mit Distanzradius, Ausreißergalerie und Mehrfachkorrektur

## Benötigte Immich-API-Rechte

Je nach verwendeter Funktion:

- `person.read`
- `person.create`
- `person.update`
- `person.delete`
- `person.merge`
- `asset.read`
- `asset.view`
- `face.read`
- `face.update`
- `face.delete`

Für das Lösen einer Zuordnung verwendet die App ausschließlich offizielle API-Aufrufe: Das Face wird kurz einer versteckten temporären Person zugewiesen; anschließend wird diese Person gelöscht. Dadurch bleibt die Face-Markierung erhalten und ihre Personenzuordnung wird leer.

## Read-only-Datenbankbenutzer anlegen

Der Review-Container benötigt für die Clusteransicht nur `SELECT` auf drei Tabellen. Beispiel, als PostgreSQL-Administrator in der Immich-Datenbank ausgeführt:

```sql
CREATE ROLE immich_person_review
  LOGIN
  PASSWORD 'EIN_LANGES_ZUFAELLIGES_PASSWORT';

GRANT CONNECT ON DATABASE immich TO immich_person_review;
GRANT USAGE ON SCHEMA public TO immich_person_review;
GRANT SELECT ON TABLE
  public.asset,
  public.asset_face,
  public.face_search
TO immich_person_review;
```

Nach einer Immich-Migration, die eine dieser Tabellen neu erstellt, müssen die `GRANT`-Anweisungen gegebenenfalls erneut ausgeführt werden. Die Verwendung des PostgreSQL-Superusers ist nicht empfohlen.

## Start mit Docker Compose

### 1. Konfiguration anlegen

```bash
cp .env.example .env
nano .env
```

Mindestens erforderlich:

```dotenv
IMMICH_URL=http://immich-server:2283
IMMICH_API_PREFIX=/api
IMMICH_API_KEY=DEIN_API_KEY
```

Für die Clusteransicht zusätzlich:

```dotenv
IMMICH_DB_HOST=database
IMMICH_DB_PORT=5432
IMMICH_DB_USER=immich_person_review
IMMICH_DB_PASSWORD=DEIN_READ_ONLY_PASSWORT
IMMICH_DB_NAME=immich
```

Alternativ kann eine vollständige Verbindungszeichenfolge in `IMMICH_DB_URL` gesetzt werden.

### 2. Netzwerk wählen

Liegt PostgreSQL über eine normale IP/DNS-Adresse erreichbar vor, genügt:

```bash
docker compose up -d --build
```

Soll die App den Immich-Dienstnamen `database` im bestehenden Immich-Docker-Netz verwenden, zuerst den Netzwerknamen prüfen:

```bash
docker network ls
```

Dann in `.env` setzen, zum Beispiel:

```dotenv
IMMICH_DOCKER_NETWORK=immich_default
```

und mit dem Overlay starten:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.immich-network.yml \
  up -d --build
```

### 3. Oberfläche öffnen

```text
http://DEIN-SERVER:3030
```

## Nur Docker

```bash
docker build -t immich-person-review:0.8.0 .

docker run -d \
  --name immich-person-review \
  --restart unless-stopped \
  -p 3030:3000 \
  --network immich_default \
  -e IMMICH_URL=http://immich-server:2283 \
  -e IMMICH_API_PREFIX=/api \
  -e IMMICH_API_KEY='DEIN_API_KEY' \
  -e IMMICH_DB_HOST=database \
  -e IMMICH_DB_PORT=5432 \
  -e IMMICH_DB_USER=immich_person_review \
  -e IMMICH_DB_PASSWORD='DEIN_READ_ONLY_PASSWORT' \
  -e IMMICH_DB_NAME=immich \
  immich-person-review:0.8.0
```

## Cluster-Mathematik

Jedes Embedding wird zuerst L2-normalisiert. Aus allen Embeddings einer Person wird der komponentenweise arithmetische Mittelwert berechnet. Seine normierte Richtung ist das Clusterzentrum `μ` auf der Einheitssphäre.

Für ein normalisiertes Face-Embedding `x` verwendet die App:

```text
Cosinusdistanz d(x, μ) = 1 - x · μ
```

Kleine Werte bedeuten hohe Ähnlichkeit zur Cluster-Mitte. Die radiale Position im Diagramm ist genau `d(x, μ)`. Nur der Winkel wird durch eine PCA im Tangentialraum auf zwei Dimensionen reduziert. Deshalb stimmt die Auswahl „innerhalb/außerhalb des Kreises“ mit dem tatsächlichen 512D-Abstand überein, obwohl die Winkel und Nachbarschaften in der 2D-Ansicht nur eine Projektion sind.

Der gewählte Radius ist eine **maximale** Distanz zur Cluster-Mitte. Er ist nicht identisch mit Immichs eigener Erkennungsschwelle, weil Immich Gesichter beziehungsweise Nachbarn untereinander clustert, während diese Review-Ansicht jedes Face mit der Mittelrichtung der ausgewählten Person vergleicht.

## Konfigurationsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `IMMICH_URL` | Basis-URL des Immich-Servers | erforderlich |
| `IMMICH_API_PREFIX` | API-Prefix | `/api` |
| `IMMICH_API_KEY` | serverseitig verwendeter API-Key | erforderlich |
| `IMMICH_DB_URL` | vollständige PostgreSQL-Verbindungszeichenfolge | leer |
| `IMMICH_DB_HOST` | PostgreSQL-Host, falls keine URL verwendet wird | leer |
| `IMMICH_DB_PORT` | PostgreSQL-Port | `5432` |
| `IMMICH_DB_USER` | PostgreSQL-Benutzer | `postgres` |
| `IMMICH_DB_PASSWORD` | PostgreSQL-Passwort | leer |
| `IMMICH_DB_NAME` | Datenbankname | `immich` |
| `IMMICH_DB_SSL` | TLS-Verbindung aktivieren | `false` |
| `VECTOR_CLUSTER_DEFAULT_RADIUS` | fester Startwert; leer bedeutet P90 je Person | leer |
| `VECTOR_CLUSTER_MAX_FACES` | Sicherheitslimit je Person | `30000` |

## Architektur und Datenschutz

```text
Browser
  └─ Review-Container
       ├─ Immich REST API       (Lesen und alle Änderungen)
       └─ PostgreSQL read-only  (nur Embeddings und Face-/Asset-Metadaten)
```

API-Key und Datenbankpasswort werden nicht an den Browser ausgegeben. Einzelne 512D-Face-Embeddings werden ebenfalls nicht an den Browser gesendet; der Server liefert nur Durchschnittsvektoren, Distanzen, Projektionskoordinaten und die für die Galerie benötigten Metadaten.

## Entwicklung und Tests

```bash
npm install
npm test
npm start
```

Der Docker-Build installiert die Node-Abhängigkeiten automatisch.
