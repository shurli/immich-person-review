import {
  clusterCenterVector,
  describeClusterCenter,
  distanceToClusterCenter,
  projectPointAroundClusterCenter,
} from './cluster-center-math.js';
import {
  filterAndSortClusterPoints,
  isClusterListMode,
} from './cluster-list-mode.js';

const $ = (s) => document.querySelector(s);
const PAGE_SIZE = 40;

const state = {
  person: null,
  assets: [],
  reviewed: new Set(),
  activeFace: null,
  activeCard: null,
  people: [],
  nextPage: null,
  total: null,
  loadingAssets: false,
  requestToken: 0,
  unnamed: [],
  mergeSource: null,
  immichUrl: '',
  duplicateFaceScanId: null,
  vectorDatabase: { configured: false },
  activePersonView: 'timeline',
  cluster: null,
  clusterRadius: 0,
  clusterSelected: new Set(),
  clusterVisibleCount: 80,
  clusterListMode: 'outside',
  clusterLoadedFor: null,
  clusterLoading: false,
  clusterPlotPoints: [],
  clusterNeighborPlotPoints: [],
  clusterPlotGeometry: null,
  clusterPointView: new Map(),
  clusterNeighborView: new Map(),
  clusterDynamicStats: null,
  clusterCenter: { x: 0, y: 0 },
  clusterCenterMaxDistance: 0,
  clusterActiveCenterVector: [],
  clusterCenterDragging: false,
  clusterCenterDragPointerId: null,
  clusterCenterDragMoved: false,
  clusterCenterDragFrame: 0,
  clusterCenterDragPending: null,
  clusterCenterDragGeometry: null,
  clusterCenterDragStart: null,
  clusterHoverFaceId: null,
  clusterHoverKey: null,
  clusterImageCache: new Map(),
  clusterNeighborsEnabled: false,
  clusterNeighborCount: 8,
  clusterNeighborMax: 50,
  clusterNeighbors: [],
  clusterNeighborLoadedFor: null,
  clusterNeighborQueryLimit: 0,
  clusterNeighborAvailable: 0,
  clusterNeighborCandidatePool: 0,
  clusterNeighborLoading: false,
  clusterNeighborError: '',
  clusterNeighborRequestToken: 0,
  clusterActiveNeighbor: null,
  timelineStale: false,
};

let faceObserver;
let pageObserver;
let unnamedStatsObserver;
let clusterResizeObserver;

async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = r.status === 204 ? '' : await r.text();
  let data = null;
  if (text) {
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { data = JSON.parse(text); } catch { data = text; }
    } else {
      data = text;
    }
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    if (data && typeof data === 'object') msg = Array.isArray(data.message) ? data.message.join(', ') : data.message || msg;
    else if (typeof data === 'string' && data.trim()) msg = data.trim();
    throw new Error(msg);
  }
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function esc(s = '') {
  return String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

function fmtDate(d) {
  return new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
}

function isBeforeBirth(birth, taken) {
  if (!birth || !taken) return false;
  return new Date(taken) < new Date(`${birth}T00:00:00`);
}

function ageAt(birth, taken) {
  if (!birth) return 'Alter unbekannt';
  const b = new Date(`${birth}T00:00:00`);
  const t = new Date(taken);
  if (isBeforeBirth(birth, taken)) return 'vor Geburt?';
  let y = t.getFullYear() - b.getFullYear();
  let m = t.getMonth() - b.getMonth();
  const day = t.getDate() - b.getDate();
  if (day < 0) m--;
  if (m < 0) { y--; m += 12; }
  if (y < 2) return y === 0 ? `${Math.max(0, m)} Monate` : `${y} Jahr ${m} Monate`;
  return `${y} Jahre`;
}

function thumbPerson(id, bust = '') { return `/review-api/people/${id}/thumbnail${bust ? `?v=${encodeURIComponent(bust)}` : ''}`; }
function thumbAsset(id, size = 'preview') { return `/review-api/assets/${id}/thumbnail?size=${encodeURIComponent(size)}`; }
function immichPersonUrl(id) { return state.immichUrl ? `${state.immichUrl}/people/${encodeURIComponent(id)}` : '#'; }
function immichAssetUrl(id) { return state.immichUrl ? `${state.immichUrl}/photos/${encodeURIComponent(id)}` : '#'; }
function openImmichPerson(id) { if (state.immichUrl) window.open(immichPersonUrl(id), '_blank', 'noopener,noreferrer'); }
function openImmichAsset(id) { if (state.immichUrl) window.open(immichAssetUrl(id), '_blank', 'noopener,noreferrer'); }

async function init() {
  try {
    const s = await api('/review-api/status');
    $('#appVersion').textContent = s.version ? `v${s.version}` : 'v?';
    state.immichUrl = String(s.immichExternalUrl || s.immichUrl || '').replace(/\/$/, '');
    state.vectorDatabase = s.vectorDatabase || { configured: false };
    initializeClusterNeighborPreferences();
    const clusterBadge = $('#clusterDbBadge');
    const databaseReady = state.vectorDatabase.configured
      && state.vectorDatabase.reachable !== false
      && state.vectorDatabase.schemaReady !== false;
    clusterBadge.textContent = !state.vectorDatabase.configured
      ? 'DB fehlt'
      : state.vectorDatabase.reachable === false
        ? 'DB-Fehler'
        : state.vectorDatabase.schemaReady === false
          ? 'DB-Rechte'
          : 'DB bereit';
    clusterBadge.classList.toggle('offline', !databaseReady);
    clusterBadge.title = !state.vectorDatabase.configured
      ? 'Für Vektor-Cluster fehlen die PostgreSQL-Zugangsdaten.'
      : state.vectorDatabase.reachable === false
        ? `PostgreSQL nicht erreichbar: ${state.vectorDatabase.error || 'unbekannter Fehler'}`
        : state.vectorDatabase.schemaReady === false
          ? `Tabellen oder SELECT-Rechte fehlen: ${state.vectorDatabase.schemaError || 'unbekannter Fehler'}`
          : `PostgreSQL erreichbar${state.vectorDatabase.database ? ` · DB ${state.vectorDatabase.database}` : ''}${state.vectorDatabase.user ? ` · Benutzer ${state.vectorDatabase.user}` : ''}`;
    $('#status').textContent = `Verbunden · ${s.keyName}`;
    $('#status').className = 'status ok';
  } catch (e) {
    $('#status').textContent = 'Immich nicht erreichbar';
    $('#status').className = 'status bad';
    $('#people').innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  await loadPeople();
}

async function loadPeople() {
  $('#people').innerHTML = '<div class="loading">Personen werden geladen…</div>';
  try {
    const all = [];
    let page = 1;
    while (page < 100) {
      const d = await api(`/review-api/people?page=${page}&size=250`);
      all.push(...d.people);
      if (!d.hasNextPage) break;
      page++;
    }
    state.people = all.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'));
    renderPeople(state.people);
    if ($('#unnamedTab')?.classList.contains('active')) renderUnnamedPeople();
  } catch (e) {
    $('#people').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function renderPeople(people) {
  $('#people').innerHTML = people.map((p) => `<button class="person-card" data-person="${p.id}"><img class="person-avatar immich-person-link" data-open-immich-person="${p.id}" loading="lazy" src="${thumbPerson(p.id)}" alt="In Immich öffnen" title="In Immich öffnen"><div class="person-name">${esc(p.name || 'Unbenannt')}</div><div class="muted">${p.birthDate ? `geb. ${fmtDate(p.birthDate)}` : 'kein Geburtsdatum'}</div></button>`).join('') || '<div class="muted">Keine Personen.</div>';
  document.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => selectPerson(b.dataset.person); });
  document.querySelectorAll('[data-open-immich-person]').forEach((img) => { img.onclick = (e) => { e.stopPropagation(); openImmichPerson(img.dataset.openImmichPerson); }; });
}

$('#personSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderPeople(!q ? state.people : state.people.filter((p) => (p.name || '').toLowerCase().includes(q)));
});


function setChooserView(view) {
  const unnamed = view === 'unnamed';
  $('#reviewTab').classList.toggle('active', !unnamed);
  $('#unnamedTab').classList.toggle('active', unnamed);
  $('#namedChooser').classList.toggle('hidden', unnamed);
  $('#unnamedChooser').classList.toggle('hidden', !unnamed);
  if (unnamed) renderUnnamedPeople();
}

function initUnnamedObserver() {
  unnamedStatsObserver?.disconnect();
  unnamedStatsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      unnamedStatsObserver.unobserve(entry.target);
      loadUnnamedStats(entry.target);
    }
  }, { rootMargin: '700px 0px' });
}

function renderUnnamedPeople() {
  state.unnamed = state.people.filter((p) => !String(p.name || '').trim() && !p.isHidden);
  $('#unnamedCount').textContent = `${state.unnamed.length} unbenannte Personen`;
  $('#unnamedPeople').innerHTML = state.unnamed.map((p, i) => `<article class="unnamed-card" data-unnamed-person="${p.id}"><img class="immich-person-link" data-unnamed-open-immich="${p.id}" src="${thumbPerson(p.id)}" loading="lazy" alt="Unbenannte Person in Immich öffnen" title="In Immich öffnen"><div class="unnamed-card-body"><div class="unnamed-label">Unbenannte Person ${i + 1}</div><div class="unnamed-stats"><div class="stat-pill"><strong class="face-count">…</strong><span>Faces</span></div><div class="stat-pill"><strong class="day-count">…</strong><span>Aufnahmetage</span></div></div><div class="stats-state muted">Kennzahlen werden geladen…</div><div class="unnamed-actions"><button class="btn hide-person" type="button">Verstecken</button><button class="btn merge-person" type="button">Zusammenführen</button></div><div class="person-id">${esc(p.id)}</div></div></article>`).join('') || '<div class="muted">Keine sichtbaren unbenannten Personen gefunden.</div>';
  initUnnamedObserver();
  document.querySelectorAll('[data-unnamed-person]').forEach((card) => {
    unnamedStatsObserver.observe(card);
    card.querySelector('.hide-person').onclick = () => hideUnnamedPerson(card.dataset.unnamedPerson, card);
    card.querySelector('.merge-person').onclick = () => openMergeDialog(card.dataset.unnamedPerson);
    card.querySelector('[data-unnamed-open-immich]').onclick = () => openImmichPerson(card.dataset.unnamedPerson);
  });
}

async function loadUnnamedStats(card) {
  const id = card.dataset.unnamedPerson;
  try {
    const stats = await api(`/review-api/people/${id}/review-stats`);
    card.querySelector('.face-count').textContent = stats.faces;
    card.querySelector('.day-count').textContent = stats.days;
    card.querySelector('.stats-state').textContent = `${stats.assets} Assets`;
  } catch (e) {
    card.querySelector('.stats-state').innerHTML = `<span class="stats-error">${esc(e.message)}</span>`;
  }
}

