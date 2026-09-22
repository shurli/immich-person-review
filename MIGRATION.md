# Auslagerung der Tag-Verwaltung

Ab 0.13.0 enthaelt Immich Person Review nur noch Personen- und Gesichtsfunktionen.
Der eigenstaendige `shurli/immich-tag-manager` uebernimmt die komplette Tag-Taxonomie
inklusive Prompts, Thresholds, Kategorien und SigLIP2-Preview. Port 3030 bleibt fuer
Person Review; der Tag Manager verwendet standardmaessig Port 3031.

## Vor dem Ersetzen des bisherigen Containers

Zuerst im alten Tag-Editor speichern und die bestehende Datei sichern:

```sh
docker cp immich-person-review:/app/storage/tags.json ./tags-before-split.json
docker inspect immich-person-review --format '{{json .Mounts}}'
```

Bei einem individuellen `TAG_TAXONOMY_PATH` genau diesen Pfad sichern. Vor Version
0.12.2 kann die Datei unter `/app/data/tags.json` liegen. Die bearbeitete Datei steckt
normalerweise in einem Compose-Volume, nicht im Repository. **Kein `down -v` ausfuehren.**

Die neue Personen-Version mountet und veraendert keine Taxonomie. Fuer die Uebernahme
im Tag-Manager dessen `.env` mit `TAG_TAXONOMY_VOLUME` auf den tatsaechlich ermittelten
alten Volume-Namen setzen und dort starten:

```sh
docker compose -f docker-compose.yml -f docker-compose.existing-taxonomy.yml up -d --build
```

Dieses Override verlangt ein vorhandenes Volume und verhindert, dass ein Tippfehler
unbemerkt ein leeres Volume erzeugt. Der alte und neue Editor duerfen nicht gleichzeitig
auf die Datei schreiben. Datei und Verzeichnis muessen fuer UID 1000 schreibbar sein.
Weitere Varianten und Rollback stehen in `MIGRATION.md` des Tag-Manager-Repositories.

Die alten Tag-/ML-Variablen werden von Person Review nicht mehr verwendet und koennen
aus seiner `.env` entfernt werden. Die bestehenden Personen-/Face-API-Rechte und die
SELECT-Rechte auf `asset`, `asset_face`, `face_search` bleiben unveraendert erforderlich.

## Bekannter Altfehler

Die bisherige Standard-Taxonomie enthaelt fuer `diagram` und `chart` denselben Pfad
`KI/Medientypen/Diagramm`. Der Tag-Manager korrigiert genau dieses Paar beim Einlesen:
`chart` erhaelt einen freien `KI/Medientypen/Schaubild`-Pfad. Alle Konzept-IDs und Prompts
bleiben erhalten. Die Korrektur wird angezeigt und erst mit JSON speichern samt Backup
persistiert. Die Auslagerung schreibt weder Personen-/Gesichtsdaten noch Tags in Immich.
