import { createTagManager } from './tags.js';
const $ = (selector) => document.querySelector(selector);
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 4000);
}
const manager = createTagManager({ api, toast });
manager.init();
manager.load().catch((error) => { $('#tagTree').textContent = error.message; toast(error.message); });
// Local taxonomy editing does not depend on Immich/ML/DB availability.
api('/tag-api/status').then((status) => {
  $('#appVersion').textContent = `v${status.version}`;
  const ready = status.immich.reachable && status.tagDatabase.schemaReady;
  $('#status').textContent = ready ? 'Immich und Datenbank bereit' : 'Lokale Bearbeitung bereit';
  $('#status').className = `status ${ready ? 'ok' : ''}`;
  $('#connectionInfo').textContent = ready
    ? 'Preview verwendet Smart-Search-Embeddings; der ML-Dienst wird beim Laden der Preview geprueft.'
    : [status.immich.message, status.tagDatabase.message, 'Fuer Previews Immich, PostgreSQL und Machine Learning konfigurieren.'].filter(Boolean).join(' ');
}).catch((error) => { $('#status').textContent = 'Status nicht erreichbar'; toast(error.message); });
