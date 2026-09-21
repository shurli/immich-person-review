import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildVectorCluster, projectEmbeddingToCluster } from './cluster-math.mjs';
import { parseVector, cosineSimilarity, aggregatePromptScores } from './tag-calibration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appVersion = packageInfo.version || 'unknown';
const tagTaxonomyPath = path.resolve(process.env.TAG_TAXONOMY_PATH || path.join(__dirname, 'data', 'tags.json'));
const tagTaxonomyBackupPath = `${tagTaxonomyPath}.bak`;
const port = Number(process.env.PORT || 3000);
const immichUrl = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const immichExternalUrl = (process.env.IMMICH_EXTERNAL_URL || immichUrl).replace(/\/$/, '');
const apiPrefixRaw = process.env.IMMICH_API_PREFIX ?? '/api';
const apiPrefix = apiPrefixRaw ? '/' + apiPrefixRaw.replace(/^\/+|\/+$/g, '') : '';
const apiKey = process.env.IMMICH_API_KEY || '';
const immichMachineLearningUrl = (process.env.IMMICH_MACHINE_LEARNING_URL || 'http://immich-machine-learning:3003').replace(/\/?$/, '/');
const tagTextEmbeddingCache = new Map();
const unnamedStatsCache = new Map();
const UNNAMED_STATS_TTL_MS = 5 * 60 * 1000;
const duplicateFaceScans = new Map();
const DUPLICATE_SCAN_TTL_MS = 15 * 60 * 1000;
const adjacentPersonCache = new Map();
const ADJACENT_PERSON_TTL_MS = 2 * 60 * 1000;

const immichDbUrl = process.env.IMMICH_DB_URL || '';
const immichDbHost = process.env.IMMICH_DB_HOST || process.env.DB_HOSTNAME || '';
const immichDbPort = Number(process.env.IMMICH_DB_PORT || process.env.DB_PORT || 5432);
const immichDbUser = process.env.IMMICH_DB_USER || process.env.DB_USERNAME || 'postgres';
const immichDbPassword = process.env.IMMICH_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '';
const immichDbName = process.env.IMMICH_DB_NAME || process.env.DB_DATABASE_NAME || 'immich';
const immichDbSsl = /^(1|true|yes|required)$/i.test(process.env.IMMICH_DB_SSL || '');
const vectorDbConfigured = Boolean(immichDbUrl || immichDbHost);
const vectorClusterMaxFacesValue = Number(process.env.VECTOR_CLUSTER_MAX_FACES || 30000);
const vectorClusterMaxFaces = Number.isFinite(vectorClusterMaxFacesValue) ? Math.max(100, vectorClusterMaxFacesValue) : 30000;
const vectorClusterMaxAdjacentPeopleValue = Number(process.env.VECTOR_CLUSTER_MAX_ADJACENT_PEOPLE || 50);
const vectorClusterMaxAdjacentPeople = Number.isFinite(vectorClusterMaxAdjacentPeopleValue)
  ? Math.min(200, Math.max(1, Math.floor(vectorClusterMaxAdjacentPeopleValue)))
  : 50;
const vectorClusterAdjacentCandidatePoolValue = Number(process.env.VECTOR_CLUSTER_ADJACENT_CANDIDATE_POOL || 500);
const vectorClusterAdjacentCandidatePool = Number.isFinite(vectorClusterAdjacentCandidatePoolValue)
  ? Math.min(1000, Math.max(vectorClusterMaxAdjacentPeople + 1, Math.floor(vectorClusterAdjacentCandidatePoolValue)))
  : 500;
const vectorClusterDefaultRadiusRaw = process.env.VECTOR_CLUSTER_DEFAULT_RADIUS;
const vectorClusterDefaultRadius = vectorClusterDefaultRadiusRaw == null || vectorClusterDefaultRadiusRaw === ''
  ? undefined
  : Number(vectorClusterDefaultRadiusRaw);
const vectorPool = vectorDbConfigured
  ? new Pool({
      ...(immichDbUrl
        ? { connectionString: immichDbUrl }
        : {
            host: immichDbHost,
            port: Number.isFinite(immichDbPort) ? immichDbPort : 5432,
            user: immichDbUser,
            password: immichDbPassword,
            database: immichDbName,
          }),
      ssl: immichDbSsl ? { rejectUnauthorized: false } : undefined,
      application_name: 'immich-person-review-vector-cluster',
      max: 3,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      statement_timeout: 60000,
    })
  : null;

