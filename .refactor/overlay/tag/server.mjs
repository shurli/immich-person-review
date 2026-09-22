import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createTaxonomyStore, validateTagTaxonomy } from './taxonomy-store.mjs';
import { createTagPreview } from './tag-preview.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.PORT || 3000);
const taxonomyPath = path.resolve(process.env.TAG_TAXONOMY_PATH || path.join(root, 'storage/tags.json'));
const defaultPath = path.resolve(process.env.TAG_TAXONOMY_DEFAULT_PATH || path.join(root, 'data/tags.json'));
const store = createTaxonomyStore(taxonomyPath, defaultPath);
const immichUrl = (process.env.IMMICH_URL || '').replace(/\/+$/, '');
const externalUrl = (process.env.IMMICH_EXTERNAL_URL || immichUrl).replace(/\/+$/, '');
const prefixRaw = process.env.IMMICH_API_PREFIX ?? '/api';
const apiPrefix = prefixRaw ? `/${prefixRaw.replace(/^\/+|\/+$/g, '')}` : '';
const apiKey = process.env.IMMICH_API_KEY || '';
const mlUrl = (process.env.IMMICH_MACHINE_LEARNING_URL || 'http://immich-machine-learning:3003').replace(/\/?$/, '/');
const dbUrl = process.env.IMMICH_DB_URL || '';
const dbHost = process.env.IMMICH_DB_HOST || process.env.DB_HOSTNAME || '';
const dbConfigured = Boolean(dbUrl || dbHost);
const pool = dbConfigured ? new Pool({
  ...(dbUrl ? { connectionString: dbUrl } : {
    host: dbHost,
    port: Number(process.env.IMMICH_DB_PORT || process.env.DB_PORT || 5432),
    user: process.env.IMMICH_DB_USER || process.env.DB_USERNAME || 'immich_tag_manager',
    password: process.env.IMMICH_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '',
    database: process.env.IMMICH_DB_NAME || process.env.DB_DATABASE_NAME || 'immich',
  }),
  ssl: /^(1|true|yes|required)$/i.test(process.env.IMMICH_DB_SSL || '') ? { rejectUnauthorized: true } : undefined,
  application_name: 'immich-tag-manager',
  options: '-c default_transaction_read_only=on',
  max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, statement_timeout: 60000,
}) : null;
pool?.on('error', (error) => console.error('PostgreSQL pool:', error.message));

function fail(status, message) { return Object.assign(new Error(message), { status }); }
async function immichFetch(route) {
  if (!immichUrl || !apiKey) throw fail(503, 'IMMICH_URL und IMMICH_API_KEY fehlen. Die lokale Tag-Bearbeitung ist weiterhin verfuegbar.');
  return fetch(`${immichUrl}${apiPrefix}${route}`, {
    headers: { 'x-api-key': apiKey }, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
}
async function getOwnerId() {
  const response = await immichFetch('/users/me');
  if (!response.ok) throw fail(response.status, `Immich-Benutzer konnte nicht gelesen werden (HTTP ${response.status}); user.read pruefen.`);
  const user = await response.json();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id || '')) throw fail(502, 'Immich liefert keine gueltige Benutzer-ID.');
  return user.id;
}
const preview = createTagPreview({
  getPool: () => { if (!pool) throw fail(503, 'PostgreSQL fuer die Tag-Preview fehlt. IMMICH_DB_URL oder IMMICH_DB_HOST konfigurieren.'); return pool; },
  getOwnerId, readTagTaxonomy: store.read, immichMachineLearningUrl: mlUrl,
});

