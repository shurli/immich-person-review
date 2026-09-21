import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appVersion = packageInfo.version || 'unknown';
const port = Number(process.env.PORT || 3000);
const immichUrl = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const apiPrefixRaw = process.env.IMMICH_API_PREFIX ?? '/api';
const apiPrefix = apiPrefixRaw ? '/' + apiPrefixRaw.replace(/^\/+|\/+$/g, '') : '';
const apiKey = process.env.IMMICH_API_KEY || '';
const unnamedStatsCache = new Map();
const UNNAMED_STATS_TTL_MS = 5 * 60 * 1000;

if (!immichUrl || !apiKey) {
  console.error('IMMICH_URL and IMMICH_API_KEY are required.');
  process.exit(1);
}

function immichEndpoint(p) {
  return `${immichUrl}${apiPrefix}${p}`;
}

async function immichFetch(p, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('x-api-key', apiKey);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(immichEndpoint(p), { ...options, headers, redirect: 'follow' });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function proxyJson(res, response) {
  const text = await response.text();
  if (response.status === 204 || !text) {
    res.writeHead(response.status, { 'cache-control': 'no-store' });
    return res.end();
  }
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function collectPersonAssets(personId) {
  const items = [];
  let page = 1;
  while (page != null) {
    const r = await immichFetch('/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ personIds: [personId], page, size: 100, order: 'asc', withPeople: false, withExif: false }),
    });
    if (!r.ok) {
      const error = new Error(`Immich asset search failed with HTTP ${r.status}`);
      error.response = r;
      throw error;
    }
    const data = await r.json();
    const assets = data.assets || {};
    items.push(...(assets.items || []));
    const rawNext = assets.nextPage;
    const next = rawNext == null || rawNext === '' ? null : Number(rawNext);
    page = Number.isFinite(next) ? next : null;
  }
  return items;
}

function assetDay(asset) {
  const value = asset.localDateTime || asset.fileCreatedAt || asset.createdAt;
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10) || null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getUnnamedPersonStats(personId) {
  const cached = unnamedStatsCache.get(personId);
  if (cached && Date.now() - cached.at < UNNAMED_STATS_TTL_MS) return cached.data;

  const assets = await collectPersonAssets(personId);
  const days = new Set(assets.map(assetDay).filter(Boolean));
  let faces = 0;
  let bestFaceAssetId = null;
  let bestFacePixels = -1;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, Math.max(1, assets.length)) }, async () => {
    while (cursor < assets.length) {
      const asset = assets[cursor++];
      const r = await immichFetch(`/faces?id=${encodeURIComponent(asset.id)}`);
      if (!r.ok) continue;
      const list = await r.json();
      const matching = list.filter((face) => face.person?.id === personId || face.personId === personId);
      faces += matching.length;
      for (const face of matching) {
        const width = Math.max(0, Number(face.boundingBoxX2) - Number(face.boundingBoxX1));
        const height = Math.max(0, Number(face.boundingBoxY2) - Number(face.boundingBoxY1));
        const pixels = width * height;
        if (Number.isFinite(pixels) && pixels > bestFacePixels) {
          bestFacePixels = pixels;
          bestFaceAssetId = asset.id;
        }
      }
    }
  });
  await Promise.all(workers);
  const data = { faces, days: days.size, assets: assets.length, bestFaceAssetId, bestFacePixels: Math.max(0, bestFacePixels) };
  unnamedStatsCache.set(personId, { at: Date.now(), data });
  return data;
}

