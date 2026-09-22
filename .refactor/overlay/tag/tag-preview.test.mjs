import test from 'node:test';
import assert from 'node:assert/strict';
import { createTagPreview } from './tag-preview.mjs';
const owner = '11111111-1111-4111-8111-111111111111';
function fixture(overrides = {}) {
  const queries = []; const requests = [];
  const defaults = {
    getPool: () => ({ query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [
        { assetId: 'a', embedding: '[0.8,0.6]', originalFileName: 'one.jpg' },
        { assetId: 'b', embedding: '[1,0]', originalFileName: 'two.jpg' },
      ] };
    } }),
    getOwnerId: async () => owner,
    readTagTaxonomy: () => ({ target_model: 'test-model' }),
    immichMachineLearningUrl: 'http://ml.test/',
    fetch: async (url, options) => {
      const prompt = options.body.get('text');
      requests.push({ url: String(url), options, entries: JSON.parse(options.body.get('entries')) });
      return new Response(JSON.stringify({ clip: prompt === 'first' ? [1, 0] : [0, 1] }), { headers: { 'content-type': 'application/json' } });
    },
  };
  return { preview: createTagPreview({ ...defaults, ...overrides }), queries, requests };
}
const concept = { id: 'dog', prompts_en: ['first', 'second'], prompt_aggregation: 'top2_mean' };
test('preview retains model, prompt aggregation, candidate union and sorted scores', async () => {
  const { preview, queries, requests } = fixture();
  const result = await preview(concept, { candidatePerPrompt: 21.9 });
  assert.equal(result.modelName, 'test-model');
  assert.equal(result.dimension, 2);
  assert.equal(result.totalCandidates, 2);
  assert.equal(result.items[0].assetId, 'a');
  assert.ok(Math.abs(result.items[0].score - 0.7) < 1e-12);
  assert.equal(result.items[0].promptScores.length, 2);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].params[1], 21);
  assert.equal(queries[0].params[2], owner);
  assert.match(queries[0].sql, /a\."ownerId" = \$3::uuid/);
  assert.match(queries[0].sql, /visibility IN \('timeline', 'archive'\)/);
  assert.doesNotMatch(queries[0].sql, /asset_face|face_search/);
  assert.equal(requests[0].url, 'http://ml.test/predict');
  assert.equal(requests[0].entries.clip.textual.modelName, 'test-model');
  assert.equal('embedding' in result.items[0], false);
  await preview(concept);
  assert.equal(requests.length, 2, 'prompt embeddings must be cached');
});
test('preview rejects model dimension mismatch', async () => {
  const { preview } = fixture({ getPool: () => ({ query: async () => ({ rows: [{ assetId: 'a', embedding: '[1,0,0]' }] }) }) });
  await assert.rejects(preview(concept), (error) => error.status === 409);
});
test('empty prompts and ML failures produce actionable errors', async () => {
  await assert.rejects(fixture().preview({ prompts_en: [] }), (error) => error.status === 400);
  await assert.rejects(fixture({ fetch: async () => { throw new Error('offline'); } }).preview(concept), (error) => error.status === 503);
  await assert.rejects(fixture({ fetch: async () => new Response('broken', { status: 500 }) }).preview(concept), (error) => error.status === 502);
});
test('owner access failure cannot execute a database query or ML request', async () => {
  const { preview, queries, requests } = fixture({ getOwnerId: async () => { throw new Error('denied'); } });
  await assert.rejects(preview(concept), /denied/);
  assert.equal(queries.length, 0); assert.equal(requests.length, 0);
});
