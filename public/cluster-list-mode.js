export const CLUSTER_LIST_MODES = Object.freeze(['outside', 'inside', 'all']);

export function isClusterListMode(value) {
  return CLUSTER_LIST_MODES.includes(value);
}

export function clusterPointMatchesMode(point, {
  mode = 'outside',
  radius = 0,
  distanceOf = (item) => Number(item?.distance || 0),
} = {}) {
  const distance = Number(distanceOf(point));
  if (!Number.isFinite(distance)) return false;
  if (mode === 'inside') return distance <= radius;
  if (mode === 'all') return true;
  return distance > radius;
}

export function filterAndSortClusterPoints(points, {
  mode = 'outside',
  radius = 0,
  distanceOf = (item) => Number(item?.distance || 0),
} = {}) {
  const normalizedMode = isClusterListMode(mode) ? mode : 'outside';
  return [...(points || [])]
    .filter((point) => clusterPointMatchesMode(point, { mode: normalizedMode, radius, distanceOf }))
    .sort((a, b) => Number(distanceOf(b)) - Number(distanceOf(a)));
}
