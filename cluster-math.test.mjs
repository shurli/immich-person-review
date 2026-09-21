import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVectorCluster, parseEmbedding } from './cluster-math.mjs';

test('parseEmbedding parses pgvector text', () => {
  assert.deepEqual(parseEmbedding('[1, 2.5,-3]'), [1, 2.5, -3]);
});

test('radial projection preserves cosine distance from centroid', () => {
  const records = [
    { faceId: 'a', assetId: '1', embedding: '[1,0,0]' },
    { faceId: 'b', assetId: '2', embedding: '[0.98,0.2,0]' },
    { faceId: 'c', assetId: '3', embedding: '[0.8,0,0.6]' },
    { faceId: 'd', assetId: '4', embedding: '[0.7,-0.4,0.5]' },
  ];
  const cluster = buildVectorCluster(records, { seed: 'test' });
  assert.equal(cluster.points.length, 4);
  for (const point of cluster.points) {
    const radius = Math.hypot(point.x, point.y);
    assert.ok(Math.abs(radius - point.distance) < 1e-6, `${point.faceId}: ${radius} vs ${point.distance}`);
  }
  assert.ok(Math.abs(cluster.centroidNorm - 1) < 1e-8);
  assert.equal(cluster.meanVector.length, 3);
  assert.ok(cluster.meanVectorNorm > 0 && cluster.meanVectorNorm <= 1);
});

test('invalid and zero embeddings are skipped', () => {
  const cluster = buildVectorCluster([
    { faceId: 'ok', embedding: '[1,0]' },
    { faceId: 'zero', embedding: '[0,0]' },
    { faceId: 'bad', embedding: '[x,1]' },
  ]);
  assert.equal(cluster.points.length, 1);
  assert.deepEqual(cluster.invalidFaceIds, ['zero', 'bad']);
});

test('default radius is the 90th percentile and raw embeddings are not serialized', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    faceId: `face-${index}`,
    assetId: `asset-${index}`,
    embedding: `[1,${index / 20},0]`,
  }));
  const cluster = buildVectorCluster(records, { seed: 'percentile-test' });
  assert.equal(cluster.defaultRadius, cluster.stats.p90Distance);
  assert.equal(JSON.stringify(cluster.points).includes('embedding'), false);
});