async function hideUnnamedPerson(id, card) {
  const button = card.querySelector('.hide-person');
  button.disabled = true;
  button.textContent = 'Verstecke…';
  try {
    await api(`/review-api/people/${id}/hide`, { method: 'PUT', body: '{}' });
    const p = state.people.find((x) => x.id === id);
    if (p) p.isHidden = true;
    card.classList.add('removing');
    setTimeout(() => { card.remove(); renderUnnamedCountOnly(); }, 180);
    toast('Person versteckt');
  } catch (e) {
    button.disabled = false;
    button.textContent = 'Verstecken';
    toast(e.message);
  }
}

function renderUnnamedCountOnly() {
  state.unnamed = state.people.filter((p) => !String(p.name || '').trim() && !p.isHidden);
  $('#unnamedCount').textContent = `${state.unnamed.length} unbenannte Personen`;
}

function openMergeDialog(sourceId) {
  state.mergeSource = sourceId;
  const source = state.people.find((p) => p.id === sourceId);
  $('#mergeInfo').textContent = `Diese ${source?.name || 'unbenannte Person'} wird in die ausgewählte Zielperson zusammengeführt.`;
  $('#mergeTargetSearch').value = '';
  renderMergeTargets(state.people.filter((p) => p.id !== sourceId && !p.isHidden).slice(0, 60));
  $('#mergeDialog').showModal();
}

function renderMergeTargets(people) {
  $('#mergeTargets').innerHTML = people.map((p) => `<button type="button" class="target-item" data-merge-target="${p.id}"><img src="${thumbPerson(p.id)}" loading="lazy" alt=""><div><strong>${esc(p.name || 'Unbenannt')}</strong><div class="muted">${p.birthDate ? fmtDate(p.birthDate) : ''}</div></div></button>`).join('') || '<div class="muted">Keine Zielperson gefunden.</div>';
  document.querySelectorAll('[data-merge-target]').forEach((b) => { b.onclick = () => mergeUnnamedPerson(b.dataset.mergeTarget); });
}

async function mergeUnnamedPerson(targetPersonId) {
  const sourceId = state.mergeSource;
  if (!sourceId) return;
  try {
    await api(`/review-api/people/${sourceId}/merge`, { method: 'POST', body: JSON.stringify({ targetPersonId }) });
    state.people = state.people.filter((p) => p.id !== sourceId);
    $('#mergeDialog').close();
    document.querySelector(`[data-unnamed-person="${sourceId}"]`)?.remove();
    renderUnnamedCountOnly();
    toast('Personen zusammengeführt');
  } catch (e) {
    toast(e.message);
  }
}

async function refreshUnnamedThumbnails() {
  const button = $('#refreshUnnamedThumbsBtn');
  const people = state.people.filter((p) => !String(p.name || '').trim() && !p.isHidden);
  if (!people.length) return toast('Keine unbenannten Personen vorhanden');
  if (!confirm(`Für ${people.length} unbenannte Personen jeweils das Face mit der höchsten Pixelauflösung als Thumbnail setzen?`)) return;

  button.disabled = true;
  const original = button.textContent;
  let done = 0;
  let changed = 0;
  let failed = 0;
  let cursor = 0;
  const updateProgress = () => { button.textContent = `Thumbnails ${done}/${people.length}`; };
  updateProgress();

  const workers = Array.from({ length: Math.min(4, people.length) }, async () => {
    while (cursor < people.length) {
      const person = people[cursor++];
      try {
        await api(`/review-api/people/${person.id}/refresh-thumbnail`, { method: 'POST', body: '{}' });
        changed++;
        const cardImg = document.querySelector(`[data-unnamed-person="${person.id}"] img`);
        if (cardImg) cardImg.src = thumbPerson(person.id, Date.now());
      } catch (e) {
        failed++;
        console.error(`Thumbnail ${person.id}:`, e);
      } finally {
        done++;
        updateProgress();
      }
    }
  });

  await Promise.all(workers);
  button.disabled = false;
  button.textContent = original;
  toast(`Thumbnail-Batch fertig: ${changed} aktualisiert${failed ? `, ${failed} Fehler` : ''}`);
}



async function scanDuplicateFaceBoxes() {
  const button = $('#duplicateFacesBatchBtn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Scanne Personen & Assets…';
  state.duplicateFaceScanId = null;
  try {
    const result = await api('/review-api/maintenance/duplicate-person-faces/scan', { method: 'POST', body: '{}' });
    state.duplicateFaceScanId = result.scanId;
    $('#duplicateFacesSummary').textContent = `${result.peopleScanned} Personen · ${result.assetsScanned} Assets geprüft · ${result.duplicateAssets} Assets mit Mehrfachmarkierung · ${result.facesToRemove} größere Face-Boxen würden entfernt.`;
    $('#duplicateFacesPreview').innerHTML = result.preview.length ? result.preview.map((item) => `<div class="duplicate-preview-row"><div><strong>${esc(item.personName || 'Unbenannt')}</strong><div class="muted">${esc(item.assetName || item.assetId)}</div></div><div class="duplicate-pixels">${item.markedFaces}× markiert · behält ${item.keepPixels.toLocaleString('de-AT')} px · entfernt ${item.removePixels.map((x) => x.toLocaleString('de-AT')).join(', ')} px</div></div>`).join('') : '<div class="muted">Keine doppelten Person-Markierungen gefunden.</div>';
    $('#applyDuplicateFacesBtn').classList.toggle('hidden', result.facesToRemove === 0);
    $('#duplicateFacesDialog').showModal();
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function applyDuplicateFaceBoxes() {
  if (!state.duplicateFaceScanId) return toast('Bitte zuerst erneut scannen');
  const button = $('#applyDuplicateFacesBtn');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Entferne Face-Boxen…';
  try {
    const result = await api('/review-api/maintenance/duplicate-person-faces/apply', {
      method: 'POST',
      body: JSON.stringify({ scanId: state.duplicateFaceScanId }),
    });
    state.duplicateFaceScanId = null;
    $('#duplicateFacesDialog').close();
    toast(`Bereinigung fertig: ${result.removed}/${result.requested} Face-Boxen entfernt${result.failed ? ` · ${result.failed} Fehler` : ''}`);
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('#reviewTab').onclick = () => setChooserView('review');
$('#unnamedTab').onclick = () => setChooserView('unnamed');
$('#refreshUnnamedThumbsBtn').onclick = refreshUnnamedThumbnails;
$('#duplicateFacesBatchBtn').onclick = scanDuplicateFaceBoxes;
$('#applyDuplicateFacesBtn').onclick = applyDuplicateFaceBoxes;
$('#closeDuplicateFacesDialog').onclick = () => $('#duplicateFacesDialog').close();
$('#closeMergeDialog').onclick = () => $('#mergeDialog').close();
$('#mergeTargetSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const pool = state.people.filter((p) => p.id !== state.mergeSource && !p.isHidden);
  renderMergeTargets((!q ? pool : pool.filter((p) => (p.name || '').toLowerCase().includes(q))).slice(0, 80));
});

function resetReviewState() {
  state.assets = [];
  state.reviewed.clear();
  state.nextPage = 1;
  state.total = null;
  state.loadingAssets = false;
  state.requestToken++;
  faceObserver?.disconnect();
  pageObserver?.disconnect();
  $('#timeline').innerHTML = '';
  $('#empty').classList.add('hidden');
  $('#pageStatus').textContent = '';
  $('#loadMoreBtn').classList.add('hidden');
}

async function selectPerson(id) {
  $('#chooser').classList.add('hidden');
  $('#review').classList.remove('hidden');
  resetReviewState();
  resetClusterState();
  state.timelineStale = false;
  setPersonView('timeline', { load: false });
  $('#timeline').innerHTML = '<div class="panel loading initial-loading">Erste Assets werden geladen…</div>';

  try {
    state.person = await api(`/review-api/people/${id}`);
    $('#selectedPersonName').textContent = state.person.name || 'Unbenannt';
    $('#selectedPersonThumb').src = thumbPerson(id);
    $('#selectedPersonThumb').classList.add('immich-person-link');
    $('#selectedPersonThumb').title = 'In Immich öffnen';
    $('#selectedPersonThumb').onclick = () => openImmichPerson(id);
    updatePersonMeta();
    updateBatchButton();
    $('#timeline').innerHTML = '';
    initObservers();
    await loadNextPage();
  } catch (e) {
    $('#timeline').innerHTML = `<div class="panel error">${esc(e.message)}</div>`;
  }
}

function updateBatchButton() {
  const button = $('#batchBeforeBirthBtn');
  const hasBirthDate = Boolean(state.person?.birthDate);
  const show = hasBirthDate && state.activePersonView === 'timeline';
  button.classList.toggle('hidden', !show);
  button.disabled = !hasBirthDate;
  if (!button.dataset.running) button.textContent = 'Alle „vor Geburt“ Zuordnungen lösen';
}

function updatePersonMeta() {
  if (!state.person) return;
  const parts = [state.person.birthDate ? `Geburtsdatum ${fmtDate(state.person.birthDate)}` : 'Kein Geburtsdatum – Alter kann nicht berechnet werden'];
  if (state.total != null) parts.push(`${state.total} Assets`);
  else if (state.assets.length) parts.push(`${state.assets.length}${state.nextPage ? '+' : ''} Assets geladen`);
  $('#selectedPersonMeta').textContent = parts.join(' · ');
}

function initObservers() {
  faceObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      faceObserver.unobserve(card);
      loadFaceForCard(card, card._asset);
    }
  }, { rootMargin: '1200px 0px' });

  pageObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
  }, { rootMargin: '1400px 0px' });

  pageObserver.observe($('#pageSentinel'));
}

async function loadNextPage() {
  if (!state.person || state.loadingAssets || state.nextPage == null) return;
  const token = state.requestToken;
  const page = state.nextPage;
  state.loadingAssets = true;
  $('#pageStatus').textContent = `Seite ${page} wird geladen…`;
  $('#loadMoreBtn').disabled = true;

  try {
    const d = await api(`/review-api/people/${state.person.id}/assets?page=${page}&size=${PAGE_SIZE}`);
    if (token !== state.requestToken) return;

    const newItems = d.items || [];
    state.assets.push(...newItems);
    state.nextPage = d.nextPage;
    if (d.total != null) state.total = d.total;
    appendTimeline(newItems);
    updatePersonMeta();

    if (state.assets.length === 0 && state.nextPage == null) $('#empty').classList.remove('hidden');
    $('#pageStatus').textContent = state.nextPage == null
      ? (state.assets.length ? `Alle ${state.assets.length} Assets geladen` : '')
      : `${state.assets.length}${state.total != null ? ` von ${state.total}` : ''} Assets geladen`;
    $('#loadMoreBtn').classList.toggle('hidden', state.nextPage == null);
  } catch (e) {
    if (token !== state.requestToken) return;
    $('#pageStatus').textContent = `Laden fehlgeschlagen: ${e.message}`;
    $('#loadMoreBtn').classList.remove('hidden');
    toast(e.message);
  } finally {
    if (token === state.requestToken) {
      state.loadingAssets = false;
      $('#loadMoreBtn').disabled = false;
    }
  }
}