async function streamImmich(res, response, cache = true) {
  if (!response.ok) return proxyJson(res, response);
  const headers = {
    'content-type': response.headers.get('content-type') || 'application/octet-stream',
    'cache-control': cache ? 'private, max-age=3600' : 'no-store',
  };
  const length = response.headers.get('content-length');
  if (length) headers['content-length'] = length;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/review-api/status') {
      const r = await immichFetch('/api-keys/me');
      if (!r.ok) return proxyJson(res, r);
      const keyInfo = await r.json();
      return json(res, 200, { ok: true, keyName: keyInfo.name || 'API key', immichUrl, version: appVersion });
    }

    if (req.method === 'GET' && url.pathname === '/review-api/people') {
      const page = url.searchParams.get('page') || '1';
      const size = url.searchParams.get('size') || '100';
      const withHidden = url.searchParams.get('withHidden') || 'false';
      return proxyJson(res, await immichFetch(`/people?page=${encodeURIComponent(page)}&size=${encodeURIComponent(size)}&withHidden=${encodeURIComponent(withHidden)}`));
    }

    if (req.method === 'GET' && url.pathname === '/review-api/people/search') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return json(res, 200, []);
      return proxyJson(res, await immichFetch(`/search/person?name=${encodeURIComponent(q)}&withHidden=true`));
    }

    const personMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && personMatch) {
      return proxyJson(res, await immichFetch(`/people/${personMatch[1]}`));
    }

    const unnamedStatsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/review-stats$/i);
    if (req.method === 'GET' && unnamedStatsMatch) {
      try {
        return json(res, 200, await getUnnamedPersonStats(unnamedStatsMatch[1]));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
    }

    const refreshPersonThumbMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/refresh-thumbnail$/i);
    if (req.method === 'POST' && refreshPersonThumbMatch) {
      const id = refreshPersonThumbMatch[1];
      let stats;
      try {
        stats = await getUnnamedPersonStats(id);
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
      if (!stats.bestFaceAssetId) return json(res, 404, { message: 'Kein zugeordnetes Face für diese Person gefunden' });

      // featureFaceAssetId is the official Immich API field for selecting the person's feature thumbnail.
      // As of the current API it is exposed on PUT /people/{id}.
      const r = await immichFetch(`/people/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ featureFaceAssetId: stats.bestFaceAssetId }),
      });
      if (!r.ok) return proxyJson(res, r);
      unnamedStatsCache.delete(id);
      const result = await r.json();
      return json(res, 200, { ok: true, person: result, assetId: stats.bestFaceAssetId, facePixels: stats.bestFacePixels });
    }

    const hidePersonMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/hide$/i);
    if (req.method === 'PUT' && hidePersonMatch) {
      const id = hidePersonMatch[1];
      const r = await immichFetch('/people', {
        method: 'PUT',
        body: JSON.stringify({ people: [{ id, isHidden: true }] }),
      });
      if (r.ok) unnamedStatsCache.delete(id);
      return proxyJson(res, r);
    }

    const mergePersonMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/merge$/i);
    if (req.method === 'POST' && mergePersonMatch) {
      const sourceId = mergePersonMatch[1];
      const body = await parseBody(req);
      if (!body.targetPersonId) return json(res, 400, { message: 'targetPersonId is required' });
      if (body.targetPersonId === sourceId) return json(res, 400, { message: 'Quelle und Ziel duerfen nicht identisch sein' });
      const r = await immichFetch(`/people/${encodeURIComponent(body.targetPersonId)}/merge`, {
        method: 'POST',
        body: JSON.stringify({ ids: [sourceId] }),
      });
      if (r.ok) {
        unnamedStatsCache.delete(sourceId);
        unnamedStatsCache.delete(body.targetPersonId);
      }
      return proxyJson(res, r);
    }

    const assetsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/assets$/i);
    if (req.method === 'GET' && assetsMatch) {
      const personId = assetsMatch[1];
      const requestedPage = Number(url.searchParams.get('page') || '1');
      const requestedSize = Number(url.searchParams.get('size') || '40');
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const size = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 100) : 40;

      const takenBefore = url.searchParams.get('takenBefore');
      const searchBody = {
        personIds: [personId],
        page,
        size,
        order: 'asc',
        withPeople: false,
        withExif: false,
      };
      if (takenBefore) searchBody.takenBefore = takenBefore;

      const r = await immichFetch('/search/metadata', {
        method: 'POST',
        body: JSON.stringify(searchBody),
      });
      if (!r.ok) return proxyJson(res, r);

      const data = await r.json();
      const assets = data.assets || {};
      const items = assets.items || [];
      const rawNextPage = assets.nextPage;
      const nextPage = rawNextPage == null || rawNextPage === '' ? null : Number(rawNextPage);
      const total = Number.isFinite(Number(assets.total)) ? Number(assets.total) : null;

      return json(res, 200, {
        items,
        page,
        size,
        nextPage: Number.isFinite(nextPage) ? nextPage : null,
        total,
      });
    }

    const facesMatch = url.pathname.match(/^\/review-api\/assets\/([0-9a-f-]+)\/faces$/i);
    if (req.method === 'GET' && facesMatch) {
      // Immich GET /faces expects the asset UUID in the required `id` query parameter.
      return proxyJson(res, await immichFetch(`/faces?id=${encodeURIComponent(facesMatch[1])}`));
    }

    const thumbMatch = url.pathname.match(/^\/review-api\/assets\/([0-9a-f-]+)\/thumbnail$/i);
    if (req.method === 'GET' && thumbMatch) {
      const size = url.searchParams.get('size') || 'preview';
      return streamImmich(res, await immichFetch(`/assets/${thumbMatch[1]}/thumbnail?size=${encodeURIComponent(size)}`));
    }

    const pthumbMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/thumbnail$/i);
    if (req.method === 'GET' && pthumbMatch) {
      return streamImmich(res, await immichFetch(`/people/${pthumbMatch[1]}/thumbnail`));
    }

    const reassignMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)\/reassign$/i);
    if (req.method === 'PUT' && reassignMatch) {
      const body = await parseBody(req);
      if (!body.personId) return json(res, 400, { message: 'personId is required' });
      return proxyJson(res, await immichFetch(`/faces/${body.personId}`, {
        method: 'PUT',
        body: JSON.stringify({ id: reassignMatch[1] }),
      }));
    }

    const unassignFaceMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)\/unassign$/i);
    if (req.method === 'POST' && unassignFaceMatch) {
      const faceId = unassignFaceMatch[1];
      const body = await parseBody(req);
      if (!body.assetId) return json(res, 400, { message: 'assetId is required' });

      // Immich currently has no public endpoint that directly sets one face's person to null.
      // API-only workaround: move the face to a temporary hidden person, then delete that person.
      // Immich keeps the face record and clears its person relationship when the person is deleted.
      let temporaryPersonId = null;
      try {
        const create = await immichFetch('/people', {
          method: 'POST',
          body: JSON.stringify({
            name: `__immich_review_unassign_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            birthDate: null,
            isHidden: true,
            isFavorite: false,
          }),
        });
        if (!create.ok) return proxyJson(res, create);
        const temporaryPerson = await create.json();
        temporaryPersonId = temporaryPerson.id;

        const move = await immichFetch(`/faces/${temporaryPersonId}`, {
          method: 'PUT',
          body: JSON.stringify({ id: faceId }),
        });
        if (!move.ok) {
          await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' });
          temporaryPersonId = null;
          return proxyJson(res, move);
        }

        const removeTemporaryPerson = await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' });
        temporaryPersonId = null;
        if (!removeTemporaryPerson.ok) return proxyJson(res, removeTemporaryPerson);

        const verify = await immichFetch(`/faces?id=${encodeURIComponent(body.assetId)}`);
        if (!verify.ok) return proxyJson(res, verify);
        const faces = await verify.json();
        const detached = faces.find((face) => face.id === faceId);
        if (!detached) return json(res, 409, { message: 'Zuordnung gelöst, aber Immich liefert die Face-Markierung danach nicht mehr zurück.' });
        if (detached.person != null || detached.personId != null) return json(res, 409, { message: 'Face ist noch einer Person zugeordnet.' });
        return json(res, 200, { ok: true, face: detached });
      } catch (error) {
        if (temporaryPersonId) {
          try { await immichFetch(`/people/${temporaryPersonId}`, { method: 'DELETE' }); } catch {}
        }
        throw error;
      }
    }

    const deleteFaceMatch = url.pathname.match(/^\/review-api\/faces\/([0-9a-f-]+)$/i);
    if (req.method === 'DELETE' && deleteFaceMatch) {
      // Immich has no stable "unassign person" endpoint. Deleting the face removes
      // this face marker/association from the asset without assigning another person.
      return proxyJson(res, await immichFetch(`/faces/${deleteFaceMatch[1]}`, {
        method: 'DELETE',
        body: JSON.stringify({ force: true }),
      }));
    }

    if (req.method === 'POST' && url.pathname === '/review-api/people') {
      const body = await parseBody(req);
      if (!body.name?.trim()) return json(res, 400, { message: 'name is required' });
      return proxyJson(res, await immichFetch('/people', {
        method: 'POST',
        body: JSON.stringify({ name: body.name.trim(), birthDate: body.birthDate || null, isHidden: false, isFavorite: false }),
      }));
    }

    return json(res, 404, { message: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { message: error.message || 'Internal error' });
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^\.\.(\/|\\|$)/, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir)) return json(res, 403, { message: 'Forbidden' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(publicDir, 'index.html');
      return fs.createReadStream(fallback).pipe(res.writeHead(200, { 'content-type': mime['.html'] }));
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/review-api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
}).listen(port, '0.0.0.0', () => {
  console.log(`Immich Person Review v${appVersion}`);
  console.log(`Listening on :${port}`);
  console.log(`Immich endpoint: ${immichUrl}${apiPrefix}`);
});
