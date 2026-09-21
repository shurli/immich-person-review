import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVectorCluster } from './cluster-math.mjs';
import {
  clusterCenterVector,
  describeClusterCenter,
  distanceToClusterCenter,
  projectPointAroundClusterCenter,
} from './public/cluster-center-math.js';

function normalize(values) {
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

test('moved center keeps radial display distance equal to exact cosine distance', () => {
  const embeddings = new Map([
    ['a', [1, 0.05, 0.02]],
    ['b', [0.95, 0.22, -0.04]],
    ['c', [0.84, -0.18, 0.38]],
    ['d', [0.72, 0.28, 0.55]],
    ['e', [0.68, -0.42, 0.46]],
  ]);
  const records = [...embeddings].map(([faceId, vector], index) => ({
    faceId,
    assetId: `asset-${index}`,
    embedding: `[${vector.join(',')}]`,
  }));
  const cluster = buildVectorCluster(records, { seed: 'drag-center-test' });
  const center = { x: 0.12, y: -0.05 };
  const centerVector = clusterCenterVector(cluster, center);
  assert.equal(centerVector.length, 3);
  assert.ok(Math.abs(Math.hypot(...centerVector) - 1) < 1e-8);

  for (const point of cluster.points) {
    const unit = normalize(embeddings.get(point.faceId));
    const exactDistance = 1 - dot(unit, centerVector);
    const calculatedDistance = distanceToClusterCenter(point, center);
    const projected = projectPointAroundClusterCenter(point, center);
    const radialDistance = Math.hypot(projected.x - center.x, projected.y - center.y);

    assert.ok(Math.abs(calculatedDistance - exactDistance) < 3e-7, `${point.faceId}: ${calculatedDistance} vs ${exactDistance}`);
    assert.ok(Math.abs(radialDistance - calculatedDistance) < 1e-10, `${point.faceId}: radial mismatch`);
  }
});

test('zero offset returns the original centroid and original distances', () => {
  const cluster = buildVectorCluster([
    { faceId: 'a', embedding: '[1,0,0]' },
    { faceId: 'b', embedding: '[0.9,0.3,0.1]' },
    { faceId: 'c', embedding: '[0.7,-0.2,0.5]' },
  ], { seed: 'zero-center' });
  const center = describeClusterCenter({ x: 0, y: 0 });
  assert.equal(center.radialDistance, 0);
  assert.deepEqual(clusterCenterVector(cluster, center), cluster.centroid);
  for (const point of cluster.points) {
    assert.ok(Math.abs(distanceToClusterCenter(point, center) - point.distance) < 1e-8);
  }
});