function appendTimeline(items) {
  const tl = $('#timeline');
  for (const asset of items) {
    const card = document.createElement('article');
    card.className = 'review-card';
    card.dataset.asset = asset.id;
    card._asset = asset;
    const taken = asset.fileCreatedAt || asset.localDateTime || asset.createdAt;
    const beforeBirth = isBeforeBirth(state.person.birthDate, taken);
    card.dataset.beforeBirth = beforeBirth ? 'true' : 'false';
    card.innerHTML = `<div class="full-wrap"><img class="full-photo immich-asset-link" loading="lazy" src="${thumbAsset(asset.id)}" alt="${esc(asset.originalFileName || 'Asset')}" title="In Immich öffnen"><div class="face-box hidden"></div></div><aside class="side"><canvas class="crop" width="500" height="500"></canvas><div><div class="date">${fmtDate(taken)}</div><div class="age">${ageAt(state.person.birthDate, taken)}</div><div class="muted">${esc(asset.originalFileName || '')}${asset.type ? ` · ${esc(asset.type === 'VIDEO' ? 'Video' : asset.type === 'IMAGE' ? 'Bild' : asset.type)}` : ''}</div></div><div class="face-state muted">Gesicht wird bei Bedarf geladen…</div><div class="actions"><button class="btn warn reassign" disabled>Falsche Zuordnung ändern</button><button class="btn detach detach-face" disabled>Zuordnung lösen</button><button class="btn remove remove-face" disabled>Markierung entfernen</button><span class="badge ok-badge hidden">Korrigiert</span></div></aside>`;
    tl.appendChild(card);
    const fullPhoto = card.querySelector('.full-photo');
    if (state.immichUrl) fullPhoto.addEventListener('click', () => openImmichAsset(asset.id));
    faceObserver.observe(card);
  }
}

async function loadFaceForCard(card, asset) {
  if (card._faceLoaded) return;
  card._faceLoaded = true;
  const faceState = card.querySelector('.face-state');
  faceState.textContent = 'Gesicht wird geladen…';

  try {
    const faces = await api(`/review-api/assets/${asset.id}/faces`);
    const face = faces.find((f) => f.person?.id === state.person.id || f.personId === state.person.id);
    if (!face) {
      faceState.textContent = 'Kein passendes Face-Objekt gefunden.';
      return;
    }

    card._face = face;
    faceState.classList.add('hidden');
    const img = card.querySelector('.full-photo');
    const paint = () => {
      drawCrop(card, img, face);
      positionBox(card, img, face);
    };
    img.addEventListener('load', paint, { once: true });
    if (img.complete && img.naturalWidth) paint();
    const button = card.querySelector('.reassign');
    button.disabled = false;
    button.onclick = () => openReassign(card, face, asset);
    const detachButton = card.querySelector('.detach-face');
    detachButton.disabled = false;
    detachButton.onclick = () => detachFace(card, face, asset);
    const removeButton = card.querySelector('.remove-face');
    removeButton.disabled = false;
    removeButton.onclick = () => removeFace(card, face, asset);
  } catch (e) {
    faceState.innerHTML = `<span class="error-inline">Face: ${esc(e.message)}</span> <button class="retry-face" type="button">erneut versuchen</button>`;
    const retry = card.querySelector('.retry-face');
    retry.onclick = () => { card._faceLoaded = false; loadFaceForCard(card, asset); };
  }
}

function cropRect(face) {
  const imageWidth = Math.max(1, Number(face.imageWidth) || 1);
  const imageHeight = Math.max(1, Number(face.imageHeight) || 1);
  const x1 = Number(face.boundingBoxX1) || 0;
  const y1 = Number(face.boundingBoxY1) || 0;
  const x2 = Number(face.boundingBoxX2) || x1 + 1;
  const y2 = Number(face.boundingBoxY2) || y1 + 1;
  const fw = Math.max(1, x2 - x1);
  const fh = Math.max(1, y2 - y1);
  const side = Math.max(fw, fh) * 1.75;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const x = Math.max(0, Math.min(imageWidth - 1, cx - side / 2));
  const y = Math.max(0, Math.min(imageHeight - 1, cy - side / 2));
  const w = Math.max(1, Math.min(side, imageWidth - x));
  const h = Math.max(1, Math.min(side, imageHeight - y));
  return { x, y, w, h };
}

function drawCrop(card, img, face) {
  if (!img.naturalWidth || !face.imageWidth || !face.imageHeight) return;
  const c = card.querySelector('.crop');
  const ctx = c.getContext('2d');
  const r = cropRect(face);
  const sx = img.naturalWidth / face.imageWidth;
  const sy = img.naturalHeight / face.imageHeight;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, c.width, c.height);
}

function positionBox(card, img, face) {
  if (!img.naturalWidth || !face.imageWidth || !face.imageHeight) return;
  const wrap = card.querySelector('.full-wrap');
  const box = card.querySelector('.face-box');
  const scale = Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight);
  const rw = img.naturalWidth * scale;
  const rh = img.naturalHeight * scale;
  const ox = (wrap.clientWidth - rw) / 2;
  const oy = (wrap.clientHeight - rh) / 2;
  const sx = rw / face.imageWidth;
  const sy = rh / face.imageHeight;
  box.style.left = `${ox + face.boundingBoxX1 * sx}px`;
  box.style.top = `${oy + face.boundingBoxY1 * sy}px`;
  box.style.width = `${(face.boundingBoxX2 - face.boundingBoxX1) * sx}px`;
  box.style.height = `${(face.boundingBoxY2 - face.boundingBoxY1) * sy}px`;
  box.classList.remove('hidden');
}

window.addEventListener('resize', () => document.querySelectorAll('.review-card').forEach((c) => {
  if (c._face) {
    const i = c.querySelector('.full-photo');
    if (i.complete) positionBox(c, i, c._face);
  }
}));

function openReassign(card, face, asset) {
  state.activeFace = face;
  state.activeCard = card;
  $('#reassignInfo').textContent = `${fmtDate(asset.fileCreatedAt || asset.localDateTime || asset.createdAt)} · ${asset.originalFileName || ''}`;
  $('#targetSearch').value = '';
  renderTargets(state.people.filter((p) => p.id !== state.person.id).slice(0, 40));
  $('#reassignDialog').showModal();
}

function renderTargets(people) {
  $('#targetPeople').innerHTML = people.map((p) => `<button type="button" class="target-item" data-target="${p.id}"><img src="${thumbPerson(p.id)}" loading="lazy" alt=""><div><strong>${esc(p.name || 'Unbenannt')}</strong><div class="muted">${p.birthDate ? fmtDate(p.birthDate) : ''}</div></div></button>`).join('');
  document.querySelectorAll('[data-target]').forEach((b) => { b.onclick = () => reassign(b.dataset.target); });
}

$('#targetSearch').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (!q) return renderTargets(state.people.filter((p) => p.id !== state.person.id).slice(0, 40));
  try {
    renderTargets((await api(`/review-api/people/search?q=${encodeURIComponent(q)}`)).filter((p) => p.id !== state.person.id));
  } catch (err) {
    toast(err.message);
  }
});

async function reassign(personId) {
  try {
    await api(`/review-api/faces/${state.activeFace.id}/reassign`, { method: 'PUT', body: JSON.stringify({ personId }) });
    markReviewed();
    $('#reassignDialog').close();
    toast('Gesicht wurde neu zugeordnet');
  } catch (e) {
    toast(e.message);
  }
}

function markCardReviewed(card, label = 'Korrigiert') {
  if (!card) return;
  state.reviewed.add(card.dataset.asset);
  card.classList.add('reviewed');
  const badge = card.querySelector('.ok-badge');
  badge.textContent = label;
  badge.classList.remove('hidden');
  if ($('#hideReviewed').checked) card.classList.add('hidden');
}

function markReviewed() {
  markCardReviewed(state.activeCard);
}

