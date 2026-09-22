import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

test('person app has no tag runtime, UI, ML configuration or taxonomy storage', () => {
  for (const file of ['server.mjs', 'public/app.js', 'public/index.html', 'public/styles.css', 'Dockerfile', 'docker-compose.yml']) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /tagTaxonomy|tagManager|tagsTab|tagChooser|tag-calibration|smart_search|MACHINE_LEARNING|TAG_TAXONOMY|tag-taxonomy/, file);
  }
  for (const file of ['public/tags.js', 'data/tags.json', 'tag-calibration.mjs', 'tag-calibration.test.mjs']) assert.equal(fs.existsSync(new URL(file, import.meta.url)), false, file);
  const html = fs.readFileSync(new URL('public/index.html', import.meta.url), 'utf8');
  for (const id of ['reviewTab', 'unnamedTab', 'timelineView', 'clusterCanvas', 'reassignDialog', 'clusterNeighborDialog']) assert.ok(html.includes(`id="${id}"`), id);
});
test('person HTTP routes remain usable and former tag API is removed', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const seen = [];
  const mock = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, key: req.headers['x-api-key'] });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/api-keys/me') return res.end(JSON.stringify({ name: 'test-key' }));
    if (req.url.startsWith('/api/people?')) return res.end(JSON.stringify({ people: [{ id, name: 'Test Person' }], hasNextPage: false }));
    if (req.url.startsWith('/api/faces?id=')) return res.end(JSON.stringify([{ id, personId: id }]));
    if (req.url === '/api/faces/' + id && req.method === 'PUT') return res.end(JSON.stringify({ ok: true }));
    res.end(JSON.stringify({ id }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(IMMICH_|DB_|PORT$)/.test(key)) delete env[key];
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...env, PORT: String(port), IMMICH_URL: `http://127.0.0.1:${mock.address().port}`, IMMICH_EXTERNAL_URL: 'https://photos.example.test', IMMICH_API_KEY: 'test-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null && child.signalCode == null) { child.kill(); await once(child, 'exit'); } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes(`Listening on :${port}`)) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const status = await (await fetch(base + '/review-api/status')).json();
  assert.equal(status.ok, true); assert.equal(status.version, '0.13.0');
  assert.equal(status.immichExternalUrl, 'https://photos.example.test');
  assert.equal(status.vectorDatabase.configured, false);
  const people = await (await fetch(base + '/review-api/people')).json();
  assert.equal(people.people[0].name, 'Test Person');
  const faces = await (await fetch(base + `/review-api/assets/${id}/faces`)).json();
  assert.equal(faces[0].personId, id);
  const reassign = await fetch(base + `/review-api/faces/${id}/reassign`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId: id }) });
  assert.equal(reassign.status, 200);
  for (const method of ['GET', 'PUT']) assert.equal((await fetch(base + '/review-api/tags', { method })).status, 404);
  assert.equal((await fetch(base + '/review-api/tags/test/calibration-preview', { method: 'POST' })).status, 404);
  assert.ok(seen.every((request) => request.key === 'test-secret'));
  assert.ok(seen.some((request) => request.url === '/api/faces/' + id && request.method === 'PUT'));
  assert.ok(!JSON.stringify(status).includes('test-secret'));
});
