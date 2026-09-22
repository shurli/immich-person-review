import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function launch(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(IMMICH_|TAG_|DB_|PORT$)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...env, PORT: '0', TAG_TAXONOMY_PATH: path.join(dir, 'tags.json'), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) { child.kill(); await once(child, 'exit'); } });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout: ' + output)), 10000);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Server exited: ' + code + output)); });
    child.stdout.on('data', (data) => { output += data; const match = output.match(/listening on :(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    child.stderr.on('data', (data) => { output += data; });
  });
  return { request: (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options), dir };
}
const jsonBody = (value, method = 'PUT') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
test('standalone HTTP app: offline editor, persistence, validation and route isolation', async (t) => {
  const { request, dir } = await launch(t);
  assert.equal((await request('/healthz')).status, 200);
  const html = await (await request('/')).text();
  assert.match(html, /Immich Tag Manager/); assert.match(html, /id="tagTree"/);
  assert.doesNotMatch(html, /namedChooser|clusterCanvas|reassignDialog/);
  const status = await (await request('/tag-api/status')).json();
  assert.equal(status.immich.configured, false); assert.equal(status.tagDatabase.configured, false);
  const initial = await (await request('/tag-api/tags')).json();
  assert.equal(initial.document.concepts.length, 350);
  assert.equal(initial.warnings.length, 1);
  initial.document.concepts[0].threshold = 0.777;
  const save = await request('/tag-api/tags', jsonBody({ document: initial.document }));
  assert.equal(save.status, 200);
  assert.equal((await save.json()).document.concepts[0].threshold, 0.777);
  assert.ok(fs.existsSync(path.join(dir, 'tags.json.bak')));
  assert.equal((await request('/tag-api/tags', jsonBody({ concepts: [null] }))).status, 400);
  assert.equal((await request('/tag-api/tags', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/tag-api/tags', { method: 'PUT', body: '{}' })).status, 415);
  for (const route of ['/review-api/tags', '/review-api/people', '/tag-api/people', '/tag-api/faces/abcd', '/cluster-math.mjs', '/storage/tags.json', '/.env', '/missing.js']) assert.equal((await request(route)).status, 404, route);
  const notFound = await request('/tag-api/tags/missing/calibration-preview', jsonBody({}, 'POST'));
  assert.equal(notFound.status, 404);
  const noDb = await request('/tag-api/tags/dog/calibration-preview', jsonBody({}, 'POST'));
  assert.equal(noDb.status, 503);
  const noCredentials = await request('/tag-api/assets/11111111-1111-4111-8111-111111111111/thumbnail');
  assert.equal(noCredentials.status, 503);
});
test('Immich proxy uses internal prefix and server-only key, and preserves thumbnail denials', async (t) => {
  const calls = [];
  const mock = http.createServer((req, res) => {
    calls.push({ url: req.url, key: req.headers['x-api-key'], method: req.method });
    if (req.url === '/custom/users/me') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' })); }
    if (req.url.includes('/assets/aaaaaaaa')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end('image-bytes'); }
    res.writeHead(403); res.end('denied');
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  const { request } = await launch(t, { IMMICH_URL: `http://127.0.0.1:${mock.address().port}`, IMMICH_API_PREFIX: '/custom', IMMICH_API_KEY: 'test-secret-not-public', IMMICH_EXTERNAL_URL: 'https://photos.example.com' });
  const status = await (await request('/tag-api/status')).text();
  assert.equal(JSON.parse(status).immich.reachable, true); assert.doesNotMatch(status, /test-secret-not-public/);
  const image = await request('/tag-api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/thumbnail?size=preview');
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg'); assert.equal(await image.text(), 'image-bytes');
  assert.equal((await request('/tag-api/assets/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/thumbnail')).status, 403);
  assert.ok(calls.length >= 3); assert.ok(calls.every((call) => call.key === 'test-secret-not-public' && call.method === 'GET'));
});
