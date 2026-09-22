import { repairLegacyTaxonomy } from './legacy-taxonomy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaxonomyStore, validateTagTaxonomy } from './taxonomy-store.mjs';

const doc = () => ({ target_model: 'test-model', folders: ['KI'], concepts: [{ id: 'dog', tag: 'KI/Tiere/Hund', prompts_en: ['dog'], threshold: 0.42 }] });
function fixture(t, existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defaults = path.join(dir, 'defaults.json');
  const file = path.join(dir, 'storage/tags.json');
  fs.writeFileSync(defaults, JSON.stringify(doc()));
  if (existing) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(existing)); }
  return { store: createTaxonomyStore(file, defaults), file, defaults };
}
test('first load copies defaults and keeps model, paths and thresholds', (t) => {
  const { store, file, defaults } = fixture(t);
  assert.deepEqual(store.read(), doc());
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(defaults, 'utf8'));
});
test('existing custom taxonomy is never replaced by shipped defaults', (t) => {
  const custom = doc(); custom.concepts[0].threshold = 0.81; custom.custom_metadata = { keep: true };
  const { store } = fixture(t, custom);
  assert.deepEqual(store.read(), custom);
});
test('save retains previous file as backup and updates count and timestamp', (t) => {
  const { store, file } = fixture(t);
  const next = store.read(); next.concepts[0].threshold = 0.61;
  store.write(next);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), doc());
  assert.equal(store.read().concept_count, 1);
  assert.equal(store.read().concepts[0].threshold, 0.61);
  assert.ok(store.read().updated_at);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['tags.json', 'tags.json.bak']);
});
test('invalid save cannot replace existing taxonomy or produce a backup', (t) => {
  const { store, file } = fixture(t, doc());
  const bad = doc(); bad.concepts.push({ ...bad.concepts[0] });
  assert.throws(() => store.write(bad), /Doppelte/);
  assert.deepEqual(store.read(), doc());
  assert.equal(fs.existsSync(`${file}.bak`), false);
});
test('invalid structure, case-insensitive paths and duplicate folders are rejected', () => {
  for (const bad of [null, [], {}, { concepts: [null] }, { concepts: [{ id: 'a', tag: '' }] }, { concepts: [{ id: 'a', tag: 'KI/a', prompts_en: 'bad' }] }, { concepts: [{ id: 'a', tag: 'KI / Hund' }, { id: 'b', tag: 'ki/HUND' }] }, { concepts: [], folders: ['KI', 'ki'] }]) assert.throws(() => validateTagTaxonomy(bad));
});
test('bundled taxonomy includes all 350 concepts and the source model', () => {
  const bundled = JSON.parse(fs.readFileSync(new URL('./data/tags.json', import.meta.url), 'utf8'));
  assert.equal(bundled.concepts.length, 350);
  assert.equal(bundled.target_model, 'ViT-SO400M-16-SigLIP2-384__webli');
  assert.equal(repairLegacyTaxonomy(bundled).length, 1);
  assert.equal(validateTagTaxonomy(bundled), true);
});
test('legacy duplicate repair keeps all IDs and prompts and only persists with backup on save', (t) => {
  const legacy = JSON.parse(fs.readFileSync(new URL('./data/tags.json', import.meta.url), 'utf8'));
  const { store, file } = fixture(t, legacy);
  const repaired = store.read();
  assert.equal(repaired.concepts.length, legacy.concepts.length);
  assert.deepEqual(repaired.concepts.map(({ id, prompts_en }) => ({ id, prompts_en })), legacy.concepts.map(({ id, prompts_en }) => ({ id, prompts_en })));
  assert.equal(store.warnings().length, 1);
  assert.equal(repaired.concepts.find((item) => item.id === 'chart').tag, 'KI/Medientypen/Schaubild');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
  store.write(repaired);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), legacy);
  assert.equal(store.read().concepts.find((item) => item.id === 'chart').tag, 'KI/Medientypen/Schaubild');
  assert.equal(store.warnings().length, 0);
});
