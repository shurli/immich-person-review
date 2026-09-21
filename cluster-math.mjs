const EPSILON = 1e-12;

export function parseEmbedding(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value, Number);
  const text = String(value ?? '').trim();
  if (!text) return [];
  const body = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (!body.trim()) return [];
  return body.split(',').map((item) => Number(item.trim()));
}

export function dot(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

export function magnitude(vector) {
  return Math.sqrt(Math.max(0, dot(vector, vector)));
}

export function normalize(vector) {
  const norm = magnitude(vector);
  if (!Number.isFinite(norm) || norm <= EPSILON) return null;
  const result = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i++) result[i] = vector[i] / norm;
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicUnitVector(dimensions, seedText, orthogonalTo = []) {
  const seed = hashString(seedText) || 1;
  const vector = new Float64Array(dimensions);
  let state = seed;
  for (let i = 0; i < dimensions; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    vector[i] = ((state >>> 0) / 4294967295) * 2 - 1;
  }
  for (const basis of orthogonalTo) {
    const projection = dot(vector, basis);
    for (let i = 0; i < dimensions; i++) vector[i] -= projection * basis[i];
  }
  return normalize(vector);
}

function covarianceMultiply(vectors, direction) {
  const dimensions = direction.length;
  const result = new Float64Array(dimensions);
  if (!vectors.length) return result;
  for (const vector of vectors) {
    const coefficient = dot(vector, direction);
    for (let i = 0; i < dimensions; i++) result[i] += vector[i] * coefficient;
  }
  const scale = 1 / vectors.length;
  for (let i = 0; i < dimensions; i++) result[i] *= scale;
  return result;
}

function principalComponent(vectors, dimensions, seedText, orthogonalTo = []) {
  let direction = deterministicUnitVector(dimensions, seedText, orthogonalTo);
  if (!direction) return null;

  for (let iteration = 0; iteration < 24; iteration++) {
    const next = covarianceMultiply(vectors, direction);
    for (const basis of orthogonalTo) {
      const projection = dot(next, basis);
      for (let i = 0; i < dimensions; i++) next[i] -= projection * basis[i];
    }
    const normalized = normalize(next);
    if (!normalized) break;
    direction = normalized;
  }
  return direction;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = clamp(q, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sampleEvenly(values, maximum) {
  if (values.length <= maximum) return values;
  const result = [];
  const step = values.length / maximum;
  for (let i = 0; i < maximum; i++) result.push(values[Math.floor(i * step)]);
  return result;
}

/**
 * Builds a radial tangent-PCA projection around the spherical mean.
 *
 * Every embedding is L2-normalized. The centroid is the normalized arithmetic
 * mean (spherical mean direction). Its cosine distance to each face is the
 * exact radius in the returned 2D plot. The angle is derived from the first two
 * PCA directions in the tangent space of the centroid. Consequently, a circle
 * with radius r separates exactly the points whose true 512D cosine distance
 * is <= r from those whose distance is > r.
 */
export function buildVectorCluster(records, options = {}) {
  const parsed = [];
  let dimensions = null;
  const invalid = [];

  for (const record of records) {
    const raw = parseEmbedding(record.embedding);
    if (!raw.length || raw.some((value) => !Number.isFinite(value))) {
      invalid.push(record.faceId || record.id || null);
      continue;
    }
    if (dimensions == null) dimensions = raw.length;
    if (raw.length !== dimensions) {
      invalid.push(record.faceId || record.id || null);
      continue;
    }
    const unit = normalize(raw);
    if (!unit) {
      invalid.push(record.faceId || record.id || null);
      continue;
    }
    parsed.push({ record, unit });
  }

  if (!parsed.length || !dimensions) {
    return {
      dimensions: dimensions || 0,
      meanVector: [],
      meanVectorNorm: 0,
      centroid: [],
      centroidNorm: 0,
      points: [],
      invalidFaceIds: invalid,
      stats: { count: 0, minDistance: 0, maxDistance: 0, meanDistance: 0, medianDistance: 0, p90Distance: 0, p95Distance: 0 },
      defaultRadius: 0,
      projection: 'radial-tangent-pca',
      projectionBasis: { pc1: [], pc2: [] },
    };
  }

  const meanVector = new Float64Array(dimensions);
  for (const { unit } of parsed) {
    for (let i = 0; i < dimensions; i++) meanVector[i] += unit[i] / parsed.length;
  }
  const meanVectorNorm = magnitude(meanVector);
  let centroid = normalize(meanVector);
  if (!centroid) centroid = parsed[0].unit;

  const intermediate = [];
  const tangentVectors = [];
  for (const { record, unit } of parsed) {
    const cosine = clamp(dot(unit, centroid), -1, 1);
    const distance = Math.max(0, 1 - cosine);
    const theta = Math.acos(cosine);
    const tangent = new Float64Array(dimensions);
    const tangentNorm = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    if (theta > EPSILON && tangentNorm > EPSILON) {
      const scale = theta / tangentNorm;
      for (let i = 0; i < dimensions; i++) tangent[i] = (unit[i] - cosine * centroid[i]) * scale;
    }
    intermediate.push({ record, unit, cosine, distance, theta, tangent });
    if (theta > EPSILON) tangentVectors.push(tangent);
  }

  const pcaSample = sampleEvenly(tangentVectors, Number(options.pcaSampleSize || 2500));
  let pc1 = principalComponent(pcaSample, dimensions, `${options.seed || 'cluster'}:pc1`, [centroid]);
  if (!pc1) pc1 = deterministicUnitVector(dimensions, `${options.seed || 'cluster'}:fallback1`, [centroid]);
  let pc2 = principalComponent(pcaSample, dimensions, `${options.seed || 'cluster'}:pc2`, [centroid, pc1].filter(Boolean));
  if (!pc2) pc2 = deterministicUnitVector(dimensions, `${options.seed || 'cluster'}:fallback2`, [centroid, pc1].filter(Boolean));

  const points = intermediate.map(({ record, unit, cosine, distance, theta, tangent }) => {
    let angle = 0;
    if (distance > EPSILON && pc1 && pc2) {
      const axisX = dot(tangent, pc1);
      const axisY = dot(tangent, pc2);
      if (Math.hypot(axisX, axisY) > theta * 1e-7) {
        angle = Math.atan2(axisY, axisX);
      } else {
        angle = (hashString(record.faceId || record.id || record.assetId || '') / 4294967295) * Math.PI * 2;
      }
    }
    return {
      ...record,
      embedding: undefined,
      distance: round(distance),
      angularDistance: round(theta),
      centroidDot: round(cosine),
      pc1Dot: round(pc1 ? dot(unit, pc1) : 0),
      pc2Dot: round(pc2 ? dot(unit, pc2) : 0),
      x: round(distance * Math.cos(angle)),
      y: round(distance * Math.sin(angle)),
    };
  });

  const distances = points.map((point) => point.distance).sort((a, b) => a - b);
  const meanDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const p90Distance = quantile(distances, 0.9);
  const configuredRadius = Number(options.defaultRadius);
  const defaultRadius = Number.isFinite(configuredRadius) && configuredRadius >= 0
    ? configuredRadius
    : p90Distance;

  return {
    dimensions,
    meanVector: Array.from(meanVector, (value) => round(value)),
    meanVectorNorm: round(meanVectorNorm),
    centroid: Array.from(centroid, (value) => round(value)),
    centroidNorm: round(magnitude(centroid)),
    points,
    invalidFaceIds: invalid,
    stats: {
      count: points.length,
      minDistance: round(distances[0] || 0),
      maxDistance: round(distances.at(-1) || 0),
      meanDistance: round(meanDistance),
      medianDistance: round(quantile(distances, 0.5)),
      p90Distance: round(p90Distance),
      p95Distance: round(quantile(distances, 0.95)),
    },
    defaultRadius: round(defaultRadius),
    projection: 'radial-tangent-pca',
    projectionBasis: {
      pc1: pc1 ? Array.from(pc1, (value) => round(value)) : [],
      pc2: pc2 ? Array.from(pc2, (value) => round(value)) : [],
    },
  };
}
