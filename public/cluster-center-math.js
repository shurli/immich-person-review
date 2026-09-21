const EPSILON = 1e-12;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function describeClusterCenter(center = {}) {
  let x = finite(center.x);
  let y = finite(center.y);
  let radialDistance = Math.hypot(x, y);

  // Cosine distance between two unit vectors is in [0, 2].
  if (radialDistance > 2) {
    const scale = 2 / radialDistance;
    x *= scale;
    y *= scale;
    radialDistance = 2;
  }

  const angle = radialDistance > EPSILON ? Math.atan2(y, x) : 0;
  const cosPhi = Math.cos(angle);
  const sinPhi = Math.sin(angle);
  const cosTheta = clamp(1 - radialDistance, -1, 1);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));

  return { x, y, radialDistance, angle, cosPhi, sinPhi, cosTheta, sinTheta };
}

export function distanceToClusterCenter(point, center) {
  const geometry = describeClusterCenter(center);
  const centroidDot = finite(point.centroidDot, 1 - finite(point.distance));
  const pc1Dot = finite(point.pc1Dot);
  const pc2Dot = finite(point.pc2Dot);
  const directionalDot = geometry.cosPhi * pc1Dot + geometry.sinPhi * pc2Dot;
  const similarity = clamp(
    geometry.cosTheta * centroidDot + geometry.sinTheta * directionalDot,
    -1,
    1,
  );
  return Math.max(0, 1 - similarity);
}

/**
 * Reprojects one point radially around the currently selected spherical center.
 * The displayed radius remains the exact cosine distance to that center. The
 * angle uses the original PCA basis after parallel transport along the center
 * movement on the unit sphere.
 */
export function projectPointAroundClusterCenter(point, center) {
  const geometry = describeClusterCenter(center);
  const centroidDot = finite(point.centroidDot, 1 - finite(point.distance));
  const pc1Dot = finite(point.pc1Dot);
  const pc2Dot = finite(point.pc2Dot);
  const distance = distanceToClusterCenter(point, geometry);

  let axis1 = pc1Dot;
  let axis2 = pc2Dot;
  if (geometry.radialDistance > EPSILON) {
    const alongMove = geometry.cosPhi * pc1Dot + geometry.sinPhi * pc2Dot;
    const acrossMove = -geometry.sinPhi * pc1Dot + geometry.cosPhi * pc2Dot;
    const transportedMove = geometry.cosTheta * alongMove - geometry.sinTheta * centroidDot;

    // Parallel-transport the original pc1/pc2 axes to the moved center.
    axis1 = geometry.cosPhi * transportedMove - geometry.sinPhi * acrossMove;
    axis2 = geometry.sinPhi * transportedMove + geometry.cosPhi * acrossMove;
  }

  let angle;
  if (Math.hypot(axis1, axis2) > EPSILON) {
    angle = Math.atan2(axis2, axis1);
  } else {
    angle = Math.atan2(finite(point.y), finite(point.x));
  }

  return {
    distance,
    angle,
    x: geometry.x + distance * Math.cos(angle),
    y: geometry.y + distance * Math.sin(angle),
  };
}

export function clusterCenterVector(cluster, center) {
  const centroid = Array.isArray(cluster?.centroid) ? cluster.centroid : [];
  const pc1 = Array.isArray(cluster?.projectionBasis?.pc1) ? cluster.projectionBasis.pc1 : [];
  const pc2 = Array.isArray(cluster?.projectionBasis?.pc2) ? cluster.projectionBasis.pc2 : [];
  if (!centroid.length) return [];

  const geometry = describeClusterCenter(center);
  if (!pc1.length || !pc2.length || geometry.radialDistance <= EPSILON) return centroid.slice();

  const result = new Array(centroid.length);
  let normSquared = 0;
  for (let index = 0; index < centroid.length; index++) {
    const direction = geometry.cosPhi * finite(pc1[index]) + geometry.sinPhi * finite(pc2[index]);
    const value = geometry.cosTheta * finite(centroid[index]) + geometry.sinTheta * direction;
    result[index] = value;
    normSquared += value * value;
  }

  const norm = Math.sqrt(Math.max(0, normSquared));
  if (norm <= EPSILON) return centroid.slice();
  return result.map((value) => value / norm);
}