async function scrollToNextCard(card) {
  let next = card?.nextElementSibling;
  if (!next && state.nextPage != null) {
    await loadNextPage();
    next = card?.nextElementSibling;
  }
  if (next?.classList?.contains('review-card')) {
    requestAnimationFrame(() => next.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
}

async function detachFace(card, face, asset) {
  const button = card?.querySelector('.detach-face');
  if (button) {
    button.disabled = true;
    button.textContent = 'Zuordnung wird gelöst…';
  }
  try {
    await api(`/review-api/faces/${face.id}/unassign`, {
      method: 'POST',
      body: JSON.stringify({ assetId: asset.id }),
    });
    card.querySelector('.face-box')?.classList.add('hidden');
    markCardReviewed(card, 'Zuordnung gelöst');
    toast('Face bleibt erhalten · Personenzuordnung entfernt');
    await scrollToNextCard(card);
    return true;
  } catch (e) {
    if (button) {
      button.disabled = false;
      button.textContent = 'Zuordnung lösen';
    }
    toast(e.message);
    return false;
  }
}

async function removeFace(card, face, asset, { confirmDelete = true } = {}) {
  const taken = asset.fileCreatedAt || asset.localDateTime || asset.createdAt;
  if (confirmDelete && !window.confirm(`Face-Markierung wirklich entfernen?\n${fmtDate(taken)} · ${asset.originalFileName || ''}`)) return false;

  const button = card?.querySelector('.remove-face');
  if (button) {
    button.disabled = true;
    button.textContent = 'Wird entfernt…';
  }

  try {
    await api(`/review-api/faces/${face.id}`, { method: 'DELETE' });
    if (card) {
      card.querySelector('.face-box')?.classList.add('hidden');
      card.querySelector('.crop')?.getContext('2d')?.clearRect(0, 0, 500, 500);
      markCardReviewed(card, 'Markierung entfernt');
    }
    if (confirmDelete) toast('Face-Markierung entfernt');
    return true;
  } catch (e) {
    if (button) {
      button.disabled = false;
      button.textContent = 'Markierung entfernen';
    }
    if (confirmDelete) toast(e.message);
    return false;
  }
}


let clusterOutlierRenderTimer;

function resetClusterState() {
  state.cluster = null;
  state.clusterRadius = 0;
  state.clusterSelected.clear();
  state.clusterVisibleCount = 80;
  state.clusterListMode = 'outside';
  state.clusterLoadedFor = null;
  state.clusterLoading = false;
  state.clusterPlotPoints = [];
  state.clusterNeighborPlotPoints = [];
  state.clusterPlotGeometry = null;
  state.clusterPointView.clear();
  state.clusterNeighborView.clear();
  state.clusterDynamicStats = null;
  state.clusterCenter = { x: 0, y: 0 };
  state.clusterCenterMaxDistance = 0;
  state.clusterActiveCenterVector = [];
  state.clusterCenterDragging = false;
  state.clusterCenterDragPointerId = null;
  state.clusterCenterDragMoved = false;
  state.clusterCenterDragPending = null;
  state.clusterCenterDragGeometry = null;
  state.clusterCenterDragStart = null;
  state.clusterHoverFaceId = null;
  state.clusterHoverKey = null;
  state.clusterNeighbors = [];
  state.clusterNeighborLoadedFor = null;
  state.clusterNeighborQueryLimit = 0;
  state.clusterNeighborAvailable = 0;
  state.clusterNeighborCandidatePool = 0;
  state.clusterNeighborLoading = false;
  state.clusterNeighborError = '';
  state.clusterNeighborRequestToken++;
  state.clusterActiveNeighbor = null;
  if (state.clusterCenterDragFrame) cancelAnimationFrame(state.clusterCenterDragFrame);
  state.clusterCenterDragFrame = 0;
  state.clusterImageCache.clear();
  clearTimeout(clusterOutlierRenderTimer);
  clusterResizeObserver?.disconnect();
  $('#clusterCanvas')?.classList.remove('dragging-center', 'center-hover');
  $('#clusterNeighborDialog')?.close?.();
  $('#clusterLoading')?.classList.remove('hidden');
  $('#clusterError')?.classList.add('hidden');
  $('#clusterDashboard')?.classList.add('hidden');
  if ($('#clusterOutlierGrid')) $('#clusterOutlierGrid').innerHTML = '';
  hideClusterTooltip();
}

function setPersonView(view, { load = true } = {}) {
  const cluster = view === 'cluster';
  state.activePersonView = cluster ? 'cluster' : 'timeline';
  $('#timelineViewBtn').classList.toggle('active', !cluster);
  $('#timelineViewBtn').setAttribute('aria-selected', String(!cluster));
  $('#clusterViewBtn').classList.toggle('active', cluster);
  $('#clusterViewBtn').setAttribute('aria-selected', String(cluster));
  $('#timelineView').classList.toggle('hidden', cluster);
  $('#clusterView').classList.toggle('hidden', !cluster);
  document.querySelector('.review-head .toggle')?.classList.toggle('hidden', cluster);
  updateBatchButton();

  if (cluster && load) {
    loadVectorCluster();
    requestAnimationFrame(drawVectorCluster);
  } else if (!cluster && state.timelineStale && state.person) {
    reloadTimelineView();
  }
}

async function reloadTimelineView() {
  if (!state.person) return;
  state.timelineStale = false;
  resetReviewState();
  $('#timeline').innerHTML = '<div class="panel loading initial-loading">Assets werden nach den Änderungen neu geladen…</div>';
  initObservers();
  await loadNextPage();
}

function clusterSetupMessage() {
  return `Für die Vektoransicht braucht die App zusätzlich einen lesenden PostgreSQL-Zugriff auf die Immich-Datenbank.\n\nBeispiel für .env:\nIMMICH_DB_HOST=database\nIMMICH_DB_PORT=5432\nIMMICH_DB_USER=immich_person_review\nIMMICH_DB_PASSWORD=…\nIMMICH_DB_NAME=immich\n\nDer App-Container muss außerdem im selben Docker-Netz wie Immich/PostgreSQL liegen.`;
}

function showClusterError(message) {
  $('#clusterLoading').classList.add('hidden');
  $('#clusterDashboard').classList.add('hidden');
  const error = $('#clusterError');
  error.textContent = message;
  error.classList.remove('hidden');
}

async function loadVectorCluster({ force = false } = {}) {
  if (!state.person || state.clusterLoading) return;
  if (!force && state.cluster && state.clusterLoadedFor === state.person.id) {
    renderVectorCluster({ resetRadius: false, resetCenter: false });
    if (state.clusterNeighborsEnabled) loadClusterNeighbors();
    return;
  }
  if (!state.vectorDatabase.configured) {
    showClusterError(clusterSetupMessage());
    return;
  }

  const preserveControls = Boolean(state.cluster && state.clusterLoadedFor === state.person.id);
  state.clusterLoading = true;
  $('#clusterLoading').classList.remove('hidden');
  $('#clusterError').classList.add('hidden');
  $('#clusterDashboard').classList.add('hidden');
  try {
    const data = await api(`/review-api/people/${state.person.id}/vector-cluster`);
    state.cluster = data;
    state.clusterLoadedFor = state.person.id;
    state.clusterSelected.clear();
    state.clusterVisibleCount = 80;
    state.clusterImageCache.clear();
    renderVectorCluster({ resetRadius: !preserveControls, resetCenter: !preserveControls });
    if (state.clusterNeighborsEnabled) loadClusterNeighbors({ force });
  } catch (error) {
    showClusterError(error.message);
  } finally {
    state.clusterLoading = false;
    $('#clusterLoading').classList.add('hidden');
  }
}

const CLUSTER_NEIGHBOR_COLORS = ['#c084fc', '#22d3ee', '#facc15', '#f472b6', '#a3e635', '#fb7185', '#60a5fa', '#fb923c', '#2dd4bf', '#e879f9'];

function initializeClusterNeighborPreferences() {
  const configuredMax = Number(state.vectorDatabase?.maxAdjacentPeople || 50);
  state.clusterNeighborMax = Number.isFinite(configuredMax) ? Math.max(1, Math.floor(configuredMax)) : 50;
  try {
    state.clusterNeighborsEnabled = localStorage.getItem('immich-review.cluster-neighbors.enabled') === 'true';
    const storedCount = Number(localStorage.getItem('immich-review.cluster-neighbors.count'));
    if (Number.isFinite(storedCount)) state.clusterNeighborCount = storedCount;
  } catch {}
  state.clusterNeighborCount = Math.min(state.clusterNeighborMax, Math.max(1, Math.floor(state.clusterNeighborCount || 8)));
  const range = $('#clusterNeighborCountRange');
  const input = $('#clusterNeighborCountInput');
  range.max = String(state.clusterNeighborMax);
  input.max = String(state.clusterNeighborMax);
  range.value = String(state.clusterNeighborCount);
  input.value = String(state.clusterNeighborCount);
  $('#clusterNeighborsEnabled').checked = state.clusterNeighborsEnabled;
  updateClusterNeighborUi();
}

function clusterNeighborColor(index) {
  return CLUSTER_NEIGHBOR_COLORS[index % CLUSTER_NEIGHBOR_COLORS.length];
}

function visibleClusterNeighbors() {
  if (!state.clusterNeighborsEnabled) return [];
  return state.clusterNeighbors.slice(0, state.clusterNeighborCount);
}

function updateClusterNeighborUi(message = '') {
  const enabled = state.clusterNeighborsEnabled;
  $('#clusterNeighborsEnabled').checked = enabled;
  $('#clusterNeighborCountRange').disabled = !enabled;
  $('#clusterNeighborCountInput').disabled = !enabled;
  $('#clusterNeighborCountRange').value = String(state.clusterNeighborCount);
  $('#clusterNeighborCountInput').value = String(state.clusterNeighborCount);
  $('#clusterNeighborLegend').classList.toggle('hidden', !enabled);
  const status = $('#clusterNeighborStatus');
  if (message) {
    status.textContent = message;
  } else if (!enabled) {
    status.textContent = 'Ausgeblendet';
  } else if (state.clusterNeighborLoading) {
    status.textContent = 'Angrenzende Personen werden berechnet…';
  } else if (state.clusterNeighborError) {
    status.textContent = `Fehler: ${state.clusterNeighborError}`;
  } else if (state.clusterNeighborLoadedFor === state.person?.id) {
    const shown = visibleClusterNeighbors().length;
    status.textContent = `${shown} angezeigt · ${state.clusterNeighborAvailable} berechnet · ${state.clusterNeighborCandidatePool} Immich-Kandidaten`;
  } else {
    status.textContent = 'Noch nicht geladen';
  }
}

function setClusterNeighborsEnabled(enabled) {
  state.clusterNeighborsEnabled = Boolean(enabled);
  state.clusterNeighborError = '';
  if (!state.clusterNeighborsEnabled) state.clusterNeighborRequestToken++;
  try { localStorage.setItem('immich-review.cluster-neighbors.enabled', String(state.clusterNeighborsEnabled)); } catch {}
  updateClusterNeighborUi();
  if (state.clusterNeighborsEnabled && state.cluster) loadClusterNeighbors();
  else {
    state.clusterNeighborPlotPoints = [];
    hideClusterTooltip();
    drawVectorCluster();
  }
}

function setClusterNeighborCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  state.clusterNeighborCount = Math.min(state.clusterNeighborMax, Math.max(1, Math.floor(numeric)));
  try { localStorage.setItem('immich-review.cluster-neighbors.count', String(state.clusterNeighborCount)); } catch {}
  updateClusterNeighborUi();
  if (!state.clusterNeighborsEnabled || !state.cluster) return;
  if (state.clusterNeighborLoadedFor !== state.person?.id || state.clusterNeighborQueryLimit < state.clusterNeighborCount) {
    loadClusterNeighbors();
  } else {
    recomputeClusterNeighborView();
    drawVectorCluster();
  }
}

async function loadClusterNeighbors({ force = false } = {}) {
  if (!state.person || !state.cluster || !state.clusterNeighborsEnabled) return;
  if (!force
      && state.clusterNeighborLoadedFor === state.person.id
      && state.clusterNeighborQueryLimit >= state.clusterNeighborCount) {
    recomputeClusterNeighborView();
    updateClusterNeighborUi();
    drawVectorCluster();
    return;
  }

  const personId = state.person.id;
  const token = ++state.clusterNeighborRequestToken;
  state.clusterNeighborLoading = true;
  state.clusterNeighborError = '';
  updateClusterNeighborUi();
  try {
    const data = await api(`/review-api/people/${personId}/vector-neighbors?limit=${state.clusterNeighborCount}${force ? '&force=true' : ''}`);
    if (token !== state.clusterNeighborRequestToken || personId !== state.person?.id) return;
    state.clusterNeighbors = Array.isArray(data.people) ? data.people : [];
    state.clusterNeighborLoadedFor = personId;
    state.clusterNeighborQueryLimit = Number(data.limit || state.clusterNeighborCount);
    state.clusterNeighborAvailable = Number(data.available || state.clusterNeighbors.length);
    state.clusterNeighborCandidatePool = Number(data.candidatePool || 0);
    recomputeClusterNeighborView();
    updateClusterNeighborUi();
    drawVectorCluster();
  } catch (error) {
    if (token !== state.clusterNeighborRequestToken) return;
    state.clusterNeighbors = [];
    state.clusterNeighborPlotPoints = [];
    state.clusterNeighborError = error.message;
    drawVectorCluster();
  } finally {
    if (token === state.clusterNeighborRequestToken) {
      state.clusterNeighborLoading = false;
      updateClusterNeighborUi();
    }
  }
}

function formatClusterDistance(value, digits = 3) {
  return Number(value || 0).toLocaleString('de-AT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatClusterDate(value) {
  if (!value) return 'Datum unbekannt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return fmtDate(date);
}

function clusterQuantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = Math.min(1, Math.max(0, q)) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

function clusterViewForPoint(point) {
  return state.clusterPointView.get(point.faceId) || {
    distance: distanceToClusterCenter(point, state.clusterCenter),
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
  };
}

function clusterNeighborViewForPoint(point) {
  return state.clusterNeighborView.get(point.id) || {
    distance: distanceToClusterCenter(point, state.clusterCenter),
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
  };
}

function recomputeClusterNeighborView() {
  const view = new Map();
  for (const person of state.clusterNeighbors) {
    view.set(person.id, projectPointAroundClusterCenter(person, state.clusterCenter));
  }
  state.clusterNeighborView = view;
}

function currentClusterDistance(point) {
  return Number(clusterViewForPoint(point).distance || 0);
}

function updateClusterCenterReadout({ updateVectorText = true } = {}) {
  if (!state.cluster || !state.clusterDynamicStats) return;
  const center = describeClusterCenter(state.clusterCenter);
  const moved = center.radialDistance > 1e-9;
  const stats = state.clusterDynamicStats;
  const furthest = state.cluster.points.reduce((best, point) => {
    if (!best || currentClusterDistance(point) > currentClusterDistance(best)) return point;
    return best;
  }, null);

  $('#clusterCentroidMeta').textContent = moved
    ? `${state.cluster.dimensions}D · d(c, μ) ${formatClusterDistance(center.radialDistance)} · R ${formatClusterDistance(state.cluster.meanVectorNorm, 3)}`
    : `${state.cluster.dimensions}D · Mittelpunkt μ · R ${formatClusterDistance(state.cluster.meanVectorNorm, 3)}`;
  $('#clusterMeanDistance').textContent = formatClusterDistance(stats.meanDistance);
  $('#clusterMaxDistance').textContent = formatClusterDistance(stats.maxDistance);
  $('#clusterMaxDistanceMeta').textContent = furthest?.originalFileName || 'entferntestes Gesicht';
  $('#clusterPresetP90').textContent = `P90 · ${formatClusterDistance(stats.p90Distance)}`;
  $('#clusterPresetP95').textContent = `P95 · ${formatClusterDistance(stats.p95Distance)}`;
  $('#clusterCenterDistance').textContent = formatClusterDistance(center.radialDistance);
  $('#clusterCenterMode').textContent = moved ? 'manuell verschoben' : 'entspricht μ';
  $('#clusterResetCenterBtn').disabled = !moved;

  if (updateVectorText) {
    $('#clusterActiveCenterVector').value = `[${state.clusterActiveCenterVector.map((value) => Number(value).toFixed(8)).join(', ')}]`;
  }
}

function recomputeClusterPointView({ updateVectorText = true } = {}) {
  if (!state.cluster) return;
  const view = new Map();
  const distances = [];
  for (const point of state.cluster.points) {
    const projected = projectPointAroundClusterCenter(point, state.clusterCenter);
    view.set(point.faceId, projected);
    distances.push(projected.distance);
  }
  distances.sort((a, b) => a - b);
  const meanDistance = distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : 0;
  state.clusterPointView = view;
  recomputeClusterNeighborView();
  state.clusterDynamicStats = {
    count: distances.length,
    minDistance: distances[0] || 0,
    maxDistance: distances.at(-1) || 0,
    meanDistance,
    medianDistance: clusterQuantile(distances, 0.5),
    p90Distance: clusterQuantile(distances, 0.9),
    p95Distance: clusterQuantile(distances, 0.95),
  };
  state.clusterActiveCenterVector = clusterCenterVector(state.cluster, state.clusterCenter);
  updateClusterCenterReadout({ updateVectorText });
}

function renderVectorCluster({ resetRadius = true, resetCenter = true } = {}) {
  const data = state.cluster;
  if (!data) return;
  if (!data.points?.length) {
    showClusterError(data.totalAssignedFaces
      ? `Für diese Person wurden bei ${data.totalAssignedFaces} zugeordneten Faces keine lesbaren Embeddings gefunden.`
      : 'Dieser Person sind derzeit keine Faces zugeordnet.');
    return;
  }
  $('#clusterError').classList.add('hidden');
  $('#clusterDashboard').classList.remove('hidden');
  $('#clusterFaceCount').textContent = data.facesWithEmbedding;
  $('#clusterMissingCount').textContent = `${data.facesWithoutEmbedding} ohne Embedding`;
  $('#clusterMeanVector').value = `[${(data.meanVector || []).join(', ')}]`;
  $('#clusterCentroidVector').value = `[${(data.centroid || []).join(', ')}]`;

  state.clusterCenterMaxDistance = Math.min(
    1.5,
    Math.max(0.12, Number(data.stats.maxDistance || 0) * 1.5, Number(data.defaultRadius || 0) * 0.8),
  );
  if (resetCenter) {
    state.clusterCenter = { x: 0, y: 0 };
  } else {
    const current = describeClusterCenter(state.clusterCenter);
    if (current.radialDistance > state.clusterCenterMaxDistance) {
      const scale = state.clusterCenterMaxDistance / current.radialDistance;
      state.clusterCenter = { x: current.x * scale, y: current.y * scale };
    }
  }
  $('#clusterCenterLimit').textContent = formatClusterDistance(state.clusterCenterMaxDistance);

  const maxControlValue = 2;
  $('#clusterRadiusRange').max = String(maxControlValue);
  $('#clusterRadiusInput').max = String(maxControlValue);
  const initial = Number.isFinite(Number(data.defaultRadius)) ? Number(data.defaultRadius) : Number(data.stats.p90Distance || 0);
  if (resetRadius || !Number.isFinite(state.clusterRadius)) {
    state.clusterRadius = Math.min(maxControlValue, Math.max(0, initial));
  } else {
    state.clusterRadius = Math.min(maxControlValue, Math.max(0, state.clusterRadius));
  }

  recomputeClusterPointView();
  clusterResizeObserver?.disconnect();
  if ('ResizeObserver' in window) {
    clusterResizeObserver = new ResizeObserver(() => drawVectorCluster());
    clusterResizeObserver.observe($('#clusterCanvasWrap'));
  }
  updateClusterThreshold({ renderCards: true });
}

function clusterPointIsOutside(point) {
  return currentClusterDistance(point) > state.clusterRadius;
}

function getClusterOutliers() {
  if (!state.cluster) return [];
  return filterAndSortClusterPoints(state.cluster.points, {
    mode: 'outside',
    radius: state.clusterRadius,
    distanceOf: currentClusterDistance,
  });
}

function getClusterListedPoints() {
  if (!state.cluster) return [];
  return filterAndSortClusterPoints(state.cluster.points, {
    mode: state.clusterListMode,
    radius: state.clusterRadius,
    distanceOf: currentClusterDistance,
  });
}

function clusterListModeCopy(count) {
  const radius = formatClusterDistance(state.clusterRadius);
  if (state.clusterListMode === 'inside') {
    return {
      title: 'Assets innerhalb des Radius',
      summary: `${count} Face${count === 1 ? '' : 's'} mit Distanz ≤ ${radius} zum aktuellen Zentrum · grenzwertigste zuerst.`,
      empty: 'Bei diesem Radius liegen keine Gesichter innerhalb.',
      selectAll: 'Innerhalb markieren',
    };
  }
  if (state.clusterListMode === 'all') {
    return {
      title: 'Alle Assets nach Distanz',
      summary: `${count} Face${count === 1 ? '' : 's'} · größte Distanz zum aktuellen Zentrum zuerst.`,
      empty: 'Für diese Person sind keine Gesichter mit Embedding vorhanden.',
      selectAll: 'Alle markieren',
    };
  }
  return {
    title: 'Assets außerhalb des Radius',
    summary: `${count} Face${count === 1 ? '' : 's'} mit Distanz > ${radius} zum aktuellen Zentrum · am wenigsten ähnliche zuerst.`,
    empty: 'Bei diesem Radius liegen keine Gesichter außerhalb.',
    selectAll: 'Außerhalb markieren',
  };
}

function updateClusterListModeUi(points = getClusterListedPoints()) {
  for (const [mode, selector] of [
    ['outside', '#clusterShowOutsideBtn'],
    ['inside', '#clusterShowInsideBtn'],
    ['all', '#clusterShowAllBtn'],
  ]) {
    const button = $(selector);
    const active = state.clusterListMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const copy = clusterListModeCopy(points.length);
  $('#clusterAssetListTitle').textContent = copy.title;
  $('#clusterOutlierSummary').textContent = copy.summary;
  $('#clusterEmptyOutliers').textContent = copy.empty;
  $('#clusterSelectAllBtn').textContent = copy.selectAll;
}

function pruneClusterSelectionToCurrentList() {
  const allowed = new Set(getClusterListedPoints().map((point) => point.faceId));
  for (const faceId of [...state.clusterSelected]) {
    if (!allowed.has(faceId)) state.clusterSelected.delete(faceId);
  }
}

function setClusterListMode(mode) {
  if (!isClusterListMode(mode) || state.clusterListMode === mode) return;
  state.clusterListMode = mode;
  state.clusterVisibleCount = 80;
  pruneClusterSelectionToCurrentList();
  renderClusterOutliers();
  drawVectorCluster();
}

function setClusterRadius(value, { renderCards = true } = {}) {
  const max = Number($('#clusterRadiusRange').max || 2);
  const numeric = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(numeric)) return;
  state.clusterRadius = Math.min(max, Math.max(0, numeric));
  updateClusterThreshold({ renderCards });
}

function setClusterCenter(x, y, { renderCards = true, updateVectorText = true } = {}) {
  let nextX = Number(x);
  let nextY = Number(y);
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
  const radius = Math.hypot(nextX, nextY);
  if (radius > state.clusterCenterMaxDistance && radius > 0) {
    const scale = state.clusterCenterMaxDistance / radius;
    nextX *= scale;
    nextY *= scale;
  }
  state.clusterCenter = { x: nextX, y: nextY };
  recomputeClusterPointView({ updateVectorText });
  updateClusterThreshold({ renderCards });
}

function resetClusterCenter() {
  setClusterCenter(0, 0, { renderCards: true, updateVectorText: true });
}

function updateClusterThreshold({ renderCards = true } = {}) {
  if (!state.cluster) return;
  $('#clusterRadiusRange').value = String(state.clusterRadius);
  $('#clusterRadiusInput').value = state.clusterRadius.toFixed(3);
  const outliers = getClusterOutliers();
  $('#clusterOutsideCount').textContent = outliers.length;
  $('#clusterInsideCount').textContent = Math.max(0, state.cluster.points.length - outliers.length);
  pruneClusterSelectionToCurrentList();
  updateClusterListModeUi();
  updateClusterSelectionControls();
  drawVectorCluster();

  if (renderCards) {
    clearTimeout(clusterOutlierRenderTimer);
    renderClusterOutliers();
  } else {
    clearTimeout(clusterOutlierRenderTimer);
    clusterOutlierRenderTimer = setTimeout(renderClusterOutliers, 110);
  }
}

function updateClusterSelectionControls() {
  const count = state.clusterSelected.size;
  $('#clusterSelectedCount').textContent = count;
  const button = $('#clusterDetachSelectedBtn');
  button.disabled = count === 0;
  button.textContent = `Personenzuordnung lösen (${count})`;
  document.querySelectorAll('.cluster-outlier-card').forEach((card) => {
    const selected = state.clusterSelected.has(card.dataset.faceId);
    card.classList.toggle('selected', selected);
    const checkbox = card.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = selected;
  });
}

function toggleClusterSelection(faceId, selected = !state.clusterSelected.has(faceId)) {
  if (selected) state.clusterSelected.add(faceId);
  else state.clusterSelected.delete(faceId);
  updateClusterSelectionControls();
  drawVectorCluster();
}

function renderClusterOutliers() {
  const listedPoints = getClusterListedPoints();
  const shown = listedPoints.slice(0, state.clusterVisibleCount);
  updateClusterListModeUi(listedPoints);
  $('#clusterEmptyOutliers').classList.toggle('hidden', listedPoints.length !== 0);
  const grid = $('#clusterOutlierGrid');
  grid.innerHTML = shown.map((point) => {
    const date = point.localDateTime || point.fileCreatedAt || point.createdAt;
    const width = Math.max(0, Number(point.boundingBoxX2) - Number(point.boundingBoxX1));
    const height = Math.max(0, Number(point.boundingBoxY2) - Number(point.boundingBoxY1));
    const selected = state.clusterSelected.has(point.faceId);
    const outside = clusterPointIsOutside(point);
    const externalLink = state.immichUrl
      ? `<a class="cluster-open-asset" href="${esc(immichAssetUrl(point.assetId))}" target="_blank" rel="noopener noreferrer" title="Asset in Immich öffnen" aria-label="Asset in Immich öffnen">↗</a>`
      : '';
    return `<article class="cluster-outlier-card ${outside ? 'outside' : 'inside'}${selected ? ' selected' : ''}" data-face-id="${esc(point.faceId)}" title="Zum Markieren anklicken">
      ${externalLink}
      <input type="checkbox" aria-label="Face markieren" ${selected ? 'checked' : ''}>
      <canvas width="320" height="320"></canvas>
      <div class="cluster-card-body">
        <div class="cluster-distance">${formatClusterDistance(currentClusterDistance(point))}</div>
        <div class="cluster-file">${esc(point.originalFileName || point.assetId)}</div>
        <div class="cluster-date">${esc(formatClusterDate(date))}</div>
        <div class="cluster-face-size">Face ${width} × ${height} px</div>
      </div>
    </article>`;
  }).join('');

  const pointsById = new Map(shown.map((point) => [point.faceId, point]));
  for (const card of grid.querySelectorAll('.cluster-outlier-card')) {
    const faceId = card.dataset.faceId;
    const point = pointsById.get(faceId);
    const checkbox = card.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => toggleClusterSelection(faceId, checkbox.checked));
    card.querySelector('.cluster-open-asset')?.addEventListener('click', (event) => event.stopPropagation());
    card.addEventListener('click', () => toggleClusterSelection(faceId));
    paintClusterFaceCrop(card.querySelector('canvas'), point);
  }

  const loadMore = $('#clusterLoadMoreBtn');
  loadMore.classList.toggle('hidden', shown.length >= listedPoints.length);
  if (shown.length < listedPoints.length) loadMore.textContent = `Weitere anzeigen (${listedPoints.length - shown.length})`;
  updateClusterSelectionControls();
}

function loadClusterAssetImage(assetId) {
  if (!state.clusterImageCache.has(assetId)) {
    state.clusterImageCache.set(assetId, new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Thumbnail konnte nicht geladen werden'));
      image.src = thumbAsset(assetId);
    }));
  }
  return state.clusterImageCache.get(assetId);
}

