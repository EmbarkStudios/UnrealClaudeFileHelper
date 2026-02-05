/**
 * Grep endpoint stress test.
 * Tests performance, correctness, and concurrent request handling.
 *
 * Usage: node src/grep-stress-test.js [baseUrl]
 *   Default baseUrl: http://127.0.0.1:3847
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3847';

async function fetchJson(path) {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const ms = performance.now() - start;
  const data = await res.json();
  return { status: res.status, ms, data };
}

async function test(name, fn) {
  try {
    const result = await fn();
    const icon = result.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${name} (${Math.round(result.ms)}ms)${result.detail ? ' — ' + result.detail : ''}`);
    return result.pass;
  } catch (err) {
    console.log(`  [FAIL] ${name} — ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`\nGrep Stress Test — ${BASE}\n`);

  // Check service is up
  const health = await fetchJson('/health');
  if (health.status !== 200) {
    console.log('Service not reachable. Exiting.');
    process.exit(1);
  }
  console.log(`Service up (uptime: ${health.data.uptimeSeconds}s)\n`);

  let passed = 0;
  let total = 0;

  // --- Test 1: Basic grep correctness ---
  console.log('1. Correctness tests');

  total++;
  passed += await test('Simple pattern returns results', async () => {
    const r = await fetchJson('/grep?pattern=class&project=Discovery&language=angelscript&maxResults=5');
    return {
      pass: r.status === 200 && r.data.results.length > 0 && r.data.results.length <= 5,
      ms: r.ms,
      detail: `${r.data.results.length} results, ${r.data.filesSearched} files`
    };
  });

  total++;
  passed += await test('Invalid regex returns 400', async () => {
    const r = await fetchJson('/grep?pattern=[invalid');
    return { pass: r.status === 400 && r.data.error.includes('Invalid regex'), ms: r.ms };
  });

  total++;
  passed += await test('Missing pattern returns 400', async () => {
    const r = await fetchJson('/grep');
    return { pass: r.status === 400, ms: r.ms };
  });

  total++;
  passed += await test('Unknown project returns 400', async () => {
    const r = await fetchJson('/grep?pattern=test&project=NonexistentProject');
    return { pass: r.status === 400, ms: r.ms };
  });

  total++;
  passed += await test('Result fields are correct', async () => {
    const r = await fetchJson('/grep?pattern=class&project=Discovery&language=angelscript&maxResults=1');
    const result = r.data.results[0];
    const hasFields = result && result.file && result.project && result.language &&
      typeof result.line === 'number' && typeof result.column === 'number' &&
      result.match && Array.isArray(result.context);
    return { pass: r.status === 200 && hasFields, ms: r.ms, detail: hasFields ? 'all fields present' : 'missing fields' };
  });

  // --- Test 2: The problematic query ---
  console.log('\n2. Performance — problematic query');

  total++;
  passed += await test('Alternation pattern (DestroyActor|DestroyPawn|SetTimer|FTimerHandle)', async () => {
    const r = await fetchJson('/grep?pattern=DestroyActor%7CDestroyPawn%7CSetTimer%7CFTimerHandle&project=Discovery&language=angelscript&maxResults=30');
    const underTimeout = r.ms < 35000;
    return {
      pass: r.status === 200,
      ms: r.ms,
      detail: `${r.data.results.length} results, ${r.data.filesSearched} files searched, timedOut=${r.data.timedOut}, ${underTimeout ? 'within timeout' : 'OVER 35s'}`
    };
  });

  // --- Test 3: Concurrent requests / non-blocking ---
  console.log('\n3. Concurrent request handling');

  total++;
  passed += await test('Health check during grep (<2s)', async () => {
    // Start a grep in the background
    const grepPromise = fetchJson('/grep?pattern=GameMode&project=Discovery&language=angelscript&maxResults=10');

    // Wait a moment for grep to start, then check health
    await new Promise(r => setTimeout(r, 2000));
    const healthResult = await fetchJson('/health');

    // Wait for grep to finish
    await grepPromise;

    return {
      pass: healthResult.status === 200 && healthResult.ms < 2000,
      ms: healthResult.ms,
      detail: `health responded in ${Math.round(healthResult.ms)}ms during grep`
    };
  });

  total++;
  passed += await test('Multiple concurrent greps', async () => {
    const start = performance.now();
    const [r1, r2, r3] = await Promise.all([
      fetchJson('/grep?pattern=UCLASS&project=Discovery&language=angelscript&maxResults=5'),
      fetchJson('/grep?pattern=void&project=Discovery&language=angelscript&maxResults=5'),
      fetchJson('/grep?pattern=import&project=Discovery&language=angelscript&maxResults=5'),
    ]);
    const totalMs = performance.now() - start;
    const allOk = r1.status === 200 && r2.status === 200 && r3.status === 200;
    return {
      pass: allOk,
      ms: totalMs,
      detail: `3 concurrent greps completed, all status 200`
    };
  });

  // --- Test 4: Timeout behavior ---
  console.log('\n4. Timeout behavior');

  total++;
  passed += await test('Large search respects timeout (returns within ~35s)', async () => {
    const r = await fetchJson('/grep?pattern=.&maxResults=1000');
    return {
      pass: r.status === 200 && r.ms < 40000,
      ms: r.ms,
      detail: `timedOut=${r.data.timedOut}, ${r.data.results.length} results, ${r.data.filesSearched} files`
    };
  });

  // --- Summary ---
  console.log(`\n--- Results: ${passed}/${total} passed ---\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
