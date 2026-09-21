# Immich Person Review

Eigenständige Docker-Web-App zum Prüfen und Korrigieren von Immich-Personenzuordnungen.

## Version 0.9.1

Neu in dieser Version:

- die Asset-Galerie lässt sich zwischen `außerhalb`, `innerhalb` und `alle` umschalten; innerhalb des Radius stehen die grenzwertigsten Faces zuerst,
- der Mittelpunkt `c` des Vektor-Kreises kann direkt im Diagramm mit der Maus oder per Touch verschoben werden,
- alle Cosinusabstände werden dabei zum neuen Mittelpunkt im hochdimensionalen Raum neu berechnet,
- die Punkte werden radial um das aktuelle Zentrum neu projiziert, sodass der sichtbare Radius weiterhin dem tatsächlichen Abstand entspricht,
- beim Überfahren eines Vektorpunkts wird ein zugeschnittener Face-Thumbnail geladen,
- Asset-Karten enthalten einen Link zum zugehörigen Asset in Immich,
- interne API-Verbindung und externe Browser-URL sind getrennt:
  - `IMMICH_URL` für die Kommunikation innerhalb des Docker-Netzes,
  - `IMMICH_EXTERNAL_URL` für Personen- und Asset-Links im Browser,
- `docker-compose.yml` enthält die Anbindung an das externe Netzwerk `immich_default` bereits vollständig.

Die App schreibt **nicht direkt** in die Immich-Datenbank. Änderungen an Personenzuordnungen laufen über die Immich-REST-API. PostgreSQL wird nur lesend für Face-Embeddings und die dazugehörigen Metadaten verwendet.

## Funktionsumfang

- Person auswählen oder suchen
- Personen-Timeline paginiert und chronologisch anzeigen
- Asset, Face-Bounding-Box und vergrößerten Gesichtsausschnitt anzeigen
- Alter zum Aufnahmezeitpunkt berechnen
- Face einer anderen oder einer neuen Person zuweisen
- Personenzuordnung lösen, ohne Face-Markierung und Embedding zu löschen
- Face-Markierung vollständig entfernen
- Zuordnungen vor dem Geburtsdatum gesammelt prüfen und lösen
- unbenannte Personen anzeigen, verstecken oder zusammenführen
- Personen-Thumbnails aktualisieren
- doppelte Face-Boxen innerhalb desselben Assets bereinigen
- 512D-Vektorcluster mit:
  - Durchschnittsvektor und normierter Mittelrichtung `μ`,
  - verschiebbarem aktuellem Zentrum `c`,
  - frei wählbarem Distanzradius,
  - P90-/P95-Presets für das aktuelle Zentrum,
  - Hover-Face-Thumbnail,
  - umschaltbarer Asset-Galerie für Faces außerhalb, innerhalb oder unabhängig vom Radius,
  - Mehrfachauswahl und Lösen der Zuordnung,
  - JSON-Export einschließlich aktuellem Mittelpunkt und neu berechneten Abständen.

## Konfiguration

```bash
cp .env.example .env
nano .env
```

Mindestens erforderlich:

```dotenv
# Interne URL des Immich-Servers im Docker-Netz
IMMICH_URL=http://immich-server:2283
IMMICH_API_PREFIX=/api
IMMICH_API_KEY=DEIN_API_KEY

# Vom Browser erreichbare Webadresse
IMMICH_EXTERNAL_URL=https://photos.example.com
```

`IMMICH_EXTERNAL_URL` wird ausschließlich für Links verwendet. Der API-Key und die interne Docker-Adresse werden nicht an den Browser weitergegeben.

Für die Clusteransicht zusätzlich:

```dotenv
IMMICH_DB_HOST=database
IMMICH_DB_PORT=5432
IMMICH_DB_USER=immich_person_review
IMMICH_DB_PASSWORD=DEIN_READ_ONLY_PASSWORT
IMMICH_DB_NAME=immich
IMMICH_DB_SSL=false
```

Alternativ kann eine vollständige Verbindung in `IMMICH_DB_URL` gesetzt werden.

## Read-only-PostgreSQL-Benutzer

Als PostgreSQL-Administrator in der Immich-Datenbank ausführen:

```sql
CREATE ROLE immich_person_review
  LOGIN
  PASSWORD 'EIN_LANGES_ZUFAELLIGES_PASSWORT'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION;

GRANT CONNECT ON DATABASE immich TO immich_person_review;
GRANT USAGE ON SCHEMA public TO immich_person_review;
GRANT SELECT ON TABLE
  public.asset,
  public.asset_face,
  public.face_search
TO immich_person_review;
```

Nach einer Immich-Migration, die eine dieser Tabellen neu erstellt, müssen die `GRANT`-Anweisungen gegebenenfalls erneut ausgeführt werden.

## Start mit Docker Compose

