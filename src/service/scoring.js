// --- Search quality helpers (shared by database.js and memory-index.js) ---

export const SPECIFIER_BOOST = {
  'BlueprintCallable': 0.05, 'BlueprintPure': 0.05,
  'BlueprintReadWrite': 0.04, 'BlueprintReadOnly': 0.04,
  'BlueprintImplementableEvent': 0.04, 'BlueprintNativeEvent': 0.04,
  'EditAnywhere': 0.03, 'EditDefaultsOnly': 0.02,
  'VisibleAnywhere': 0.02, 'Replicated': 0.02,
};
const MAX_SPECIFIER_BOOST = 0.08;

export function specifierBoost(specifiers) {
  if (!specifiers) return 0;
  let boost = 0;
  for (const [spec, value] of Object.entries(SPECIFIER_BOOST)) {
    if (specifiers.includes(spec)) boost += value;
  }
  return Math.min(boost, MAX_SPECIFIER_BOOST);
}

export const KIND_WEIGHT = {
  'class': 0.04, 'struct': 0.03, 'interface': 0.03,
  'enum': 0.02, 'delegate': 0.01, 'event': 0.01,
};

export function trigramThreshold(nameLength) {
  if (nameLength <= 5) return 0.60;
  if (nameLength <= 15) return 0.75;
  return 0.80;
}

export function splitCamelCase(name) {
  return name.replace(/^[UAFESI](?=[A-Z])/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/).map(w => w.toLowerCase()).filter(w => w.length > 0);
}

export function scoreEntry(r) {
  let s = 0;
  if (r.parent) s += 10;
  if (r.path && r.path.endsWith('.h')) s += 5;
  if (r.path) {
    const p = r.path.replace(/\\/g, '/');
    if (p.includes('/Runtime/')) s += 2;
    else if (p.includes('/Developer/')) s += 1;
    if (p.includes('/Public/') || p.includes('/Classes/')) s += 1.5;
    else if (p.includes('/Private/')) s += 0.5;
    s += Math.max(0, 0.5 - p.length * 0.004);
  }
  return s;
}

export function dedupTypes(results) {
  const best = new Map();
  for (const r of results) {
    const key = `${r.name}:${r.kind}`;
    const existing = best.get(key);
    if (!existing) { best.set(key, r); continue; }
    const existingScore = scoreEntry(existing);
    const newScore = scoreEntry(r);
    if (newScore > existingScore) {
      if (existing.path && existing.path.endsWith('.cpp')) r.implementationPath = existing.path;
      best.set(key, r);
    } else {
      if (r.path && r.path.endsWith('.cpp')) existing.implementationPath = r.path;
    }
  }
  const deduped = [...best.values()];
  deduped.sort((a, b) => scoreEntry(b) - scoreEntry(a));
  return deduped;
}
