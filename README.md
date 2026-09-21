# Immich Person Review

## Version 0.3.0

- Pro Face gibt es jetzt **„Markierung entfernen“**. Dabei wird über die stabile Immich-API `DELETE /faces/{id}` genau dieses Face entfernt, ohne es einer anderen Person zuzuweisen.
- Batch-Aktion **„Alle „vor Geburt“ entfernen“** für Personen mit Geburtsdatum. Sie sucht paginiert alle passenden Assets, sammelt die Treffer zuerst vollständig und löscht anschließend die Face-Markierungen.
- Für die Löschfunktionen ist zusätzlich die API-Berechtigung `face.delete` erforderlich.

### Bereits seit 0.2.0

- Face-Abruf korrigiert: `GET /faces?id=<asset-id>` statt des ungültigen Parameters `assetId`.
- Asset-Timeline ist paginiert (standardmäßig 40 Fotos pro Seite).
- Nächste Seite wird automatisch per Infinite Scroll geladen; manueller Ladebutton als Fallback.
- Face-Daten werden lazy geladen, sobald eine Fotokarte in die Nähe des Viewports kommt.
- Metadata-Suche lädt keine unnötigen EXIF-/People-Payloads mehr.


Eine kleine, eigenständige Review-Oberfläche für Immich-Personenerkennung. Sie nutzt ausschließlich die öffentliche/stabile Immich REST API und greift nicht auf die Immich-Datenbank zu.

## Funktionen

- Person auswählen oder suchen
- Alle Bilder der Person chronologisch anzeigen
- Vollständiges Foto plus markierter Face-Bounding-Box
- Parallel ein großer Gesichtsausschnitt
- Alter zum Aufnahmezeitpunkt aus `birthDate` und `fileCreatedAt`
- Falsch zugeordnetes Face direkt einer anderen Person zuweisen
- Neue Person anlegen und Face sofort zuweisen
- API-Key bleibt serverseitig und wird nicht an den Browser ausgeliefert

## Benötigte Immich API-Rechte

Für den Review-Betrieb mindestens:

- `person.read`
- `person.create` (nur für "Neue Person")
- `asset.read`
- `asset.view`
- `face.read`
- `face.update`
- `face.delete` (für „Markierung entfernen“ und den Batch „vor Geburt“)

## Start mit Docker Compose

1. API-Key in `.env` ablegen:

```bash
cp .env.example .env
nano .env
```

2. `IMMICH_URL` in `docker-compose.yml` anpassen. Wenn der Review-Container im selben Docker-Netz wie Immich läuft, ist meist z. B. `http://immich-server:2283` passend. Für eine externe URL z. B. `https://photos.example.com`.

3. Starten:

```bash
docker compose up -d --build
```

4. Öffnen:

```text
http://DEIN-SERVER:3030
```

## Falls Immich unter einem anderen API-Prefix läuft

Standardmäßig wird `/api` verwendet. Das ergibt z. B.:

```text
IMMICH_URL=http://immich-server:2283
IMMICH_API_PREFIX=/api
```

Wenn `IMMICH_URL` bereits auf den API-Pfad zeigt, setze:

```yaml
IMMICH_API_PREFIX: ""
```

## Nur Docker

```bash
docker build -t immich-person-review .
docker run -d --name immich-person-review \
  -p 3030:3000 \
  -e IMMICH_URL=https://photos.example.com \
  -e IMMICH_API_PREFIX=/api \
  -e IMMICH_API_KEY='DEIN_KEY' \
  immich-person-review
```

## Architektur

Browser -> Review-Container -> Immich REST API

Der Browser kennt den Immich API-Key nicht. Bilder werden ebenfalls über den Review-Container gestreamt, damit kein API-Key als Query-Parameter im Browser auftaucht.

## Hinweise

- Es werden keine Immich-internen Timeline-Endpunkte verwendet.
- Die Asset-Liste wird über `POST /search/metadata` mit `personIds` geladen.
- Gesichter werden per `GET /faces?id=<asset-id>` geladen.
- Die Korrektur folgt dem aktuellen Immich-Endpunkt `PUT /faces/{personId}` mit `{ id: faceId }`: die Zielperson steht im Pfad, das umzuhängende Face im Body.
- Bei sehr großen Personen-Clustern werden die Assets serverseitig seitenweise geladen; Face-Daten werden nur in der Nähe des Viewports geladen.
- „Markierung entfernen“ löscht das Face-Objekt über die offizielle Immich-API. Die aktuelle stabile API bietet keinen separaten Endpunkt, um nur `personId` auf `null` zu setzen.
- Der „vor Geburt“-Batch nutzt `takenBefore` in `POST /search/metadata`, sammelt zuerst alle Assets und beginnt erst danach mit dem Löschen. Dadurch verschiebt die laufende Mutation nicht die Such-Pagination.
