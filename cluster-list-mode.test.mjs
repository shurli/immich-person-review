import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clusterPointMatchesMode,
  filterAndSortClusterPoints,
  isClusterListMode,
} from './public/cluster-list-mode.js';

const points = [
  { id: 'near', d: 0.1 },
  { id: 'boundary', d: 0.5 },
  { id: 'far', d: 0.9 },
  { id: 'middle', d: 0.4 },
];
const distanceOf = (point) => point.d;

test('outside is strict and inside includes the radius boundary', () => {
  assert.equal(clusterPointMatchesMode(points[1], { mode: 'outside', radius: 0.5, distanceOf }), false);
  assert.equal(clusterPointMatchesMode(points[1], { mode: 'inside', radius: 0.5, distanceOf }), true);
});

test('outside, inside and all lists are sorted from greatest distance', () => {
  assert.deepEqual(
    filterAndSortClusterPoints(points, { mode: 'outside', radius: 0.5, distanceOf }).map((point) => point.id),
    ['far'],
  );
  assert.deepEqual(
    filterAndSortClusterPoints(points, { mode: 'inside', radius: 0.5, distanceOf }).map((point) => point.id),
    ['boundary', 'middle', 'near'],
  );
  assert.deepEqual(
    filterAndSortClusterPoints(points, { mode: 'all', radius: 0.5, distanceOf }).map((point) => point.id),
    ['far', 'boundary', 'middle', 'near'],
  );
});

test('unknown list modes fall back to outside', () => {
  assert.equal(isClusterListMode('inside'), true);
  assert.equal(isClusterListMode('unexpected'), false);
  assert.deepEqual(
    filterAndSortClusterPoints(points, { mode: 'unexpected', radius: 0.5, distanceOf }).map((point) => point.id),
    ['far'],
  );
});