async function paintClusterFaceCrop(canvas, point) {
  if (!canvas || !point) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#07131f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    const image = await loadClusterAssetImage(point.assetId);
    if (!canvas.isConnected) return;
    const rect = cropRect(point);
    const scaleX = image.naturalWidth / Math.max(1, Number(point.imageWidth));
    const scaleY = image.naturalHeight / Math.max(1, Number(point.imageHeight));
    ctx.fillStyle = '#07131f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      image,
      rect.x * scaleX,
      rect.y * scaleY,
      rect.w * scaleX,
      rect.h * scaleY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  } catch {
    ctx.fillStyle = '#8fa5bc';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Kein Thumbnail', canvas.width / 2, canvas.height / 2);
  }
}

function prepareClusterCanvas() {
  const canvas = $('#clusterCanvas');
  const width = Math.max(320, Math.floor(canvas.clientWidth || 0));
  const height = Math.max(320, Math.floor(canvas.clientHeight || 0));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, width, height };
}

function drawVectorCluster() {
  if (!state.cluster || $('#clusterView').classList.contains('hidden')) return;
  const { ctx, width, height } = prepareClusterCanvas();
  ctx.clearRect(0, 0, width, height);
  const originX = width / 2;
  const originY = height / 2;
  const plotRadius = Math.max(80, Math.min(width, height) * 0.42);
  const center = describeClusterCenter(state.clusterCenter);
  let maxWorldDistance = center.radialDistance + state.clusterRadius;
  for (const point of state.cluster.points) {
    const view = clusterViewForPoint(point);
    maxWorldDistance = Math.max(maxWorldDistance, Math.hypot(view.x, view.y));
  }
  const visibleNeighbors = visibleClusterNeighbors();
  for (const person of visibleNeighbors) {
    const view = clusterNeighborViewForPoint(person);
    maxWorldDistance = Math.max(maxWorldDistance, Math.hypot(view.x, view.y));
  }
  maxWorldDistance = Math.max(0.01, maxWorldDistance * 1.08);
  const scale = state.clusterCenterDragging && state.clusterCenterDragGeometry?.scale
    ? state.clusterCenterDragGeometry.scale
    : plotRadius / maxWorldDistance;
  const centerPx = originX + center.x * scale;
  const centerPy = originY - center.y * scale;

  ctx.save();
  ctx.strokeStyle = 'rgba(150,180,210,.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const radius = plotRadius * (i / 4);
    ctx.beginPath();
    ctx.arc(originX, originY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(originX - plotRadius, originY);
  ctx.lineTo(originX + plotRadius, originY);
  ctx.moveTo(originX, originY - plotRadius);
  ctx.lineTo(originX, originY + plotRadius);
  ctx.stroke();

  if (center.radialDistance > 1e-9) {
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(125,172,238,.58)';
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(centerPx, centerPy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const thresholdPixels = state.clusterRadius * scale;
  ctx.strokeStyle = '#68a4ff';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(centerPx, centerPy, thresholdPixels, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#9fc5ff';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(
    `Radius ${formatClusterDistance(state.clusterRadius)}`,
    Math.max(8, Math.min(width - 138, centerPx + thresholdPixels + 8)),
    Math.max(16, centerPy - 7),
  );

  const plotted = state.cluster.points.map((point) => {
    const view = clusterViewForPoint(point);
    return {
      point,
      view,
      outside: view.distance > state.clusterRadius,
      px: originX + view.x * scale,
      py: originY - view.y * scale,
    };
  }).sort((a, b) => Number(a.outside) - Number(b.outside));

  for (const item of plotted) {
    const selected = state.clusterSelected.has(item.point.faceId);
    const radius = selected ? 7 : item.outside ? 5 : 3.6;
    ctx.beginPath();
    ctx.arc(item.px, item.py, radius, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#69a9ff' : item.outside ? '#ff6b3d' : '#76c96b';
    ctx.globalAlpha = item.outside || selected ? 1 : 0.84;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (selected) {
      ctx.strokeStyle = '#f7fbff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  const plottedNeighbors = visibleNeighbors.map((person, index) => {
    const view = clusterNeighborViewForPoint(person);
    return {
      person,
      view,
      color: clusterNeighborColor(index),
      px: originX + view.x * scale,
      py: originY - view.y * scale,
    };
  });

  for (let index = plottedNeighbors.length - 1; index >= 0; index--) {
    const item = plottedNeighbors[index];
    const hovered = state.clusterHoverKey === `person:${item.person.id}`;
    ctx.save();
    ctx.translate(item.px, item.py);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = item.color;
    ctx.strokeStyle = hovered ? '#ffffff' : 'rgba(255,255,255,.86)';
    ctx.lineWidth = hovered ? 3 : 1.5;
    const size = hovered ? 8.5 : 7;
    ctx.beginPath();
    ctx.rect(-size, -size, size * 2, size * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#f8fbff';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), item.px, item.py);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Original normalized arithmetic mean μ.
  ctx.strokeStyle = '#9db6d1';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(originX - 6, originY - 6);
  ctx.lineTo(originX + 6, originY + 6);
  ctx.moveTo(originX + 6, originY - 6);
  ctx.lineTo(originX - 6, originY + 6);
  ctx.stroke();
  ctx.fillStyle = '#aebfd2';
  ctx.font = '12px system-ui';
  ctx.fillText('μ', originX + 9, originY - 8);

  // Draggable current spherical center c.
  ctx.beginPath();
  ctx.arc(centerPx, centerPy, 11, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(62,136,255,.28)';
  ctx.fill();
  ctx.strokeStyle = '#78adff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(centerPx, centerPy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#dbeafe';
  ctx.fill();
  ctx.fillStyle = '#c7ddff';
  ctx.font = 'bold 12px system-ui';
  ctx.fillText('c', centerPx + 14, centerPy - 10);
  ctx.restore();

  state.clusterPlotPoints = plotted;
  state.clusterNeighborPlotPoints = plottedNeighbors;
  state.clusterPlotGeometry = { originX, originY, centerPx, centerPy, scale, plotRadius, width, height };
}

function clusterCanvasCoordinates(event) {
  const canvas = $('#clusterCanvas');
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pointerNearClusterCenter(event, radius = 17) {
  if (!state.clusterPlotGeometry) return false;
  const point = clusterCanvasCoordinates(event);
  return Math.hypot(point.x - state.clusterPlotGeometry.centerPx, point.y - state.clusterPlotGeometry.centerPy) <= radius;
}

function nearestClusterPlotPoint(event) {
  const { x, y } = clusterCanvasCoordinates(event);
  let nearest = null;
  let nearestDistance = Infinity;
  for (const item of state.clusterPlotPoints) {
    const distance = Math.hypot(item.px - x, item.py - y);
    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 12 ? { item: nearest, x, y } : null;
}

function nearestClusterNeighborPlotPoint(event) {
  const { x, y } = clusterCanvasCoordinates(event);
  let nearest = null;
  let nearestDistance = Infinity;
  for (const item of state.clusterNeighborPlotPoints) {
    const distance = Math.hypot(item.px - x, item.py - y);
    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 15 ? { item: nearest, x, y } : null;
}

function hideClusterTooltip() {
  const hadNeighborHover = String(state.clusterHoverKey || '').startsWith('person:');
  state.clusterHoverFaceId = null;
  state.clusterHoverKey = null;
  $('#clusterTooltip').classList.add('hidden');
  if (hadNeighborHover && state.clusterNeighborPlotPoints.length) drawVectorCluster();
}

function positionClusterTooltip(hit) {
  const tooltip = $('#clusterTooltip');
  const wrap = $('#clusterCanvasWrap');
  const width = tooltip.offsetWidth || 310;
  const height = tooltip.offsetHeight || 126;
  tooltip.style.left = `${Math.max(0, Math.min(hit.x, wrap.clientWidth - width - 18))}px`;
  tooltip.style.top = `${Math.max(0, Math.min(hit.y, wrap.clientHeight - height - 18))}px`;
}

function showClusterTooltip(event) {
  if (state.clusterCenterDragging || pointerNearClusterCenter(event)) {
    hideClusterTooltip();
    return;
  }
  const neighborHit = nearestClusterNeighborPlotPoint(event);
  const tooltip = $('#clusterTooltip');
  if (neighborHit) {
    const person = neighborHit.item.person;
    const hoverKey = `person:${person.id}`;
    if (state.clusterHoverKey !== hoverKey) {
      state.clusterHoverKey = hoverKey;
      state.clusterHoverFaceId = null;
      tooltip.innerHTML = `<img class="cluster-tooltip-thumb cluster-tooltip-person-thumb" src="${thumbPerson(person.id)}" alt=""><div class="cluster-tooltip-copy"><strong>${esc(person.name || 'Unbenannte Person')}</strong><span class="neighbor-distance">Personenmittelpunkt · Distanz ${formatClusterDistance(neighborHit.item.view.distance)}</span><span>${Number(person.faceCount || 0)} Faces mit Embedding${person.isHidden ? ' · verborgen' : ''}</span><span class="cluster-tooltip-open">Klicken: in Immich öffnen oder zusammenführen</span></div>`;
      tooltip.classList.remove('hidden');
      drawVectorCluster();
    } else {
      tooltip.classList.remove('hidden');
    }
    positionClusterTooltip(neighborHit);
    return;
  }

  const hit = nearestClusterPlotPoint(event);
  if (!hit) {
    hideClusterTooltip();
    return;
  }
  const point = hit.item.point;
  const hoverKey = `face:${point.faceId}`;
  if (state.clusterHoverKey !== hoverKey) {
    state.clusterHoverKey = hoverKey;
    state.clusterHoverFaceId = point.faceId;
    const date = point.localDateTime || point.fileCreatedAt || point.createdAt;
    tooltip.innerHTML = `<canvas class="cluster-tooltip-thumb" width="112" height="112"></canvas><div class="cluster-tooltip-copy"><strong>${esc(point.originalFileName || point.assetId)}</strong><span class="distance">Distanz ${formatClusterDistance(hit.item.view.distance)}</span><span>${esc(formatClusterDate(date))}</span>${hit.item.outside ? '<span>außerhalb des Radius</span>' : '<span>innerhalb des Radius</span>'}${state.immichUrl ? '<span class="cluster-tooltip-open">↗ in Immich öffnen: Punkt anklicken, dann Karte verwenden</span>' : ''}</div>`;
    tooltip.classList.remove('hidden');
    paintClusterFaceCrop(tooltip.querySelector('canvas'), point);
    if (state.clusterNeighborPlotPoints.length) drawVectorCluster();
  } else {
    tooltip.classList.remove('hidden');
  }
  positionClusterTooltip(hit);
}

function queueClusterCenterDrag(event) {
  const geometry = state.clusterCenterDragGeometry || state.clusterPlotGeometry;
  if (!geometry) return;
  const local = clusterCanvasCoordinates(event);
  state.clusterCenterDragPending = {
    x: (local.x - geometry.originX) / geometry.scale,
    y: (geometry.originY - local.y) / geometry.scale,
  };
  if (state.clusterCenterDragFrame) return;
  state.clusterCenterDragFrame = requestAnimationFrame(() => {
    state.clusterCenterDragFrame = 0;
    const pending = state.clusterCenterDragPending;
    state.clusterCenterDragPending = null;
    if (!pending || !state.clusterCenterDragging) return;
    setClusterCenter(pending.x, pending.y, { renderCards: false, updateVectorText: false });
  });
}

function startClusterCenterDrag(event) {
  if (event.button !== 0 || !pointerNearClusterCenter(event)) return;
  event.preventDefault();
  hideClusterTooltip();
  const canvas = $('#clusterCanvas');
  state.clusterCenterDragging = true;
  state.clusterCenterDragPointerId = event.pointerId;
  state.clusterCenterDragMoved = false;
  state.clusterCenterDragStart = clusterCanvasCoordinates(event);
  state.clusterCenterDragGeometry = { ...state.clusterPlotGeometry };
  canvas.classList.add('dragging-center');
  canvas.setPointerCapture?.(event.pointerId);
}

function moveClusterPointer(event) {
  const canvas = $('#clusterCanvas');
  if (state.clusterCenterDragging && event.pointerId === state.clusterCenterDragPointerId) {
    const local = clusterCanvasCoordinates(event);
    if (Math.hypot(local.x - state.clusterCenterDragStart.x, local.y - state.clusterCenterDragStart.y) > 3) {
      state.clusterCenterDragMoved = true;
    }
    queueClusterCenterDrag(event);
    return;
  }
  canvas.classList.toggle('center-hover', pointerNearClusterCenter(event));
  showClusterTooltip(event);
}

function finishClusterCenterDrag(event) {
  if (!state.clusterCenterDragging || event.pointerId !== state.clusterCenterDragPointerId) return;
  const canvas = $('#clusterCanvas');
  if (state.clusterCenterDragPending) {
    const pending = state.clusterCenterDragPending;
    state.clusterCenterDragPending = null;
    setClusterCenter(pending.x, pending.y, { renderCards: false, updateVectorText: false });
  }
  if (state.clusterCenterDragFrame) cancelAnimationFrame(state.clusterCenterDragFrame);
  state.clusterCenterDragFrame = 0;
  state.clusterCenterDragging = false;
  state.clusterCenterDragPointerId = null;
  state.clusterCenterDragGeometry = null;
  canvas.classList.remove('dragging-center', 'center-hover');
  try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
  recomputeClusterPointView({ updateVectorText: true });
  updateClusterThreshold({ renderCards: true });
  if (event.type === 'pointercancel') state.clusterCenterDragMoved = false;
}

function openClusterNeighborDialog(person) {
  if (!person || !state.person) return;
  state.clusterActiveNeighbor = person;
  const view = clusterNeighborViewForPoint(person);
  $('#clusterNeighborDialogThumb').src = thumbPerson(person.id, Date.now());
  $('#clusterNeighborDialogName').textContent = person.name || 'Unbenannte Person';
  $('#clusterNeighborDialogMeta').textContent = `${Number(person.faceCount || 0)} Faces mit Embedding · Distanz ${formatClusterDistance(view.distance)}${person.isHidden ? ' · verborgen' : ''}`;
  $('#clusterNeighborDialogCurrent').textContent = state.person.name || 'Aktuelle Person';
  $('#clusterNeighborDialog').showModal();
}

async function mergeClusterNeighborIntoCurrentPerson() {
  const source = state.clusterActiveNeighbor;
  const target = state.person;
  if (!source || !target) return;
  const sourceName = source.name || 'Unbenannte Person';
  const targetName = target.name || 'aktuelle Person';
  if (!window.confirm(`${sourceName} vollständig mit ${targetName} zusammenführen?\n\nAlle Face-Zuordnungen der Nachbarperson werden der aktuellen Person zugeordnet. Die Nachbarperson wird anschließend in Immich entfernt.`)) return;

  const button = $('#clusterMergeNeighborBtn');
  const original = button.textContent;
  button.disabled = true;
  $('#clusterOpenNeighborBtn').disabled = true;
  button.textContent = 'Wird zusammengeführt…';
  try {
    await api(`/review-api/people/${source.id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ targetPersonId: target.id }),
    });
    state.timelineStale = true;
    state.clusterNeighborRequestToken++;
    state.clusterNeighbors = [];
    state.clusterNeighborLoadedFor = null;
    state.clusterNeighborQueryLimit = 0;
    state.clusterNeighborAvailable = 0;
    state.clusterNeighborCandidatePool = 0;
    state.clusterNeighborView.clear();
    state.clusterNeighborPlotPoints = [];
    state.clusterActiveNeighbor = null;
    $('#clusterNeighborDialog').close();
    $('#selectedPersonThumb').src = thumbPerson(target.id, Date.now());
    toast(`${sourceName} wurde mit ${targetName} zusammengeführt`);
    await Promise.all([loadPeople(), loadVectorCluster({ force: true })]);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    $('#clusterOpenNeighborBtn').disabled = false;
    button.textContent = original;
  }
}

function selectClusterPointFromCanvas(event) {
  if (state.clusterCenterDragMoved) {
    state.clusterCenterDragMoved = false;
    return;
  }
  if (pointerNearClusterCenter(event)) return;
  const neighborHit = nearestClusterNeighborPlotPoint(event);
  if (neighborHit) {
    openClusterNeighborDialog(neighborHit.item.person);
    return;
  }
  const hit = nearestClusterPlotPoint(event);
  if (!hit) return;
  const point = hit.item.point;
  const pointMode = hit.item.outside ? 'outside' : 'inside';
  if (state.clusterListMode !== 'all' && state.clusterListMode !== pointMode) {
    setClusterListMode(pointMode);
  }
  toggleClusterSelection(point.faceId);
  const listedPoints = getClusterListedPoints();
  const index = listedPoints.findIndex((item) => item.faceId === point.faceId);
  if (index >= state.clusterVisibleCount) {
    state.clusterVisibleCount = Math.ceil((index + 1) / 80) * 80;
    renderClusterOutliers();
  }
  requestAnimationFrame(() => document.querySelector(`[data-face-id="${point.faceId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}


async function detachSelectedClusterFaces() {
  if (!state.person || !state.clusterSelected.size) return;
  const faceIds = [...state.clusterSelected];
  const count = faceIds.length;
  if (!window.confirm(`${count} ausgewählte Face-Zuordnung${count === 1 ? '' : 'en'} zu ${state.person.name || 'dieser Person'} lösen?\n\nDie Face-Markierungen und Embeddings bleiben erhalten; nur die Personenzuordnung wird entfernt.`)) return;
  const button = $('#clusterDetachSelectedBtn');
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = `Löse ${count} Zuordnungen…`;
  try {
    const result = await api(`/review-api/people/${state.person.id}/vector-cluster/unassign`, {
      method: 'POST',
      body: JSON.stringify({ faceIds }),
    });
    state.timelineStale = true;
    toast(`${result.detached || 0} Zuordnung${result.detached === 1 ? '' : 'en'} gelöst${result.skipped ? ` · ${result.skipped} übersprungen` : ''}${result.failed ? ` · ${result.failed} Fehler` : ''}`);
    await loadVectorCluster({ force: true });
  } catch (error) {
    toast(error.message);
  } finally {
    button.textContent = previous;
    updateClusterSelectionControls();
  }
}

async function copyClusterVector(selector, successMessage) {
  const textarea = $(selector);
  const value = textarea.value;
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    toast(successMessage);
  }
}

function copyClusterMean() {
  return copyClusterVector('#clusterMeanVector', 'Durchschnittsvektor kopiert');
}

function copyClusterCentroid() {
  return copyClusterVector('#clusterCentroidVector', 'Normierte Mittelrichtung μ kopiert');
}

function copyClusterActiveCenter() {
  return copyClusterVector('#clusterActiveCenterVector', 'Aktuelles Zentrum c kopiert');
}

function exportVectorCluster() {
  if (!state.cluster || !state.person) return;
  const center = describeClusterCenter(state.clusterCenter);
  const payload = {
    generatedAt: new Date().toISOString(),
    person: { id: state.person.id, name: state.person.name || '' },
    dimensions: state.cluster.dimensions,
    projection: state.cluster.projection,
    radius: state.clusterRadius,
    selectionCenter: {
      x: center.x,
      y: center.y,
      angleRadians: center.angle,
      cosineDistanceFromMean: center.radialDistance,
      vector: state.clusterActiveCenterVector,
    },
    meanVector: state.cluster.meanVector,
    meanVectorNorm: state.cluster.meanVectorNorm,
    centroid: state.cluster.centroid,
    originalStats: state.cluster.stats,
    currentStats: state.clusterDynamicStats,
    adjacentPeople: visibleClusterNeighbors().map((person) => {
      const view = clusterNeighborViewForPoint(person);
      return { ...person, reviewDistance: view.distance, reviewX: view.x, reviewY: view.y };
    }),
    points: state.cluster.points.map((point) => {
      const view = clusterViewForPoint(point);
      return { ...point, reviewDistance: view.distance, reviewX: view.x, reviewY: view.y };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `immich-vector-cluster-${state.person.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function collectBeforeBirthAssets() {
  const birthDate = state.person?.birthDate;
  if (!birthDate) return [];
  const collected = [];
  let page = 1;
  while (page != null) {
    const d = await api(`/review-api/people/${state.person.id}/assets?page=${page}&size=100&takenBefore=${encodeURIComponent(`${birthDate}T23:59:59.999Z`)}`);
    for (const asset of d.items || []) {
      const taken = asset.fileCreatedAt || asset.localDateTime || asset.createdAt;
      if (isBeforeBirth(birthDate, taken)) collected.push(asset);
    }
    page = d.nextPage;
  }
  return collected;
}

async function runBatchBeforeBirth() {
  if (!state.person?.birthDate) return toast('Für diese Person ist kein Geburtsdatum hinterlegt.');
  const button = $('#batchBeforeBirthBtn');
  if (button.dataset.running) return;
  const personId = state.person.id;
  const originalLabel = button.textContent;
  button.dataset.running = 'true';
  button.disabled = true;
  button.textContent = 'Treffer werden gesucht…';

  try {
    const assets = await collectBeforeBirthAssets();
    if (!assets.length) {
      toast('Keine Zuordnungen vor der Geburt gefunden.');
      return;
    }
    if (!window.confirm(`${assets.length} Asset${assets.length === 1 ? '' : 's'} liegen vor dem Geburtsdatum. Die Face-Markierungen bleiben erhalten; nur die Zuordnung zu ${state.person.name || 'dieser Person'} wird gelöst. Fortfahren?`)) return;

    let done = 0;
    let detached = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < assets.length) {
        const index = cursor++;
        const asset = assets[index];
        try {
          const faces = await api(`/review-api/assets/${asset.id}/faces`);
          const matching = faces.filter((f) => f.person?.id === personId || f.personId === personId);
          for (const face of matching) {
            await api(`/review-api/faces/${face.id}/unassign`, {
              method: 'POST',
              body: JSON.stringify({ assetId: asset.id }),
            });
            detached++;
          }
        } catch {
          failed++;
        } finally {
          done++;
          button.textContent = `Löse Zuordnungen ${done}/${assets.length}…`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, assets.length) }, () => worker()));

    toast(`${detached} Zuordnung${detached === 1 ? '' : 'en'} gelöst · Face-Markierungen bleiben erhalten${failed ? ` · ${failed} Fehler` : ''}`);
    await selectPerson(personId);
  } catch (e) {
    toast(e.message);
  } finally {
    delete button.dataset.running;
    button.disabled = false;
    button.textContent = originalLabel;
    updateBatchButton();
  }
}

$('#createPersonBtn').onclick = async () => {
  const name = $('#newPersonName').value.trim();
  if (!name) return toast('Bitte Namen eingeben');
  try {
    const p = await api('/review-api/people', { method: 'POST', body: JSON.stringify({ name, birthDate: $('#newPersonBirthDate').value || null }) });
    state.people.push(p);
    await reassign(p.id);
    $('#newPersonName').value = '';
    $('#newPersonBirthDate').value = '';
  } catch (e) {
    toast(e.message);
  }
};

$('#timelineViewBtn').onclick = () => setPersonView('timeline');
$('#clusterViewBtn').onclick = () => setPersonView('cluster');
$('#clusterReloadBtn').onclick = () => loadVectorCluster({ force: true });
$('#clusterRadiusRange').addEventListener('input', (event) => setClusterRadius(event.target.value, { renderCards: false }));
$('#clusterRadiusInput').addEventListener('change', (event) => setClusterRadius(event.target.value));
$('#clusterRadiusInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') setClusterRadius(event.currentTarget.value);
});
$('#clusterPresetP90').onclick = () => state.cluster && setClusterRadius(state.clusterDynamicStats?.p90Distance ?? state.cluster.stats.p90Distance);
$('#clusterPresetP95').onclick = () => state.cluster && setClusterRadius(state.clusterDynamicStats?.p95Distance ?? state.cluster.stats.p95Distance);
$('#clusterPresetImmich').onclick = () => setClusterRadius(0.5);
$('#clusterShowOutsideBtn').onclick = () => setClusterListMode('outside');
$('#clusterShowInsideBtn').onclick = () => setClusterListMode('inside');
$('#clusterShowAllBtn').onclick = () => setClusterListMode('all');
$('#clusterNeighborsEnabled').onchange = (event) => setClusterNeighborsEnabled(event.target.checked);
$('#clusterNeighborCountRange').addEventListener('input', (event) => setClusterNeighborCount(event.target.value));
$('#clusterNeighborCountInput').addEventListener('change', (event) => setClusterNeighborCount(event.target.value));
$('#clusterNeighborCountInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') setClusterNeighborCount(event.currentTarget.value);
});
$('#clusterSelectAllBtn').onclick = () => {
  for (const point of getClusterListedPoints()) state.clusterSelected.add(point.faceId);
  updateClusterSelectionControls();
  drawVectorCluster();
};
$('#clusterClearSelectionBtn').onclick = () => {
  state.clusterSelected.clear();
  updateClusterSelectionControls();
  drawVectorCluster();
};
$('#clusterDetachSelectedBtn').onclick = detachSelectedClusterFaces;
$('#clusterLoadMoreBtn').onclick = () => {
  state.clusterVisibleCount += 80;
  renderClusterOutliers();
};
$('#clusterCopyMeanBtn').onclick = copyClusterMean;
$('#clusterCopyCentroidBtn').onclick = copyClusterCentroid;
$('#clusterCopyActiveCenterBtn').onclick = copyClusterActiveCenter;
$('#clusterExportBtn').onclick = exportVectorCluster;
$('#clusterResetCenterBtn').onclick = resetClusterCenter;
$('#clusterCanvas').addEventListener('pointerdown', startClusterCenterDrag);
$('#clusterCanvas').addEventListener('pointermove', moveClusterPointer);
$('#clusterCanvas').addEventListener('pointerup', finishClusterCenterDrag);
$('#clusterCanvas').addEventListener('pointercancel', finishClusterCenterDrag);
$('#clusterCanvas').addEventListener('pointerleave', () => { if (!state.clusterCenterDragging) hideClusterTooltip(); });
$('#clusterCanvas').addEventListener('click', selectClusterPointFromCanvas);
$('#closeClusterNeighborDialog').onclick = () => $('#clusterNeighborDialog').close();
$('#clusterOpenNeighborBtn').onclick = () => {
  if (state.clusterActiveNeighbor) openImmichPerson(state.clusterActiveNeighbor.id);
};
$('#clusterMergeNeighborBtn').onclick = mergeClusterNeighborIntoCurrentPerson;

$('#batchBeforeBirthBtn').onclick = () => runBatchBeforeBirth();
$('#loadMoreBtn').onclick = () => loadNextPage();
$('#closeDialog').onclick = () => $('#reassignDialog').close();
$('#backBtn').onclick = () => {
  resetReviewState();
  resetClusterState();
  clusterResizeObserver?.disconnect();
  $('#review').classList.add('hidden');
  $('#chooser').classList.remove('hidden');
  state.person = null;
};
$('#hideReviewed').onchange = (e) => state.reviewed.forEach((id) => document.querySelector(`[data-asset="${id}"]`)?.classList.toggle('hidden', e.target.checked));

init();