async function databaseInfo() {
  const info = { configured: dbConfigured, reachable: null, schemaReady: null };
  if (!pool) return info;
  try {
    await pool.query('SELECT 1');
    info.reachable = true;
    await pool.query(`SELECT ss."assetId", ss.embedding::text, a."ownerId", a.visibility,
      a."originalFileName", a."fileCreatedAt", a."localDateTime", a."createdAt", a."deletedAt"
      FROM smart_search ss JOIN asset a ON a.id = ss."assetId" LIMIT 0`);
    info.schemaReady = true;
  } catch (error) {
    info.reachable ??= false;
    info.schemaReady = false;
    info.message = info.reachable ? 'Smart-Search-Schema oder SELECT-Rechte fehlen.' : 'PostgreSQL ist nicht erreichbar.';
    console.error('Tag database check:', error.message);
  }
  return info;
}
async function statusInfo() {
  const immich = { configured: Boolean(immichUrl && apiKey), reachable: null };
  if (immich.configured) {
    try { await getOwnerId(); immich.reachable = true; }
    catch (error) { immich.reachable = false; immich.message = error.message; }
  }
  return { ok: true, app: 'immich-tag-manager', version, immichExternalUrl: externalUrl, immich, tagDatabase: await databaseInfo() };
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function parseBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Content-Type application/json erforderlich.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw fail(413, 'JSON ist groesser als 2 MiB.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail(400, 'Ungueltiges JSON-Objekt.'); }
}
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/tag-api/status') return json(res, 200, await statusInfo());
  if (req.method === 'GET' && url.pathname === '/tag-api/tags') return json(res, 200, { document: store.read(), path: taxonomyPath, writable: true, warnings: store.warnings() });
  if (req.method === 'PUT' && url.pathname === '/tag-api/tags') {
    const body = await parseBody(req);
    const document = body.document ?? body;
    try { validateTagTaxonomy(document); } catch (error) { throw fail(400, error.message); }
    return json(res, 200, { ok: true, document: store.write(document), path: taxonomyPath });
  }
  const match = url.pathname.match(/^\/tag-api\/tags\/([^/]+)\/calibration-preview$/);
  if (req.method === 'POST' && match) {
    const body = await parseBody(req);
    const id = decodeURIComponent(match[1]);
    const concept = body.concept?.id === id ? body.concept : store.read().concepts.find((item) => item.id === id);
    if (!concept) throw fail(404, 'Tag nicht gefunden.');
    if (!Array.isArray(concept.prompts_en) || !concept.prompts_en.length || concept.prompts_en.length > 64 || concept.prompts_en.some((p) => typeof p !== 'string' || !p.trim() || p.length > 4096)) throw fail(400, 'Ein Tag benoetigt 1 bis 64 Text-Prompts mit maximal 4096 Zeichen.');
    return json(res, 200, await preview(concept, body));
  }
  const thumb = url.pathname.match(/^\/tag-api\/assets\/([0-9a-f-]+)\/thumbnail$/i);
  if (req.method === 'GET' && thumb) {
    const size = url.searchParams.get('size') || 'preview';
    if (!['preview', 'thumbnail'].includes(size)) throw fail(400, 'Ungueltige Thumbnail-Groesse.');
    const response = await immichFetch(`/assets/${thumb[1]}/thumbnail?size=${size}`);
    if (!response.ok) return json(res, response.status, { message: `Immich Thumbnail: HTTP ${response.status}` });
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    return res.end();
  }
  return json(res, 404, { message: 'Not found' });
}
const staticFiles = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/tags.js': 'tags.js', '/styles.css': 'styles.css' };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, app: 'immich-tag-manager', version });
    if (url.pathname.startsWith('/tag-api/')) return await handleApi(req, res, url);
    const filename = staticFiles[url.pathname];
    if (req.method !== 'GET' || !filename) return json(res, 404, { message: 'Not found' });
    const content = await fs.promises.readFile(path.join(root, 'public', filename));
    res.writeHead(200, { 'content-type': mime[path.extname(filename)], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(content);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    console.error(error.message);
    const status = error.status || (error instanceof URIError ? 400 : String(error.code || '').startsWith('42') ? 503 : 500);
    return json(res, status, { message: error.status ? error.message : status === 503 ? 'Smart-Search-Schema oder Datenbankrechte passen nicht.' : 'Anfrage fehlgeschlagen; Server-Log pruefen.' });
  }
});
server.listen(port, '0.0.0.0', () => console.log(`Immich Tag Manager v${version} listening on :${server.address().port}`));
async function shutdown() {
  server.close();
  server.closeAllConnections();
  await pool?.end();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
