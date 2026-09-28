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

const HEADER_RE = /\.(h|hpp|inl)$/i;

/**
 * Can these two rows plausibly be ONE type declared in a header and defined in a
 * .cpp? Only then may they be collapsed into a single answer.
 *
 * - An `enum` has no out-of-line definition: a .cpp row with the same name is a
 *   DIFFERENT, file-local enum, not the same one's implementation. Never merge.
 * - A `class` or `struct` legitimately splits: merge only when exactly one side
 *   is a header and the other a .cpp. Two .cpp rows are two separate definitions.
 */
function mayBeHeaderImplPair(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'class' && a.kind !== 'struct') return false;
  const aH = HEADER_RE.test(a.path || ''), bH = HEADER_RE.test(b.path || '');
  return aH !== bH;
}

export function dedupTypes(results) {
  const best = new Map();
  for (const r of results) {
    // The key MUST include the project (and language) as well as the name and
    // kind. This collapse exists to pair ONE type's header declaration with its
    // .cpp definition — and a header/impl pair is by definition in the same
    // project and the same language. Keying on `name:kind` alone also collapsed
    // genuinely unrelated types that merely share a name, which is a silent
    // wrong answer in two ways: the losing definition vanished with no hint it
    // existed, and if it happened to end in .cpp it was reported as the winner's
    // `implementationPath` — a relationship that does not exist.
    //
    // Measured on framework 2026-09-27 before the fix (FLEET-335): `EParseState`
    // is three unrelated enums (Engine/Core, EnginePlugins, SharedPlugins'
    // vendored DungeonArchitect) and find_type answered with Engine's, claiming
    // it was implemented in DAMkJsonSyntaxHighlighter.cpp. On a tenant-bearing
    // tree the same collapse hid an AngelScript class behind a C++ class of the
    // same name in another game (the `.h` bias in scoreEntry made the C++ one
    // win), so `find_type` reported the wrong file with no second row.
    //
    // Keying alone is still not enough: after the key was narrowed, Engine's
    // `EParseState` (a .h) was measured claiming a TraceLog `Control.cpp` as its
    // implementation, and EnginePlugins' claimed a PCG kernel .cpp — same name,
    // same project, still unrelated. So a merge additionally requires that the
    // two rows COULD be a header/impl pair (mayBeHeaderImplPair); otherwise both
    // definitions are kept, under distinct keys.
    const baseKey = `${r.name}:${r.kind}:${r.project ?? ''}:${r.language ?? ''}`;
    const key = best.has(baseKey) && !mayBeHeaderImplPair(best.get(baseKey), r)
      ? `${baseKey}:${r.path ?? ''}`
      : baseKey;
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
