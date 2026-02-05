import { extractTrigrams, patternToTrigrams, contentHash, encodeTrigram } from './src/service/trigram.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [FAIL] ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\nTrigram Module Tests\n');

test('extractTrigrams returns trigrams', () => {
  const tri = extractTrigrams('Hello World');
  assert(tri.size > 0, `Expected trigrams, got ${tri.size}`);
});

test('extractTrigrams is case-insensitive', () => {
  const tri1 = extractTrigrams('ABC');
  const tri2 = extractTrigrams('abc');
  assert(tri1.size === tri2.size, 'Different sizes');
  const [v1] = tri1;
  const [v2] = tri2;
  assert(v1 === v2, 'Different values');
});

test('extractTrigrams skips newlines', () => {
  const tri = extractTrigrams('ab\ncd');
  assert(tri.size === 0, `Expected 0, got ${tri.size}`);
});

test('extractTrigrams counts correctly for short string', () => {
  const tri = extractTrigrams('abcde');
  assert(tri.size === 3, `Expected 3, got ${tri.size}`);
});

test('encodeTrigram packs correctly', () => {
  const t = encodeTrigram(0x61, 0x62, 0x63);
  assert(t === (0x61 << 16 | 0x62 << 8 | 0x63), 'Bad encoding');
});

test('contentHash is consistent', () => {
  const h1 = contentHash('hello');
  const h2 = contentHash('hello');
  assert(h1 === h2, 'Same content should give same hash');
});

test('contentHash is unique', () => {
  const h1 = contentHash('hello');
  const h3 = contentHash('world');
  assert(h1 !== h3, 'Different content should give different hash');
});

test('patternToTrigrams literal string', () => {
  const tri = patternToTrigrams('DestroyActor', false);
  assert(tri.length === 10, `Expected 10, got ${tri.length}`);
});

test('patternToTrigrams simple regex with literal parts', () => {
  const tri = patternToTrigrams('UPROPERTY.*EditAnywhere');
  assert(tri.length > 0, `Expected >0, got ${tri.length}`);
});

test('patternToTrigrams unindexable pattern', () => {
  const tri = patternToTrigrams('.*');
  assert(tri.length === 0, `Expected 0, got ${tri.length}`);
});

test('patternToTrigrams regex alternation with common prefix', () => {
  const tri = patternToTrigrams('DestroyActor|DestroyPawn');
  assert(tri.length > 0, `Expected >0, got ${tri.length}`);
});

test('patternToTrigrams short alternation branches', () => {
  const tri = patternToTrigrams('a|b');
  assert(tri.length === 0, `Expected 0, got ${tri.length}`);
});

test('patternToTrigrams escaped metachar', () => {
  const tri = patternToTrigrams('foo\\.bar');
  assert(tri.length === 5, `Expected 5, got ${tri.length}`);
});

test('patternToTrigrams character class breaks literal', () => {
  const tri = patternToTrigrams('abc[xyz]def');
  assert(tri.length === 2, `Expected 2, got ${tri.length}`);
});

console.log(`\n--- Results: ${passed}/${passed + failed} passed ---\n`);
process.exit(failed > 0 ? 1 : 0);