vectorPool?.on('error', (error) => console.error('Immich PostgreSQL pool error:', error));

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

async function vectorDatabaseInfo({ probe = false } = {}) {
  const info = {
    configured: vectorDbConfigured,
    reachable: null,
    host: immichDbUrl ? 'connection-string' : (immichDbHost || null),
    port: immichDbUrl ? null : (Number.isFinite(immichDbPort) ? immichDbPort : 5432),
    database: immichDbUrl ? null : immichDbName,
    maxFaces: vectorClusterMaxFaces,
    maxAdjacentPeople: vectorClusterMaxAdjacentPeople,
    adjacentCandidatePool: vectorClusterAdjacentCandidatePool,
  };
  if (!probe || !vectorPool) return info;
  try {
    const result = await vectorPool.query(`SELECT current_database() AS database, current_user AS "user"`);
    info.reachable = true;
    info.database = result.rows[0]?.database || info.database;
    info.user = result.rows[0]?.user || null;
    try {
      await vectorPool.query(
        `SELECT af.id, af."assetId", af."personId", fs.embedding::text, a."originalFileName"
           FROM asset_face af
           LEFT JOIN face_search fs ON fs."faceId" = af.id
           JOIN asset a ON a.id = af."assetId"
          LIMIT 0`,
      );
      info.schemaReady = true;
    } catch (schemaError) {
      info.schemaReady = false;
      info.schemaError = schemaError.message;
    }
  } catch (error) {
    info.reachable = false;
    info.schemaReady = false;
    info.error = error.message;
  }
  return info;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function requireVectorDatabase() {
  if (!vectorPool) {
    const error = new Error('PostgreSQL-Zugriff für Vektor-Cluster ist nicht konfiguriert. Setze IMMICH_DB_URL oder IMMICH_DB_HOST sowie die DB-Zugangsdaten.');
    error.status = 503;
    error.code = 'VECTOR_DB_NOT_CONFIGURED';
    throw error;
  }
  return vectorPool;
}

async function verifyPersonAccess(personId) {
  const response = await immichFetch(`/people/${encodeURIComponent(personId)}`);
  if (!response.ok) {
    const error = new Error(`Immich verweigert den Zugriff auf die Person (${response.status}).`);
    error.response = response;
    throw error;
  }
  return response.json();
}

async function loadPersonVectorRows(personId) {
  const pool = requireVectorDatabase();
  const countResult = await pool.query(
    `SELECT count(*)::int AS count
       FROM asset_face af
       JOIN asset a ON a.id = af."assetId"
      WHERE af."personId" = $1::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL`,
    [personId],
  );
  const totalAssignedFaces = Number(countResult.rows[0]?.count || 0);
  if (totalAssignedFaces > vectorClusterMaxFaces) {
    const error = new Error(`Diese Person hat ${totalAssignedFaces} Faces. Das konfigurierte Cluster-Limit liegt bei ${vectorClusterMaxFaces}. Erhöhe VECTOR_CLUSTER_MAX_FACES bewusst, wenn genügend Arbeitsspeicher vorhanden ist.`);
    error.status = 413;
    error.code = 'VECTOR_CLUSTER_TOO_LARGE';
    throw error;
  }

  const result = await pool.query(
    `SELECT
        af.id AS "faceId",
        af."assetId",
        af."personId",
        af."imageWidth",
        af."imageHeight",
        af."boundingBoxX1",
        af."boundingBoxY1",
        af."boundingBoxX2",
        af."boundingBoxY2",
        fs.embedding::text AS embedding,
        a."originalFileName",
        a."fileCreatedAt",
        a."localDateTime",
        a."createdAt"
       FROM asset_face af
       LEFT JOIN face_search fs ON fs."faceId" = af.id
       JOIN asset a ON a.id = af."assetId"
      WHERE af."personId" = $1::uuid
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL
      ORDER BY a."fileCreatedAt" ASC, af.id ASC`,
    [personId],
  );
  return { rows: result.rows, totalAssignedFaces };
}

async function getPersonVectorCluster(personId) {
  const person = await verifyPersonAccess(personId);
  const { rows, totalAssignedFaces } = await loadPersonVectorRows(personId);
  const cluster = buildVectorCluster(rows, {
    seed: personId,
    defaultRadius: Number.isFinite(vectorClusterDefaultRadius) ? vectorClusterDefaultRadius : undefined,
  });
  return {
    person: { id: person.id, name: person.name || '' },
    totalAssignedFaces,
    facesWithEmbedding: cluster.points.length,
    facesWithoutEmbedding: Math.max(0, totalAssignedFaces - cluster.points.length),
    ...cluster,
    presets: {
      p90: cluster.stats.p90Distance,
      p95: cluster.stats.p95Distance,
      immichDefault: 0.5,
    },
  };
}

async function loadClosestPersonCandidates(personId) {
  const response = await immichFetch(
    `/people?page=1&size=${encodeURIComponent(vectorClusterAdjacentCandidatePool)}&withHidden=true&closestPersonId=${encodeURIComponent(personId)}`,
  );
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Angrenzende Personen konnten nicht von Immich geladen werden: HTTP ${response.status} ${text.slice(0, 250)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const people = Array.isArray(data) ? data : (Array.isArray(data.people) ? data.people : []);
  return people.filter((person) => person?.id && person.id !== personId);
}

async function loadAdjacentPersonCentroids(personIds) {
  const pool = requireVectorDatabase();
  if (!personIds.length) return [];
  const result = await pool.query(
    `SELECT
        af."personId",
        count(*)::int AS "faceCount",
        avg(fs.embedding)::text AS embedding
       FROM asset_face af
       JOIN face_search fs ON fs."faceId" = af.id
       JOIN asset a ON a.id = af."assetId"
      WHERE af."personId" = ANY($1::uuid[])
        AND af."deletedAt" IS NULL
        AND af."isVisible" IS TRUE
        AND a."deletedAt" IS NULL
      GROUP BY af."personId"`,
    [personIds],
  );
  return result.rows;
}

async function getAdjacentPeople(personId, requestedLimit, { force = false } = {}) {
  const now = Date.now();
  for (const [key, value] of adjacentPersonCache) {
    if (now - value.createdAt >= ADJACENT_PERSON_TTL_MS) adjacentPersonCache.delete(key);
  }
  const limit = Math.min(
    vectorClusterMaxAdjacentPeople,
    Math.max(1, Number.isFinite(Number(requestedLimit)) ? Math.floor(Number(requestedLimit)) : 8),
  );
  const cached = adjacentPersonCache.get(personId);
  if (!force && cached && now - cached.createdAt < ADJACENT_PERSON_TTL_MS) {
    return {
      person: cached.person,
      limit,
      candidatePool: cached.candidatePool,
      available: cached.people.length,
      people: cached.people.slice(0, limit),
      cached: true,
    };
  }

  const cluster = await getPersonVectorCluster(personId);
  if (!cluster.points.length) {
    return {
      person: cluster.person,
      limit,
      candidatePool: 0,
      available: 0,
      people: [],
      cached: false,
    };
  }

  const candidates = await loadClosestPersonCandidates(personId);
  const metadata = new Map(candidates.map((person) => [person.id, person]));
  const centroids = await loadAdjacentPersonCentroids([...metadata.keys()]);
  const people = [];
  for (const row of centroids) {
    const person = metadata.get(row.personId);
    if (!person || !row.embedding) continue;
    try {
      people.push(projectEmbeddingToCluster(row.embedding, cluster, {
        id: person.id,
        name: person.name || '',
        birthDate: person.birthDate || null,
        isHidden: Boolean(person.isHidden),
        isFavorite: Boolean(person.isFavorite),
        faceCount: Number(row.faceCount || 0),
      }));
    } catch (error) {
      console.warn(`Adjacent person ${person.id} skipped:`, error.message);
    }
  }
  people.sort((a, b) => a.distance - b.distance || String(a.name).localeCompare(String(b.name), 'de'));

  const cacheEntry = {
    createdAt: Date.now(),
    person: cluster.person,
    candidatePool: candidates.length,
    people,
  };
  adjacentPersonCache.set(personId, cacheEntry);
  while (adjacentPersonCache.size > 24) {
    adjacentPersonCache.delete(adjacentPersonCache.keys().next().value);
  }
  return {
    person: cluster.person,
    limit,
    candidatePool: candidates.length,
    available: people.length,
    people: people.slice(0, limit),
    cached: false,
  };
}

function invalidateAdjacentPeople() {
  adjacentPersonCache.clear();
}

async function validateClusterFaceIds(personId, faceIds) {
  const pool = requireVectorDatabase();
  const unique = [...new Set((faceIds || []).map(String))];
  if (!unique.length) return [];
  const result = await pool.query(
    `SELECT id, "assetId"
       FROM asset_face
      WHERE "personId" = $1::uuid
        AND id = ANY($2::uuid[])
        AND "deletedAt" IS NULL
        AND "isVisible" IS TRUE`,
    [personId, unique],
  );
  return result.rows.map((row) => ({ faceId: row.id, assetId: row.assetId }));
}

async function unassignFacesWithTemporaryPerson(items) {
  if (!items.length) return { requested: 0, moved: 0, detached: 0, failed: 0, failures: [], detachedFaceIds: [] };
  let temporaryPersonId = null;
  const movedFaceIds = [];
  const failures = [];
  try {
    const create = await immichFetch('/people', {
      method: 'POST',
      body: JSON.stringify({
        name: `__immich_review_cluster_unassign_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        birthDate: null,
        isHidden: true,
        isFavorite: false,
      }),
    });
    if (!create.ok) {
      const text = await create.text();
      const error = new Error(`Temporäre Person konnte nicht erstellt werden: HTTP ${create.status} ${text.slice(0, 250)}`);
      error.status = create.status;
      throw error;
    }
    temporaryPersonId = (await create.json()).id;

    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          const move = await immichFetch(`/faces/${encodeURIComponent(temporaryPersonId)}`, {
            method: 'PUT',
            body: JSON.stringify({ id: item.faceId }),
          });
          if (!move.ok) {
            const text = await move.text();
            failures.push({ faceId: item.faceId, assetId: item.assetId, status: move.status, message: text.slice(0, 300) });
          } else {
            movedFaceIds.push(item.faceId);
          }
        } catch (error) {
          failures.push({ faceId: item.faceId, assetId: item.assetId, status: 0, message: error.message });
        }
      }
    });
    await Promise.all(workers);

    const removeTemporaryPerson = await immichFetch(`/people/${encodeURIComponent(temporaryPersonId)}`, { method: 'DELETE' });
    if (!removeTemporaryPerson.ok) {
      const text = await removeTemporaryPerson.text();
      const error = new Error(`Temporäre Person konnte nicht gelöscht werden. ${movedFaceIds.length} Faces sind ihr weiterhin zugeordnet: HTTP ${removeTemporaryPerson.status} ${text.slice(0, 250)}`);
      error.status = 502;
      throw error;
    }
    temporaryPersonId = null;

    let detachedFaceIds = movedFaceIds;
    if (vectorPool && movedFaceIds.length) {
      const verify = await vectorPool.query(
        `SELECT id FROM asset_face WHERE id = ANY($1::uuid[]) AND "personId" IS NULL AND "deletedAt" IS NULL`,
        [movedFaceIds],
      );
      detachedFaceIds = verify.rows.map((row) => row.id);
    }

    return {
      requested: items.length,
      moved: movedFaceIds.length,
      detached: detachedFaceIds.length,
      failed: failures.length + Math.max(0, movedFaceIds.length - detachedFaceIds.length),
      failures: failures.slice(0, 100),
      detachedFaceIds,
    };
  } catch (error) {
    if (temporaryPersonId) {
      try { await immichFetch(`/people/${encodeURIComponent(temporaryPersonId)}`, { method: 'DELETE' }); } catch {}
    }
    throw error;
  }
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

function normalizeTagPath(value) {
  return String(value || '').split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

function validateTagTaxonomy(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Tag-JSON muss ein Objekt sein.');
  if (!Array.isArray(document.concepts)) throw new Error('Tag-JSON benötigt ein concepts-Array.');
  const ids = new Set();
  const tags = new Set();
  for (const [index, concept] of document.concepts.entries()) {
    if (!concept || typeof concept !== 'object') throw new Error(`concepts[${index}] ist ungültig.`);
    const id = String(concept.id || '').trim();
    const tag = normalizeTagPath(concept.tag);
    if (!id) throw new Error(`concepts[${index}] hat keine id.`);
    if (!tag) throw new Error(`concepts[${index}] hat keinen tag-Pfad.`);
    if (ids.has(id)) throw new Error(`Doppelte Tag-ID: ${id}`);
    if (tags.has(tag.toLocaleLowerCase('de'))) throw new Error(`Doppelter Tag-Pfad: ${tag}`);
    ids.add(id);
    tags.add(tag.toLocaleLowerCase('de'));
    if (concept.prompts_en != null && !Array.isArray(concept.prompts_en)) throw new Error(`${id}: prompts_en muss ein Array sein.`);
  }
  if (document.folders != null) {
    if (!Array.isArray(document.folders)) throw new Error('folders muss ein Array sein.');
    const folders = new Set();
    for (const raw of document.folders) {
      const folder = normalizeTagPath(typeof raw === 'string' ? raw : raw?.path);
      if (!folder) throw new Error('Leerer Ordnerpfad in folders.');
      const key = folder.toLocaleLowerCase('de');
      if (folders.has(key)) throw new Error(`Doppelter Ordnerpfad: ${folder}`);
      folders.add(key);
    }
  }
  return true;
}

function readTagTaxonomy() {
  if (!fs.existsSync(tagTaxonomyPath)) {
    return { schema_version: 2, taxonomy_version: 'custom-v1', tag_language: 'de', prompt_language: 'en', folders: ['KI'], concepts: [] };
  }
  const document = JSON.parse(fs.readFileSync(tagTaxonomyPath, 'utf8'));
  validateTagTaxonomy(document);
  return document;
}

function writeTagTaxonomy(document) {
  validateTagTaxonomy(document);
  document.concept_count = document.concepts.length;
  document.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(tagTaxonomyPath), { recursive: true });
  if (fs.existsSync(tagTaxonomyPath)) fs.copyFileSync(tagTaxonomyPath, tagTaxonomyBackupPath);
  const tmp = `${tagTaxonomyPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, tagTaxonomyPath);
  return document;
}


async function encodeTagPrompt(text, modelName, language = 'en-US') {
  const key = `${modelName}\0${language}\0${text}`;
  if (tagTextEmbeddingCache.has(key)) return tagTextEmbeddingCache.get(key);
  const form = new FormData();
  form.append('entries', JSON.stringify({ clip: { textual: { modelName, options: { language } } } }));
  form.append('text', text);
  let response;
  try {
    response = await fetch(new URL('predict', immichMachineLearningUrl), { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  } catch (error) {
    const wrapped = new Error(`Immich Machine Learning ist nicht erreichbar (${immichMachineLearningUrl}): ${error.message}`);
    wrapped.status = 503;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`Text-Embedding fehlgeschlagen: HTTP ${response.status} ${detail}`);
    error.status = 502;
    throw error;
  }
  const data = await response.json();
  if (!data?.clip) throw new Error('Immich ML hat kein clip-Embedding zurückgegeben.');
  const embedding = parseVector(data.clip);
  tagTextEmbeddingCache.set(key, embedding);
  return embedding;
}

async function getTagCalibrationPreview(concept, { sampleSize = 48, candidatePerPrompt = 80 } = {}) {
  const pool = requireVectorDatabase();
  const prompts = (concept.prompts_en || []).map((item) => String(item).trim()).filter(Boolean);
  if (!prompts.length) { const error = new Error('Der Tag hat keine Prompts.'); error.status = 400; throw error; }
  const taxonomy = readTagTaxonomy();
  const modelName = taxonomy.target_model || 'ViT-SO400M-16-SigLIP2-384__webli';
  const promptVectors = [];
  for (const prompt of prompts) promptVectors.push({ prompt, vector: await encodeTagPrompt(prompt, modelName, 'en-US') });
  const dimension = promptVectors[0].vector.length;
  if (promptVectors.some((item) => item.vector.length !== dimension)) throw new Error('Prompt-Vektoren haben unterschiedliche Dimensionen.');

  const candidates = new Map();
  const limit = Math.max(10, Math.min(250, Number(candidatePerPrompt) || 80));
  for (const { vector } of promptVectors) {
    const vectorText = `[${vector.join(',')}]`;
    const result = await pool.query(
      `SELECT ss."assetId", ss.embedding::text AS embedding,
              a."originalFileName", a."fileCreatedAt", a."localDateTime", a."createdAt"
         FROM smart_search ss
         JOIN asset a ON a.id = ss."assetId"
        WHERE a."deletedAt" IS NULL
        ORDER BY ss.embedding <=> $1::vector
        LIMIT $2`,
      [vectorText, limit],
    );
    for (const row of result.rows) candidates.set(row.assetId, row);
  }

  const mode = concept.prompt_aggregation || 'top2_mean';
  const rows = [];
  for (const row of candidates.values()) {
    const imageVector = parseVector(row.embedding);
    if (imageVector.length !== dimension) {
      const error = new Error(`Embedding-Dimension passt nicht: smart_search=${imageVector.length}, Text=${dimension}. Ist Immich bereits vollständig mit ${modelName} neu indiziert?`);
      error.status = 409;
      throw error;
    }
    const promptScores = promptVectors.map(({ prompt, vector }) => ({ prompt, score: cosineSimilarity(imageVector, vector) }));
    const score = aggregatePromptScores(promptScores.map((item) => item.score), mode);
    rows.push({
      assetId: row.assetId,
      originalFileName: row.originalFileName || '',
      fileCreatedAt: row.fileCreatedAt || row.localDateTime || row.createdAt || null,
      score,
      promptScores,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const size = Math.max(12, Math.min(120, Number(sampleSize) || 48));
  return { modelName, dimension, aggregation: mode, prompts, totalCandidates: rows.length, items: rows.slice(0, size) };
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


function facePersonId(face) {
  return face?.person?.id || face?.personId || null;
}

function faceBoxPixels(face) {
  const width = Math.max(0, Number(face?.boundingBoxX2) - Number(face?.boundingBoxX1));
  const height = Math.max(0, Number(face?.boundingBoxY2) - Number(face?.boundingBoxY1));
  const pixels = width * height;
  return Number.isFinite(pixels) ? pixels : 0;
}

async function collectAllPeople() {
  const people = [];
  let page = 1;
  while (page < 10000) {
    const r = await immichFetch(`/people?page=${page}&size=250&withHidden=true`);
    if (!r.ok) {
      const error = new Error(`Immich people search failed with HTTP ${r.status}`);
      error.response = r;
      throw error;
    }
    const data = await r.json();
    people.push(...(data.people || []));
    if (!data.hasNextPage) break;
    page++;
  }
  return people;
}

async function scanDuplicatePersonFaces() {
  const people = await collectAllPeople();
  const faceCache = new Map();
  const assetMeta = new Map();
  const matches = [];
  let personCursor = 0;

  async function getFaces(assetId) {
    if (!faceCache.has(assetId)) {
      faceCache.set(assetId, (async () => {
        const r = await immichFetch(`/faces?id=${encodeURIComponent(assetId)}`);
        if (!r.ok) {
          const error = new Error(`Immich face lookup failed with HTTP ${r.status}`);
          error.response = r;
          throw error;
        }
        return r.json();
      })());
    }
    return faceCache.get(assetId);
  }

  const workers = Array.from({ length: Math.min(4, Math.max(1, people.length)) }, async () => {
    while (personCursor < people.length) {
      const person = people[personCursor++];
      const assets = await collectPersonAssets(person.id);
      for (const asset of assets) {
        assetMeta.set(asset.id, asset);
        const faces = await getFaces(asset.id);
        const samePerson = faces.filter((face) => facePersonId(face) === person.id);
        if (samePerson.length <= 1) continue;
        const sorted = samePerson.slice().sort((a, b) => faceBoxPixels(a) - faceBoxPixels(b));
        const keep = sorted[0];
        const remove = sorted.slice(1);
        matches.push({
          assetId: asset.id,
          assetName: asset.originalFileName || '',
          personId: person.id,
          personName: person.name || '',
          keepFaceId: keep.id,
          keepPixels: faceBoxPixels(keep),
          remove: remove.map((face) => ({ faceId: face.id, pixels: faceBoxPixels(face) })),
        });
      }
    }
  });
  await Promise.all(workers);

  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const removals = matches.flatMap((match) => match.remove.map((item) => ({
    ...item,
    assetId: match.assetId,
    assetName: match.assetName,
    personId: match.personId,
    personName: match.personName,
  })));
  const scan = { createdAt: Date.now(), matches, removals };
  duplicateFaceScans.set(scanId, scan);
  for (const [id, value] of duplicateFaceScans) {
    if (Date.now() - value.createdAt > DUPLICATE_SCAN_TTL_MS) duplicateFaceScans.delete(id);
  }
  return {
    scanId,
    peopleScanned: people.length,
    assetsScanned: faceCache.size,
    duplicateAssets: new Set(matches.map((m) => m.assetId)).size,
    duplicateGroups: matches.length,
    facesToRemove: removals.length,
    preview: matches.slice(0, 20).map((m) => ({
      assetId: m.assetId,
      assetName: m.assetName,
      personId: m.personId,
      personName: m.personName,
      markedFaces: m.remove.length + 1,
      keepPixels: m.keepPixels,
      removePixels: m.remove.map((x) => x.pixels),
    })),
  };
}

async function applyDuplicatePersonFaceScan(scanId) {
  const scan = duplicateFaceScans.get(scanId);
  if (!scan || Date.now() - scan.createdAt > DUPLICATE_SCAN_TTL_MS) {
    duplicateFaceScans.delete(scanId);
    const error = new Error('Scan ist abgelaufen. Bitte erneut scannen.');
    error.status = 410;
    throw error;
  }
  let cursor = 0;
  let removed = 0;
  const failures = [];
  const workers = Array.from({ length: Math.min(4, Math.max(1, scan.removals.length)) }, async () => {
    while (cursor < scan.removals.length) {
      const item = scan.removals[cursor++];
      try {
        const r = await immichFetch(`/faces/${encodeURIComponent(item.faceId)}`, {
          method: 'DELETE',
          body: JSON.stringify({ force: true }),
        });
        if (!r.ok) {
          const text = await r.text();
          failures.push({ faceId: item.faceId, assetId: item.assetId, status: r.status, message: text.slice(0, 300) });
        } else {
          removed++;
        }
      } catch (error) {
        failures.push({ faceId: item.faceId, assetId: item.assetId, status: 0, message: error.message });
      }
    }
  });
  await Promise.all(workers);
  duplicateFaceScans.delete(scanId);
  return { ok: failures.length === 0, requested: scan.removals.length, removed, failed: failures.length, failures: failures.slice(0, 30) };
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
      return json(res, 200, {
        ok: true,
        keyName: keyInfo.name || 'API key',
        immichExternalUrl,
        // Backward-compatible field for older frontends. It intentionally contains the browser URL, not the internal API URL.
        immichUrl: immichExternalUrl,
        version: appVersion,
        vectorDatabase: await vectorDatabaseInfo({ probe: true }),
      });
    }





    const tagCalibrationMatch = url.pathname.match(/^\/review-api\/tags\/([^/]+)\/calibration-preview$/);
    if (req.method === 'POST' && tagCalibrationMatch) {
      try {
        const body = await parseBody(req);
        const taxonomy = readTagTaxonomy();
        const conceptId = decodeURIComponent(tagCalibrationMatch[1]);
        const storedConcept = taxonomy.concepts.find((item) => item.id === conceptId);
        const concept = body.concept && body.concept.id === conceptId ? body.concept : storedConcept;
        if (!concept) return json(res, 404, { message: 'Tag nicht gefunden.' });
        return json(res, 200, await getTagCalibrationPreview(concept, body));
      } catch (error) {
        if (error.status) return json(res, error.status, { message: error.message });
        throw error;
      }
    }

    if (req.method === 'GET' && url.pathname === '/review-api/tags') {
      try {
        const document = readTagTaxonomy();
        return json(res, 200, { document, path: tagTaxonomyPath, writable: true });
      } catch (error) {
        return json(res, 500, { message: `Tag-JSON konnte nicht gelesen werden: ${error.message}` });
      }
    }

    if (req.method === 'PUT' && url.pathname === '/review-api/tags') {
      try {
        const body = await parseBody(req);
        const document = body.document ?? body;
        const saved = writeTagTaxonomy(document);
        return json(res, 200, { ok: true, document: saved, path: tagTaxonomyPath });
      } catch (error) {
        return json(res, 400, { message: `Tag-JSON konnte nicht gespeichert werden: ${error.message}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/maintenance/duplicate-person-faces/scan') {
      try {
        return json(res, 200, await scanDuplicatePersonFaces());
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        throw error;
      }
    }

    if (req.method === 'POST' && url.pathname === '/review-api/maintenance/duplicate-person-faces/apply') {
      const body = await parseBody(req);
      if (!body.scanId) return json(res, 400, { message: 'scanId is required' });
      try {
        const result = await applyDuplicatePersonFaceScan(body.scanId);
        if (result.removed) invalidateAdjacentPeople();
        return json(res, 200, result);
      } catch (error) {
        if (error.status) return json(res, error.status, { message: error.message });
        throw error;
      }
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

    const vectorClusterMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-cluster$/i);
    if (req.method === 'GET' && vectorClusterMatch) {
      if (!isUuid(vectorClusterMatch[1])) return json(res, 400, { message: 'Ungültige Personen-ID' });
      try {
        return json(res, 200, await getPersonVectorCluster(vectorClusterMatch[1]));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status) return json(res, error.status, { message: error.message, code: error.code });
        if (error.code && String(error.code).startsWith('42')) {
          return json(res, 503, { message: `Immich-Datenbankschema oder Leseberechtigungen konnten nicht verwendet werden: ${error.message}`, code: 'VECTOR_DB_SCHEMA_ERROR' });
        }
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', '28P01', '3D000'].includes(error.code)) {
          return json(res, 503, { message: `PostgreSQL ist für den Vektor-Cluster nicht erreichbar: ${error.message}`, code: 'VECTOR_DB_CONNECTION_ERROR' });
        }
        throw error;
      }
    }

    const vectorNeighborsMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-neighbors$/i);
    if (req.method === 'GET' && vectorNeighborsMatch) {
      const personId = vectorNeighborsMatch[1];
      if (!isUuid(personId)) return json(res, 400, { message: 'Ungültige Personen-ID' });
      const limit = Number(url.searchParams.get('limit') || 8);
      const force = /^(1|true|yes)$/i.test(url.searchParams.get('force') || '');
      try {
        return json(res, 200, await getAdjacentPeople(personId, limit, { force }));
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status && error.status < 500) return json(res, error.status, { message: error.message, code: error.code });
        if (error.code && String(error.code).startsWith('42')) {
          return json(res, 503, { message: `Personenmittelpunkte konnten mit dem Immich-Datenbankschema oder den Leserechten nicht berechnet werden: ${error.message}`, code: 'VECTOR_DB_SCHEMA_ERROR' });
        }
        if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'SELF_SIGNED_CERT_IN_CHAIN', '28P01', '3D000'].includes(error.code)) {
          return json(res, 503, { message: `PostgreSQL ist für angrenzende Personen nicht erreichbar: ${error.message}`, code: 'VECTOR_DB_CONNECTION_ERROR' });
        }
        throw error;
      }
    }

    const vectorClusterUnassignMatch = url.pathname.match(/^\/review-api\/people\/([0-9a-f-]+)\/vector-cluster\/unassign$/i);
    if (req.method === 'POST' && vectorClusterUnassignMatch) {
      const personId = vectorClusterUnassignMatch[1];
      if (!isUuid(personId)) return json(res, 400, { message: 'Ungültige Personen-ID' });
      const body = await parseBody(req);
      if (!Array.isArray(body.faceIds) || !body.faceIds.length) return json(res, 400, { message: 'faceIds must be a non-empty array' });
      if (body.faceIds.length > 5000) return json(res, 413, { message: 'Maximal 5000 Face-Zuordnungen pro Batch' });
      if (body.faceIds.some((faceId) => !isUuid(faceId))) return json(res, 400, { message: 'Mindestens eine Face-ID ist ungültig.' });
      try {
        await verifyPersonAccess(personId);
        const validated = await validateClusterFaceIds(personId, body.faceIds);
        const requestedUnique = new Set(body.faceIds.map(String));
        if (!validated.length) return json(res, 409, { message: 'Keines der ausgewählten Faces ist dieser Person noch zugeordnet.' });
        const result = await unassignFacesWithTemporaryPerson(validated);
        invalidateAdjacentPeople();
        return json(res, 200, {
          ...result,
          ok: result.failed === 0 && validated.length === requestedUnique.size,
          requested: requestedUnique.size,
          processed: result.requested,
          validated: validated.length,
          skipped: Math.max(0, requestedUnique.size - validated.length),
        });
      } catch (error) {
        if (error.response) return proxyJson(res, error.response);
        if (error.status) return json(res, error.status, { message: error.message, code: error.code });
        throw error;
      }
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
        invalidateAdjacentPeople();
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
      const response = await immichFetch(`/faces/${body.personId}`, {
        method: 'PUT',
        body: JSON.stringify({ id: reassignMatch[1] }),
      });
      if (response.ok) invalidateAdjacentPeople();
      return proxyJson(res, response);
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
        invalidateAdjacentPeople();
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
      const response = await immichFetch(`/faces/${deleteFaceMatch[1]}`, {
        method: 'DELETE',
        body: JSON.stringify({ force: true }),
      });
      if (response.ok) invalidateAdjacentPeople();
      return proxyJson(res, response);
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
  console.log(`Immich API endpoint: ${immichUrl}${apiPrefix}`);
  console.log(`Immich external URL: ${immichExternalUrl || 'not configured'}`);
  console.log(`Vector database: ${vectorDbConfigured ? 'configured' : 'not configured'}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  try { await vectorPool?.end(); } catch (error) { console.error('Could not close PostgreSQL pool:', error); }
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
