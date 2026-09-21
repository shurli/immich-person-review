export function parseVector(value) {
  if (Array.isArray(value)) return value.map(Number);
  const text = String(value ?? '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) throw new Error('Ungültiger Vektorwert.');
  const values = text.slice(1, -1).split(',').map((item) => Number(item.trim()));
  if (!values.length || values.some((item) => !Number.isFinite(item))) throw new Error('Ungültiger Vektorwert.');
  return values;
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length || !a.length) throw new Error(`Vektordimensionen passen nicht zusammen (${a.length} != ${b.length}).`);
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}

export function aggregatePromptScores(scores, mode = 'top2_mean') {
  const clean = scores.filter(Number.isFinite);
  if (!clean.length) return null;
  if (mode === 'max') return Math.max(...clean);
  if (mode === 'mean') return clean.reduce((sum, value) => sum + value, 0) / clean.length;
  if (mode === 'min') return Math.min(...clean);
  const sorted = [...clean].sort((a, b) => b - a);
  if (mode === 'top3_mean') {
    const top = sorted.slice(0, Math.min(3, sorted.length));
    return top.reduce((sum, value) => sum + value, 0) / top.length;
  }
  const top = sorted.slice(0, Math.min(2, sorted.length));
  return top.reduce((sum, value) => sum + value, 0) / top.length;
}
