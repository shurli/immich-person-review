"""One-time extraction from the pinned original; neither final app depends on this script."""
from pathlib import Path
import argparse
import json
import re
import shutil

ROOT = Path(__file__).resolve().parent

def once(text, old, new):
    assert text.count(old) == 1, f'Expected exactly one occurrence: {old[:100]!r}'
    return text.replace(old, new, 1)

def between(text, start, end):
    assert text.count(start) == 1 and text.count(end) == 1, (start, end)
    a, b = text.index(start), text.index(end)
    assert a < b
    return text[a:b]

def put(root, name, text):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')

def build(src, people, tags):
    people.mkdir(parents=True, exist_ok=True)
    tags.mkdir(parents=True, exist_ok=True)
    server = (src / 'server.mjs').read_text()
    app = (src / 'public/app.js').read_text()
    html = (src / 'public/index.html').read_text()
    css = (src / 'public/styles.css').read_text()
    taxonomy = between(server, 'function normalizeTagPath(value)', 'async function encodeTagPrompt(')
    preview = between(server, 'async function encodeTagPrompt(', 'async function proxyJson(')
    tag_routes = between(server, '    const tagCalibrationMatch =', "    if (req.method === 'POST' && url.pathname === '/review-api/maintenance/duplicate-person-faces/scan')")
    tag_html = between(html, '      <div id="tagChooser"', '    </section>\n\n    <section id="review"')
    tag_css = css[css.index('/* KI-Tag-Verwaltung */'):]
    for line in server.splitlines(keepends=True):
        if any(token in line for token in ("from './tag-calibration.mjs'", 'const tagTaxonomy', 'const immichMachineLearningUrl', 'const tagTextEmbeddingCache')):
            server = once(server, line, '')
    for block in (taxonomy, preview, tag_routes):
        server = once(server, block, '')
    for line in app.splitlines(keepends=True):
        if any(token in line for token in ('createTagManager', 'let tagManager;', 'tagManager.init();', "$('#tagsTab')", "$('#tagChooser')", 'if (tags) tagManager', "const tags = view === 'tags'")):
            app = once(app, line, '')
    app = once(app, 'const review = !unnamed && !tags;', 'const review = !unnamed;')
    html = once(html, '        <button id="tagsTab" class="view-tab" type="button">KI-Tags</button>\n', '')
    html = once(html, tag_html, '')
    css = once(css, tag_css, '')
    for name, text in [('server.mjs', server), ('public/app.js', app), ('public/index.html', html), ('public/styles.css', css)]:
        put(people, name, text)
    for pattern in ('cluster*.mjs', 'public/cluster*.js'):
        for file in src.glob(pattern):
            put(people, str(file.relative_to(src)), file.read_text())
    put(people, 'docker-compose.immich-network.yml', (src / 'docker-compose.immich-network.yml').read_text())
    readme = (src / 'README.md').read_text().split('## KI-Tag-Taxonomie verwalten')[0].rstrip() + '\n'
    readme = readme.replace('## Version 0.10.0', '## Version 0.13.0\n\nDie Tag-Verwaltung wurde in das eigenstaendige Repository `shurli/immich-tag-manager` ausgelagert. Alle Personen- und Gesichtsfunktionen bleiben erhalten. Hinweise zur Uebernahme der bisherigen Tag-Datei stehen in `MIGRATION.md`.\n\n### Bisheriger Personen-Funktionsumfang')
    put(people, 'README.md', readme.replace('immich-person-review:0.10.0', 'immich-person-review:0.13.0'))

    tag_ui = (src / 'public/tags.js').read_text().replace('/review-api/', '/tag-api/')
    tag_ui = once(tag_ui, '      await load({ force: true });', '      try { await load({ force: true }); } catch (error) { toast(error.message); }')
    tag_ui = once(tag_ui, '  function init() {', "  function init() {\n    window.addEventListener('beforeunload', (event) => {\n      if (state.dirty) { event.preventDefault(); event.returnValue = ''; }\n    });")
    tag_ui = once(tag_ui, '      renderCalibrationResults(concept);\n    } catch (error) {', "      if (state.selected?.type === 'tag' && state.selected.id === concept.id) renderCalibrationResults(concept);\n    } catch (error) {")
    tag_ui = once(tag_ui, "      $('#tagCalibrationMeta').textContent = error.message;\n      $('#tagCalibrationGrid').innerHTML = '';", "      if (state.selected?.type === 'tag' && state.selected.id === concept.id) {\n        if ($('#tagCalibrationMeta')) $('#tagCalibrationMeta').textContent = error.message;\n        if ($('#tagCalibrationGrid')) $('#tagCalibrationGrid').innerHTML = '';\n      }")
    tag_ui = once(tag_ui, "$('#tagDirtyState').classList.remove('dirty'); render();\n  }", "$('#tagDirtyState').classList.remove('dirty'); render();\n    if (result.warnings?.length) { markDirty(); toast(result.warnings.join(' ')); }\n  }")
    put(tags, 'public/tags.js', tag_ui)
    put(tags, 'public/styles.css', (ROOT / 'overlay/tag/base.css').read_text() + '\n' + tag_css)
    shell = (ROOT / 'overlay/tag/index.html').read_text()
    put(tags, 'public/index.html', shell.replace('<!-- TAG_EDITOR -->', tag_html.replace('class="hidden tag-manager"', 'class="tag-manager"')))
    (tags / 'data').mkdir(exist_ok=True)
    shutil.copyfile(src / 'data/tags.json', tags / 'data/tags.json')
    for name in ('tag-calibration.mjs', 'tag-calibration.test.mjs'):
        put(tags, name, (src / name).read_text())
    taxonomy = taxonomy.replace('function normalizeTagPath(', 'export function normalizeTagPath(', 1).replace('function validateTagTaxonomy(', 'export function validateTagTaxonomy(', 1)
    exported = between(taxonomy, 'export function normalizeTagPath(', 'function ensureTagTaxonomyFile(')
    store_funcs = taxonomy[taxonomy.index('function ensureTagTaxonomyFile('):]
    store_funcs = once(store_funcs, '  validateTagTaxonomy(document);\n  return document;', '  legacyWarnings = repairLegacyTaxonomy(document);\n  validateTagTaxonomy(document);\n  return document;')
    header = "import { repairLegacyTaxonomy } from './legacy-taxonomy.mjs';\nimport fs from 'node:fs';\nimport path from 'node:path';\n\n" + exported
    header += '\nexport function createTaxonomyStore(tagTaxonomyPath, tagTaxonomyDefaultPath) {\n  const tagTaxonomyBackupPath = `${tagTaxonomyPath}.bak`;\n  let legacyWarnings = [];\n'
    put(tags, 'taxonomy-store.mjs', header + store_funcs + '\n  return { read: readTagTaxonomy, write: writeTagTaxonomy, warnings: () => [...legacyWarnings] };\n}\n')
    preview = preview.replace('requireVectorDatabase()', 'getPool()')
    preview = once(preview, '  const pool = getPool();', '  const pool = getPool();\n  const ownerId = await getOwnerId();')
    preview = once(preview, '        WHERE a."deletedAt" IS NULL\n', '        WHERE a."deletedAt" IS NULL\n          AND a."ownerId" = $3::uuid\n          AND a.visibility IN (\'timeline\', \'archive\')\n')
    preview = once(preview, '[vectorText, limit],', '[vectorText, limit, ownerId],')
    preview = once(preview, 'Math.min(250, Number(candidatePerPrompt) || 80)', 'Math.min(250, Math.floor(Number(candidatePerPrompt)) || 80)')
    preview = once(preview, 'Math.min(120, Number(sampleSize) || 48)', 'Math.min(120, Math.floor(Number(sampleSize)) || 48)')
    preview = once(preview, '  tagTextEmbeddingCache.set(key, embedding);', '  if (tagTextEmbeddingCache.size >= 512) tagTextEmbeddingCache.delete(tagTextEmbeddingCache.keys().next().value);\n  tagTextEmbeddingCache.set(key, embedding);')
    header = "import { parseVector, cosineSimilarity, aggregatePromptScores } from './tag-calibration.mjs';\n\nexport function createTagPreview({ getPool, getOwnerId, readTagTaxonomy, immichMachineLearningUrl, fetch = globalThis.fetch }) {\n  const tagTextEmbeddingCache = new Map();\n"
    put(tags, 'tag-preview.mjs', header + preview + '\n  return getTagCalibrationPreview;\n}\n')
    for kind, out, name, version in [('person', people, 'immich-person-review', '0.13.0'), ('tag', tags, 'immich-tag-manager', '0.1.0')]:
        package = json.loads((src / 'package.json').read_text())
        package.update(name=name, version=version)
        package['scripts']['check'] = 'node --check server.mjs && node --check public/app.js'
        put(out, 'package.json', json.dumps(package, indent=2) + '\n')
        for file in (ROOT / 'overlay' / kind).rglob('*'):
            if file.is_file() and file.name not in ('base.css', 'index.html'):
                put(out, str(file.relative_to(ROOT / 'overlay' / kind)), file.read_text())
        lock = json.loads((ROOT / 'package-lock.json').read_text())
        lock.update(name=name, version=version)
        lock['packages'][''].update(name=name, version=version)
        put(out, 'package-lock.json', json.dumps(lock, indent=2) + '\n')
    assert not re.search(r'tagTaxonomy|tagManager|tagsTab|tagChooser|tag-calibration|smart_search|MACHINE_LEARNING', server + app + html + css)
    assert (src / 'data/tags.json').read_bytes() == (tags / 'data/tags.json').read_bytes()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--person-out', type=Path, required=True)
    parser.add_argument('--tag-out', type=Path, required=True)
    args = parser.parse_args()
    build(args.source, args.person_out, args.tag_out)
