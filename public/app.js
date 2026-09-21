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
};

let faceObserver;
let pageObserver;

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

function thumbPerson(id) { return `/review-api/people/${id}/thumbnail`; }
function thumbAsset(id) { return `/review-api/assets/${id}/thumbnail?size=preview`; }

async function init() {
  try {
    const s = await api('/review-api/status');
    $('#appVersion').textContent = s.version ? `v${s.version}` : 'v?';
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
  } catch (e) {
    $('#people').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function renderPeople(people) {
  $('#people').innerHTML = people.map((p) => `<button class="person-card" data-person="${p.id}"><img class="person-avatar" loading="lazy" src="${thumbPerson(p.id)}" alt=""><div class="person-name">${esc(p.name || 'Unbenannt')}</div><div class="muted">${p.birthDate ? `geb. ${fmtDate(p.birthDate)}` : 'kein Geburtsdatum'}</div></button>`).join('') || '<div class="muted">Keine Personen.</div>';
  document.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => selectPerson(b.dataset.person); });
}

$('#personSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderPeople(!q ? state.people : state.people.filter((p) => (p.name || '').toLowerCase().includes(q)));
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
  $('#timeline').innerHTML = '<div class="panel loading initial-loading">Erste Assets werden geladen…</div>';

  try {
    state.person = await api(`/review-api/people/${id}`);
    $('#selectedPersonName').textContent = state.person.name || 'Unbenannt';
    $('#selectedPersonThumb').src = thumbPerson(id);
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
  button.classList.toggle('hidden', !hasBirthDate);
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
    card.innerHTML = `<div class="full-wrap"><img class="full-photo" loading="lazy" src="${thumbAsset(asset.id)}" alt="${esc(asset.originalFileName || 'Asset')}"><div class="face-box hidden"></div></div><aside class="side"><canvas class="crop" width="500" height="500"></canvas><div><div class="date">${fmtDate(taken)}</div><div class="age">${ageAt(state.person.birthDate, taken)}</div><div class="muted">${esc(asset.originalFileName || '')}${asset.type ? ` · ${esc(asset.type === 'VIDEO' ? 'Video' : asset.type === 'IMAGE' ? 'Bild' : asset.type)}` : ''}</div></div><div class="face-state muted">Gesicht wird bei Bedarf geladen…</div><div class="actions"><button class="btn warn reassign" disabled>Falsche Zuordnung ändern</button><button class="btn detach detach-face" disabled>Zuordnung lösen</button><button class="btn remove remove-face" disabled>Markierung entfernen</button><span class="badge ok-badge hidden">Korrigiert</span></div></aside>`;
    tl.appendChild(card);
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
  const fw = face.boundingBoxX2 - face.boundingBoxX1;
  const fh = face.boundingBoxY2 - face.boundingBoxY1;
  const side = Math.max(fw, fh) * 1.75;
  const cx = (face.boundingBoxX1 + face.boundingBoxX2) / 2;
  const cy = (face.boundingBoxY1 + face.boundingBoxY2) / 2;
  const x = Math.max(0, cx - side / 2);
  const y = Math.max(0, cy - side / 2);
  const w = Math.min(side, face.imageWidth - x);
  const h = Math.min(side, face.imageHeight - y);
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

$('#batchBeforeBirthBtn').onclick = () => runBatchBeforeBirth();
$('#loadMoreBtn').onclick = () => loadNextPage();
$('#closeDialog').onclick = () => $('#reassignDialog').close();
$('#backBtn').onclick = () => {
  resetReviewState();
  $('#review').classList.add('hidden');
  $('#chooser').classList.remove('hidden');
  state.person = null;
};
$('#hideReviewed').onchange = (e) => state.reviewed.forEach((id) => document.querySelector(`[data-asset="${id}"]`)?.classList.toggle('hidden', e.target.checked));

init();
