import assert from 'node:assert/strict';
import test from 'node:test';
import { projectEmbeddingToCluster } from './cluster-math.mjs';
import { distanceToClusterCenter, projectPointAroundClusterCenter } from './public/cluster-center-math.js';

const cluster = {
  dimensions: 3,
  centroid: [1, 0, 0],
  projectionBasis: {
    pc1: [0, 1, 0],
    pc2: [0, 0, 1],
  },
};

test('adjacent person centroid is projected with exact cosine radius', () => {
  const point = projectEmbeddingToCluster('[0.8,0.6,0]', cluster, { id: 'neighbor-a' });
  assert.ok(Math.abs(point.distance - 0.2) < 1e-10);
  assert.ok(Math.abs(point.x - 0.2) < 1e-10);
  assert.ok(Math.abs(point.y) < 1e-10);
  assert.ok(Math.abs(point.pc1Dot - 0.6) < 1e-10);
});

test('adjacent person uses the same moved-center distance math as face points', () => {
  const point = projectEmbeddingToCluster('[0.8,0,0.6]', cluster, { id: 'neighbor-b' });
  const center = { x: 0.1, y: 0.04 };
  const projected = projectPointAroundClusterCenter(point, center);
  const exact = distanceToClusterCenter(point, center);
  assert.ok(Math.abs(projected.distance - exact) < 1e-12);
  assert.ok(Math.abs(Math.hypot(projected.x - center.x, projected.y - center.y) - exact) < 1e-12);
});

test('dimension mismatch is rejected', () => {
  assert.throws(() => projectEmbeddingToCluster('[1,0]', cluster), /passt nicht/);
});
