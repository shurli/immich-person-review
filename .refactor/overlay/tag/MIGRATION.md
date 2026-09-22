# Bestehende Tag-Taxonomie uebernehmen

Die Repository-Datei `data/tags.json` ist nur die Ausgangstaxonomie. Deine Aenderungen
liegen seit Person Review 0.12.2 normalerweise unter `/app/storage/tags.json` in einem
Docker-Volume. Dieses Volume nicht loeschen. Insbesondere **kein `docker compose down -v`**.
Die Trennung aendert weder Immich-Personen noch Gesichter noch vorhandene Immich-Tags.

## Bestehendes Volume weiterverwenden

1. Im alten Editor **JSON speichern**. Danach fuer die Uebergabe nicht mehr bearbeiten.
2. Sicherung und tatsaechlichen Volume-Namen ermitteln, bevor der alte Container ersetzt wird:

```sh
docker cp immich-person-review:/app/storage/tags.json ./tags-before-split.json
docker inspect immich-person-review --format '{{json .Mounts}}'
```

Bei einem abweichenden `TAG_TAXONOMY_PATH` den tatsaechlichen Pfad sichern. Der Volume-Name
ist haeufig `immich-person-review_tag-taxonomy`, kann aber durch den Compose-Projektnamen
anders lauten. Ausschliesslich den angezeigten Namen verwenden.

3. Die neue reine Personen-Version bereitstellen. Sie mountet oder veraendert die
Taxonomie nicht mehr. Der alte Tag-Editor muss beendet sein, bevor der neue schreibt.
4. In `.env` von Immich Tag Manager `TAG_TAXONOMY_VOLUME` auf den ermittelten Namen setzen.
5. Mit dem expliziten Existing-Volume-Override starten:

```sh
docker compose -f docker-compose.yml -f docker-compose.existing-taxonomy.yml up -d --build
```

Das Override verlangt ein bereits vorhandenes Volume. Ein falscher Name erzeugt damit
kein unbemerktes leeres Volume. Die bestehende `tags.json` wird niemals durch Defaults
ersetzt. UID 1000 muss im Volume lesen und schreiben koennen. Die gleiche Dateistruktur
und `.bak` bleiben erhalten. Bei spaeteren Compose-Befehlen beide `-f`-Optionen verwenden.

## Alte Bind-Mounts oder Versionen vor 0.12.2

Eine alte Konfiguration kann die bearbeitete Datei unter `/app/data/tags.json` oder an
einem individuellen Pfad speichern. In diesem Fall zuerst genau diese Datei sichern.
In einem eigenen Compose-Override das bisherige Verzeichnis nach `/app/storage` mounten,
oder die Sicherung bei gestopptem Tag-Manager als `tags.json` in dessen Volume kopieren.
Die Dateirechte muessen zum Containerbenutzer `node` (UID 1000) passen.

## Kontrolle und Rueckkehr

Im neuen Editor Tag-Anzahl, eigene Kategorien und kalibrierte Thresholds pruefen. Erst
nach dieser Kontrolle wieder bearbeiten. Die Apps niemals gleichzeitig auf dieselbe
Taxonomie schreiben lassen. Fuer eine Rueckkehr den Tag-Manager stoppen und die gesicherte
Datei mit der bisherigen Person-Review-Version verwenden. Kein Datenformatwechsel ist
fuer diese Trennung erforderlich.

## Bekannter doppelter Diagramm-Pfad

In der mitgelieferten alten Taxonomie teilen sich die Konzepte `diagram` und `chart`
den Pfad `KI/Medientypen/Diagramm`. Die bisherige strikte Validierung blockiert dadurch
sogar das Laden. Der neue Editor korrigiert genau dieses bekannte Paar beim Einlesen:
`chart` erhaelt einen freien Pfad `KI/Medientypen/Schaubild` (bei Kollision mit Nummer).
Alle 350 Konzept-IDs, Prompts und Thresholds bleiben erhalten. Die Korrektur wird als
ungespeicherte Aenderung angezeigt und erst mit **JSON speichern** geschrieben; vorher
wird die urspruengliche Datei unveraendert als `.bak` gesichert. Andere doppelte Pfade
werden weiterhin als Fehler gemeldet. Die Trennung schreibt keine Tags nach Immich.
