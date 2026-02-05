import { createHash } from 'crypto';

/**
 * Encode three characters into a 24-bit integer trigram.
 */
export function encodeTrigram(c1, c2, c3) {
  return (c1 << 16) | (c2 << 8) | c3;
}

/**
 * Extract all unique trigrams from file content.
 * Content is lowercased before extraction (case-insensitive index).
 * Returns a Set of integer-encoded trigrams.
 */
export function extractTrigrams(content) {
  const lower = content.toLowerCase();
  const trigrams = new Set();
  const len = lower.length - 2;

  for (let i = 0; i < len; i++) {
    const c1 = lower.charCodeAt(i);
    const c2 = lower.charCodeAt(i + 1);
    const c3 = lower.charCodeAt(i + 2);

    // Skip trigrams containing newlines, carriage returns, or null bytes
    if (c1 === 10 || c1 === 13 || c1 === 0) continue;
    if (c2 === 10 || c2 === 13 || c2 === 0) continue;
    if (c3 === 10 || c3 === 13 || c3 === 0) continue;

    trigrams.add((c1 << 16) | (c2 << 8) | c3);
  }

  return trigrams;
}

/**
 * Compute a 64-bit content hash for change detection.
 * Uses the first 8 bytes of an MD5 hash, read as a BigInt.
 */
export function contentHash(content) {
  const hash = createHash('md5').update(content).digest();
  // Read first 8 bytes as a signed 64-bit integer (SQLite stores as INTEGER)
  return hash.readBigInt64LE(0);
}

/**
 * Extract required trigrams from a search pattern.
 * Returns an array of integer-encoded trigrams that ANY matching string must contain.
 * Returns empty array for unindexable patterns.
 */
export function patternToTrigrams(pattern, isRegex = true) {
  if (!isRegex) {
    // Literal string: extract all trigrams directly
    return [...extractTrigrams(pattern)];
  }

  // Handle top-level alternation at the trigram level (intersection)
  const alternatives = splitTopLevelAlternation(pattern);
  if (alternatives.length > 1) {
    const branchTrigramSets = alternatives.map(alt => {
      const literals = extractLiteralsFromBranch(alt);
      if (literals.length === 0) return new Set();
      const set = new Set();
      for (const lit of literals) {
        for (const tri of extractTrigrams(lit)) {
          set.add(tri);
        }
      }
      return set;
    });

    // If any branch is unindexable, the whole alternation is unindexable
    if (branchTrigramSets.some(s => s.size === 0)) return [];

    // Intersect all branch trigram sets
    let common = branchTrigramSets[0];
    for (let i = 1; i < branchTrigramSets.length; i++) {
      common = new Set([...common].filter(t => branchTrigramSets[i].has(t)));
    }

    return [...common];
  }

  // Single branch: extract literal fragments, then get trigrams from each
  const literals = extractLiteralsFromRegex(pattern);
  if (literals.length === 0) return [];

  // Collect trigrams from all literal fragments (AND semantics)
  const allTrigrams = new Set();
  for (const lit of literals) {
    for (const tri of extractTrigrams(lit)) {
      allTrigrams.add(tri);
    }
  }

  return [...allTrigrams];
}

/**
 * Extract required literal substrings from a regex pattern.
 *
 * Strategy (based on Google Code Search approach):
 * - Split on metacharacters to find contiguous literal runs
 * - Handle alternation: take intersection of trigrams from each branch
 * - Handle escaped characters (\. \( etc.) as literals
 * - Keep fragments >= 3 chars (needed for at least one trigram)
 */
export function extractLiteralsFromRegex(pattern) {
  // Handle top-level alternation by recursing into branches
  const alternatives = splitTopLevelAlternation(pattern);
  if (alternatives.length > 1) {
    // For alternation at this level, return empty — alternation is handled
    // by patternToTrigrams at the trigram level (intersection).
    return [];
  }

  return extractLiteralsFromBranch(pattern);
}

/**
 * Extract literal fragments from a single regex branch (no top-level alternation).
 */
function extractLiteralsFromBranch(pattern) {
  // Single branch: extract literal fragments by walking the pattern
  const fragments = [];
  let current = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      // Common regex escapes that represent literal characters
      if ('.()[]{}*+?|^$'.includes(next)) {
        current += next;
        i += 2;
        continue;
      }
      // \w, \d, \s, \b etc. break the literal run
      flushFragment(current, fragments);
      current = '';
      i += 2;
      continue;
    }

    if (ch === '[') {
      // Character class — skip until closing ]
      flushFragment(current, fragments);
      current = '';
      i++;
      if (i < pattern.length && pattern[i] === '^') i++;
      if (i < pattern.length && pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i++;
      i++; // skip ]
      continue;
    }

    if (ch === '(' || ch === ')') {
      // Groups — don't break literals, just skip the metachar
      flushFragment(current, fragments);
      current = '';
      i++;
      // Skip non-capturing group syntax (?:, (?=, (?!, etc.
      if (ch === '(' && i < pattern.length && pattern[i] === '?') {
        i++;
        while (i < pattern.length && pattern[i] !== ')' && pattern[i] !== ':' && !isAlpha(pattern[i])) i++;
        if (i < pattern.length && pattern[i] === ':') i++;
      }
      continue;
    }

    if ('.+*?{^$'.includes(ch)) {
      // Metacharacter — breaks literal run
      flushFragment(current, fragments);
      current = '';
      i++;
      // Skip quantifier ranges like {2,3}
      if (ch === '{') {
        while (i < pattern.length && pattern[i] !== '}') i++;
        if (i < pattern.length) i++;
      }
      continue;
    }

    // Regular literal character
    current += ch;
    i++;
  }

  flushFragment(current, fragments);
  return fragments;
}

function flushFragment(str, fragments) {
  if (str.length >= 3) {
    fragments.push(str);
  }
}

function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * Split a regex pattern on top-level (unescaped, un-grouped) pipe characters.
 */
function splitTopLevelAlternation(pattern) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === '\\' && i + 1 < pattern.length) {
      current += ch + pattern[i + 1];
      i++;
      continue;
    }

    if (inCharClass) {
      current += ch;
      if (ch === ']') inCharClass = false;
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }

    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  parts.push(current);
  return parts;
}