Die mitgelieferte `docker-compose.yml` verwendet das externe Netzwerk `immich_default`:

```yaml
networks:
  immich:
    external: true
    name: immich_default
```

Den tatsächlichen Netzwerknamen prüfen:

```bash
docker network ls | grep immich
```

Falls dein Netzwerk anders heißt, passe `name:` in `docker-compose.yml` an.

Start:

```bash
docker compose up -d --build
```

Oberfläche:

```text
http://DEIN-SERVER:3030
```

Logs:

```bash
docker compose logs -f immich-person-review
```

## Nur Docker

```bash
docker build -t immich-person-review:0.9.1 .

docker run -d \
  --name immich-person-review \
  --restart unless-stopped \
  -p 3030:3000 \
  --network immich_default \
  -e IMMICH_URL=http://immich-server:2283 \
  -e IMMICH_EXTERNAL_URL=https://photos.example.com \
  -e IMMICH_API_PREFIX=/api \
  -e IMMICH_API_KEY='DEIN_API_KEY' \
  -e IMMICH_DB_HOST=database \
  -e IMMICH_DB_PORT=5432 \
  -e IMMICH_DB_USER=immich_person_review \
  -e IMMICH_DB_PASSWORD='DEIN_READ_ONLY_PASSWORT' \
  -e IMMICH_DB_NAME=immich \
  immich-person-review:0.9.1
```

## Cluster-Mathematik

Jedes Face-Embedding wird L2-normalisiert. Aus den normalisierten Embeddings wird zunächst der arithmetische Mittelwert und daraus die normierte Mittelrichtung `μ` berechnet.

Für ein normalisiertes Face-Embedding `x` und das aktuelle Zentrum `c` gilt:

```text
Cosinusdistanz d(x, c) = 1 - x · c
```

Kleine Werte bedeuten hohe Ähnlichkeit zum aktuellen Zentrum.

### Verschieben des Mittelpunkts

Die ersten beiden PCA-Richtungen im Tangentialraum von `μ` bilden zusammen mit `μ` einen dreidimensionalen Unterraum der 512-dimensionalen Einbettung. Beim Ziehen des Mittelpunkts wird `c` auf der Einheitssphäre innerhalb dieses Unterraums bewegt.

Für jeden Punkt speichert der Server nur drei skalare Projektionen:

- `x · μ`
- `x · pc1`
- `x · pc2`

Damit kann der Browser den exakten Skalarproduktswert `x · c` für jeden zulässigen verschobenen Mittelpunkt berechnen, ohne das vollständige Face-Embedding an den Browser zu senden.

Die Winkelachsen werden entlang der Bewegung parallel transportiert. Anschließend wird jeder Punkt mit seinem echten Abstand `d(x, c)` radial um den neuen Mittelpunkt gezeichnet. Daher stimmt „innerhalb/außerhalb des Kreises“ auch nach dem Verschieben mit dem neu berechneten hochdimensionalen Abstand überein.

### Galeriefilter

- **Außerhalb:** `d(x, c) > Radius`, größte Distanz zuerst.
- **Innerhalb:** `d(x, c) ≤ Radius`, ebenfalls größte Distanz zuerst; dadurch stehen die grenzwertigsten noch enthaltenen Faces zuerst.
- **Alle:** sämtliche Faces nach abnehmender Distanz.

Beim Wechsel des Filters werden nicht mehr sichtbare Markierungen aus Sicherheitsgründen verworfen, damit die Aktion „Personenzuordnung lösen“ nur auf die aktuell angezeigte Gruppe wirkt.

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

Für das Lösen einer Zuordnung wird das Face kurz einer versteckten temporären Person zugewiesen. Danach wird diese Person gelöscht. Dadurch bleibt die Face-Markierung erhalten, während ihre Personenzuordnung leer wird.

## Konfigurationsvariablen

| Variable | Bedeutung | Standard |
|---|---|---|
| `IMMICH_URL` | interne Basis-URL des Immich-Servers | erforderlich |
| `IMMICH_EXTERNAL_URL` | vom Browser erreichbare Immich-Webadresse für Links | fällt aus Kompatibilitätsgründen auf `IMMICH_URL` zurück |
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
       ├─ Immich REST API       über IMMICH_URL
       ├─ Immich-Weblinks       über IMMICH_EXTERNAL_URL
       └─ PostgreSQL read-only  für Embeddings und Face-/Asset-Metadaten
```

API-Key und Datenbankpasswort werden nicht an den Browser ausgegeben. Einzelne vollständige Face-Embeddings werden ebenfalls nicht gesendet. Für das Verschieben des Zentrums erhält der Browser pro Face nur drei skalare Projektionswerte sowie die für die Darstellung benötigten Metadaten.

## Entwicklung und Tests

```bash
npm install
npm test
npm start
```
