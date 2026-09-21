const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (value) => String(value || '').split('/').map((part) => part.trim()).filter(Boolean).join('/');
const parentPath = (value) => norm(value).split('/').slice(0, -1).join('/');
const leafName = (value) => norm(value).split('/').at(-1) || '';
const slug = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'tag';

export function createTagManager({ api, toast }) {
  const state = { document: null, sourcePath: '', selected: null, search: '', dirty: false };
  const $ = (s) => document.querySelector(s);

  function folders() {
    const explicit = Array.isArray(state.document?.folders) ? state.document.folders.map((f) => norm(typeof f === 'string' ? f : f.path)).filter(Boolean) : [];
    const derived = [];
    for (const concept of state.document?.concepts || []) {
      const parts = norm(concept.tag).split('/');
      for (let i = 1; i < parts.length; i++) derived.push(parts.slice(0, i).join('/'));
    }
    return [...new Set([...explicit, ...derived])].sort((a, b) => a.localeCompare(b, 'de'));
  }

  function storeFolders(paths) {
    state.document.folders = [...new Set(paths.map(norm).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  }

  function concepts() { return state.document?.concepts || []; }
  function getConcept(id) { return concepts().find((item) => item.id === id); }
  function selectionPath() {
    if (!state.selected) return '';
    return state.selected.type === 'folder' ? state.selected.path : norm(getConcept(state.selected.id)?.tag);
  }

  function uniqueId(base) {
    const used = new Set(concepts().map((item) => item.id));
    let id = slug(base); let i = 2;
    while (used.has(id)) id = `${slug(base)}_${i++}`;
    return id;
  }

  function uniqueTagPath(base) {
    const used = new Set(concepts().map((item) => norm(item.tag).toLocaleLowerCase('de')));
    let candidate = norm(base); let i = 2;
    while (used.has(candidate.toLocaleLowerCase('de'))) candidate = `${norm(base)} ${i++}`;
    return candidate;
  }

  function uniqueFolderPath(base) {
    const used = new Set(folders().map((item) => norm(item).toLocaleLowerCase('de')));
    let candidate = norm(base); let i = 2;
    while (used.has(candidate.toLocaleLowerCase('de'))) candidate = `${norm(base)} ${i++}`;
    return candidate;
  }

  function markDirty() {
    state.dirty = true;
    $('#tagSaveBtn').disabled = false;
    $('#tagDirtyState').textContent = 'Ungespeicherte Änderungen';
    $('#tagDirtyState').classList.add('dirty');
    renderStats();
  }

  function buildTree() {
    const root = { name: '', path: '', folders: new Map(), tags: [] };
    const ensureFolder = (folderPath) => {
      let node = root; let current = '';
      for (const part of norm(folderPath).split('/').filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: current, folders: new Map(), tags: [] });
        node = node.folders.get(part);
      }
      return node;
    };
    for (const folder of folders()) ensureFolder(folder);
    for (const concept of concepts()) ensureFolder(parentPath(concept.tag)).tags.push(concept);
    return root;
  }

  function nodeMatches(path, name, isTag = false, concept = null) {
    const q = state.search.trim().toLocaleLowerCase('de');
    if (!q) return true;
    const hay = [path, name, isTag ? concept?.label_de : '', isTag ? concept?.label_en : '', isTag ? (concept?.prompts_en || []).join(' ') : ''].join(' ').toLocaleLowerCase('de');
    return hay.includes(q);
  }

  function folderContainsMatch(node) {
    if (!state.search.trim()) return true;
    if (nodeMatches(node.path, node.name)) return true;
    if (node.tags.some((tag) => nodeMatches(tag.tag, leafName(tag.tag), true, tag))) return true;
    return [...node.folders.values()].some(folderContainsMatch);
  }

  function renderNode(node, depth = 0) {
    const entries = [];
    const childFolders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const folder of childFolders) {
      if (!folderContainsMatch(folder)) continue;
      const selected = state.selected?.type === 'folder' && state.selected.path === folder.path;
      const count = concepts().filter((c) => norm(c.tag).startsWith(`${folder.path}/`)).length;
      entries.push(`<div class="tag-tree-row folder ${selected ? 'selected' : ''}" draggable="true" data-folder="${esc(folder.path)}" data-depth="${depth}"><button class="tag-tree-select" type="button" style="--depth:${depth}"><span class="tag-caret">▾</span><span class="tag-node-icon">▱</span><span class="tag-node-label">${esc(folder.name)}</span><span class="tag-count">${count}</span></button></div>`);
      entries.push(renderNode(folder, depth + 1));
    }
    for (const tag of [...node.tags].sort((a, b) => leafName(a.tag).localeCompare(leafName(b.tag), 'de'))) {
      if (!nodeMatches(tag.tag, leafName(tag.tag), true, tag)) continue;
      const selected = state.selected?.type === 'tag' && state.selected.id === tag.id;
      entries.push(`<div class="tag-tree-row tag ${selected ? 'selected' : ''}" draggable="true" data-tag-id="${esc(tag.id)}" data-depth="${depth}"><button class="tag-tree-select" type="button" style="--depth:${depth}"><span class="tag-caret"></span><span class="tag-node-icon">#</span><span class="tag-node-label">${esc(leafName(tag.tag))}</span>${tag.enabled === false ? '<span class="tag-off">aus</span>' : ''}</button></div>`);
    }
    return entries.join('');
  }

  function renderTree() {
    const tree = buildTree();
    $('#tagTree').innerHTML = renderNode(tree) || '<div class="tag-empty-tree">Keine Tags gefunden.</div>';
    $('#tagTree').querySelectorAll('[data-folder]').forEach((row) => {
      row.querySelector('button').onclick = () => { state.selected = { type: 'folder', path: row.dataset.folder }; render(); };
      wireDrag(row, { type: 'folder', path: row.dataset.folder });
    });
    $('#tagTree').querySelectorAll('[data-tag-id]').forEach((row) => {
      row.querySelector('button').onclick = () => { state.selected = { type: 'tag', id: row.dataset.tagId }; render(); };
      wireDrag(row, { type: 'tag', id: row.dataset.tagId });
    });
    $('#tagTree').querySelectorAll('[data-folder]').forEach((row) => {
      row.ondragover = (event) => { event.preventDefault(); row.classList.add('drop-target'); };
      row.ondragleave = () => row.classList.remove('drop-target');
      row.ondrop = (event) => {
        event.preventDefault(); row.classList.remove('drop-target');
        const payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}');
        moveSelection(payload, row.dataset.folder);
      };
    });
  }

  function wireDrag(row, payload) {
    row.ondragstart = (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/json', JSON.stringify(payload));
    };
  }

  function renderStats() {
    if (!state.document) return;
    $('#tagStats').textContent = `${concepts().length} Tags · ${folders().length} Kategorien/Ordner · ${state.document.taxonomy_version || 'ohne Version'}`;
  }

  function renderDetails() {
    const host = $('#tagDetails');
    if (!state.selected) {
      host.innerHTML = '<div class="tag-detail-empty"><strong>Tag oder Kategorie auswählen</strong><p>Links kannst du die Taxonomie durchsuchen, verschieben und bearbeiten.</p></div>';
      return;
    }
    if (state.selected.type === 'folder') {
      const path = state.selected.path;
      const count = concepts().filter((c) => norm(c.tag).startsWith(`${path}/`)).length;
      host.innerHTML = `<div class="tag-detail-head"><div><span class="tag-kind">Kategorie</span><h2>${esc(leafName(path))}</h2><p>${esc(path)} · ${count} Tags im Teilbaum</p></div></div>
        <label>Pfad / Name<input id="folderPathInput" value="${esc(path)}"></label>
        <div class="tag-detail-actions"><button id="folderApplyBtn" class="btn" type="button">Änderung übernehmen</button><button id="folderCopyBtn" class="btn ghost" type="button">Kategorie kopieren</button><button id="folderDeleteBtn" class="btn remove" type="button">Kategorie löschen</button></div>`;
      $('#folderApplyBtn').onclick = () => renameFolder(path, $('#folderPathInput').value);
      $('#folderCopyBtn').onclick = () => copyFolder(path);
      $('#folderDeleteBtn').onclick = () => deleteFolder(path);
      return;
    }
    const concept = getConcept(state.selected.id);
    if (!concept) { state.selected = null; renderDetails(); return; }
    host.innerHTML = `<div class="tag-detail-head"><div><span class="tag-kind">Tag</span><h2>${esc(concept.label_de || leafName(concept.tag))}</h2><p>${esc(concept.id)}</p></div><label class="tag-enabled"><input id="tagEnabledInput" type="checkbox" ${concept.enabled === false ? '' : 'checked'}> aktiv</label></div>
      <div class="tag-form-grid">
        <label>Deutscher Name<input id="tagLabelDeInput" value="${esc(concept.label_de || leafName(concept.tag))}"></label>
        <label>Englisches Label<input id="tagLabelEnInput" value="${esc(concept.label_en || '')}"></label>
      </div>
      <label>Immich-Tag-Pfad<input id="tagPathInput" value="${esc(norm(concept.tag))}"></label>
      <label>Prompt-Aggregation<input id="tagAggregationInput" value="${esc(concept.prompt_aggregation || 'top2_mean')}"></label>
      <label>Threshold<input id="tagThresholdInput" type="number" step="0.001" value="${concept.threshold == null ? '' : esc(concept.threshold)}" placeholder="noch nicht kalibriert"></label>
      <label>Englische SigLIP2-Prompts<textarea id="tagPromptsInput" rows="8">${esc((concept.prompts_en || []).join('\n'))}</textarea><small>Ein Prompt pro Zeile.</small></label>
      <div class="tag-detail-actions"><button id="tagApplyBtn" class="btn" type="button">Änderung übernehmen</button><button id="tagCopyBtn" class="btn ghost" type="button">Tag kopieren</button><button id="tagDeleteBtn" class="btn remove" type="button">Tag löschen</button></div>`;
    $('#tagApplyBtn').onclick = () => applyTagEdit(concept);
    $('#tagCopyBtn').onclick = () => copyTag(concept);
    $('#tagDeleteBtn').onclick = () => deleteTag(concept);
  }

  function render() { renderStats(); renderTree(); renderDetails(); }

  function applyTagEdit(concept) {
    const nextTag = norm($('#tagPathInput').value);
    const duplicate = concepts().find((item) => item.id !== concept.id && norm(item.tag).toLocaleLowerCase('de') === nextTag.toLocaleLowerCase('de'));
    if (!nextTag) return toast('Tag-Pfad darf nicht leer sein.');
    if (duplicate) return toast('Dieser Tag-Pfad existiert bereits.');
    concept.tag = nextTag;
    concept.parent = parentPath(nextTag);
    concept.label_de = $('#tagLabelDeInput').value.trim() || leafName(nextTag);
    concept.label_en = $('#tagLabelEnInput').value.trim();
    concept.enabled = $('#tagEnabledInput').checked;
    concept.prompt_aggregation = $('#tagAggregationInput').value.trim() || 'top2_mean';
    const threshold = $('#tagThresholdInput').value.trim();
    concept.threshold = threshold === '' ? null : Number(threshold);
    concept.prompts_en = $('#tagPromptsInput').value.split('\n').map((x) => x.trim()).filter(Boolean);
    markDirty(); render(); toast('Tag geändert – noch nicht gespeichert');
  }

  function addTag() {
    const baseFolder = state.selected?.type === 'folder' ? state.selected.path : parentPath(selectionPath()) || 'KI';
    const name = window.prompt('Name des neuen deutschen Tags:', 'Neuer Tag');
    if (!name?.trim()) return;
    const tagPath = uniqueTagPath(`${baseFolder}/${name.trim()}`);
    const id = uniqueId(name);
    const concept = { id, tag: tagPath, label_de: name.trim(), label_en: '', category: slug(leafName(baseFolder)), parent: baseFolder, prompts_en: [], prompt_aggregation: 'top2_mean', threshold: null, enabled: true };
    concepts().push(concept); state.selected = { type: 'tag', id }; markDirty(); render();
  }

  function addFolder() {
    const base = state.selected?.type === 'folder' ? state.selected.path : parentPath(selectionPath()) || 'KI';
    const name = window.prompt('Name der neuen Kategorie:', 'Neue Kategorie');
    if (!name?.trim()) return;
    const next = norm(`${base}/${name.trim()}`);
    if (folders().some((p) => p.toLocaleLowerCase('de') === next.toLocaleLowerCase('de'))) return toast('Kategorie existiert bereits.');
    storeFolders([...folders(), next]); state.selected = { type: 'folder', path: next }; markDirty(); render();
  }

  function renameFolder(oldPath, input) {
    const next = norm(input);
    if (!next || next === oldPath) return;
    if (next.startsWith(`${oldPath}/`)) return toast('Eine Kategorie kann nicht in sich selbst verschoben werden.');
    const collision = folders().some((p) => p !== oldPath && !p.startsWith(`${oldPath}/`) && (p === next || p.startsWith(`${next}/`)));
    if (collision) return toast('Am Ziel existiert bereits eine gleichnamige Kategorie.');
    const oldFolders = folders();
    storeFolders(oldFolders.map((p) => p === oldPath || p.startsWith(`${oldPath}/`) ? `${next}${p.slice(oldPath.length)}` : p));
    for (const concept of concepts()) if (norm(concept.tag).startsWith(`${oldPath}/`)) { concept.tag = `${next}${norm(concept.tag).slice(oldPath.length)}`; concept.parent = parentPath(concept.tag); }
    state.selected = { type: 'folder', path: next }; markDirty(); render();
  }

  function copyTag(concept, targetFolder = parentPath(concept.tag)) {
    const copy = structuredClone(concept);
    copy.id = uniqueId(`${concept.id}_copy`);
    copy.tag = uniqueTagPath(`${targetFolder}/${leafName(concept.tag)} Kopie`);
    copy.label_de = `${concept.label_de || leafName(concept.tag)} Kopie`;
    copy.parent = parentPath(copy.tag);
    concepts().push(copy); state.selected = { type: 'tag', id: copy.id }; markDirty(); render();
  }

  function copyFolder(path) {
    const target = uniqueFolderPath(`${parentPath(path)}/${leafName(path)} Kopie`);
    const newFolders = folders().filter((p) => p === path || p.startsWith(`${path}/`)).map((p) => `${target}${p.slice(path.length)}`);
    storeFolders([...folders(), target, ...newFolders]);
    const originals = concepts().filter((c) => norm(c.tag).startsWith(`${path}/`));
    for (const original of originals) {
      const copy = structuredClone(original);
      copy.id = uniqueId(`${original.id}_copy`);
      copy.tag = uniqueTagPath(`${target}${norm(original.tag).slice(path.length)}`);
      copy.parent = parentPath(copy.tag);
      concepts().push(copy);
    }
    state.selected = { type: 'folder', path: target }; markDirty(); render();
  }

  function deleteTag(concept) {
    if (!window.confirm(`Tag „${concept.label_de || leafName(concept.tag)}“ löschen?`)) return;
    state.document.concepts = concepts().filter((item) => item.id !== concept.id); state.selected = null; markDirty(); render();
  }

  function deleteFolder(path) {
    const affected = concepts().filter((c) => norm(c.tag).startsWith(`${path}/`));
    if (!window.confirm(`Kategorie „${path}“ inklusive ${affected.length} Tags löschen?`)) return;
    state.document.concepts = concepts().filter((c) => !norm(c.tag).startsWith(`${path}/`));
    storeFolders(folders().filter((p) => p !== path && !p.startsWith(`${path}/`)));
    state.selected = null; markDirty(); render();
  }

  function moveSelection(payload, targetFolder) {
    if (!payload?.type || !targetFolder) return;
    if (payload.type === 'tag') {
      const concept = getConcept(payload.id); if (!concept) return;
      concept.tag = uniqueTagPath(`${targetFolder}/${leafName(concept.tag)}`); concept.parent = targetFolder;
      state.selected = { type: 'tag', id: concept.id }; markDirty(); render(); toast('Tag verschoben – noch nicht gespeichert');
      return;
    }
    if (payload.type === 'folder') {
      if (targetFolder === payload.path || targetFolder.startsWith(`${payload.path}/`)) return toast('Kategorie kann nicht in sich selbst verschoben werden.');
      renameFolder(payload.path, `${targetFolder}/${leafName(payload.path)}`);
    }
  }

  async function save() {
    try {
      const result = await api('/review-api/tags', { method: 'PUT', body: JSON.stringify({ document: state.document }) });
      state.document = result.document; state.dirty = false; $('#tagSaveBtn').disabled = true; $('#tagDirtyState').textContent = 'Gespeichert'; $('#tagDirtyState').classList.remove('dirty'); render(); toast('Tag-Taxonomie gespeichert');
    } catch (error) { toast(error.message); }
  }

  async function load({ force = false } = {}) {
    if (state.document && !force) return render();
    $('#tagTree').innerHTML = '<div class="loading">Tag-Taxonomie wird geladen…</div>';
    const result = await api('/review-api/tags');
    state.document = result.document; state.sourcePath = result.path || ''; state.dirty = false; state.selected = null;
    $('#tagSourcePath').textContent = state.sourcePath;
    $('#tagSaveBtn').disabled = true; $('#tagDirtyState').textContent = 'Gespeichert'; $('#tagDirtyState').classList.remove('dirty'); render();
  }

  function init() {
    $('#tagSearch').addEventListener('input', (event) => { state.search = event.target.value; renderTree(); });
    $('#tagAddBtn').onclick = addTag;
    $('#tagAddFolderBtn').onclick = addFolder;
    $('#tagSaveBtn').onclick = save;
    $('#tagReloadBtn').onclick = async () => {
      if (state.dirty && !window.confirm('Ungespeicherte Änderungen verwerfen und JSON neu laden?')) return;
      await load({ force: true });
    };
  }

  return { init, load };
}
