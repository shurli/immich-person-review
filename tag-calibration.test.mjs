import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVector, cosineSimilarity, aggregatePromptScores } from './tag-calibration.mjs';

test('parseVector parses pgvector text', () => assert.deepEqual(parseVector('[1, 2,-3.5]'), [1,2,-3.5]));
test('cosineSimilarity handles equal and orthogonal vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1,0],[1,0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1,0],[0,1])) < 1e-12);
});
test('aggregatePromptScores supports top2_mean and max', () => {
  assert.equal(aggregatePromptScores([0.2,0.8,0.6], 'top2_mean'), 0.7);
  assert.equal(aggregatePromptScores([0.2,0.8,0.6], 'max'), 0.8);
});
