// Repair only the known duplicate in the bundled legacy taxonomy. IDs and prompts stay intact.
export function repairLegacyTaxonomy(document) {
  const concepts = document?.concepts;
  if (!Array.isArray(concepts)) return [];
  const diagram = concepts.find((concept) => concept?.id === 'diagram');
  const chart = concepts.find((concept) => concept?.id === 'chart');
  if (diagram?.tag !== 'KI/Medientypen/Diagramm' || chart?.tag !== diagram.tag) return [];
  const used = new Set(concepts.map((concept) => String(concept?.tag || '').toLocaleLowerCase('de')));
  let tag = 'KI/Medientypen/Schaubild';
  for (let n = 2; used.has(tag.toLocaleLowerCase('de')); n++) tag = `KI/Medientypen/Schaubild ${n}`;
  chart.tag = tag;
  if (chart.label_de === 'Diagramm') chart.label_de = 'Schaubild';
  return [`Der alte doppelte Diagramm-Pfad wurde fuer das Konzept chart zu ${tag} korrigiert. JSON speichern, um die Korrektur mit Backup zu uebernehmen.`];
}
