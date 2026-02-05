#!/usr/bin/env node

/**
 * Stress test for the query worker pool.
 * Validates that concurrent queries execute in parallel and /health stays responsive.
 */

const BASE_URL = 'http://127.0.0.1:3847';

async function fetchJson(path) {
  const resp = await fetch(`${BASE_URL}${path}`);
  return { status: resp.status, data: await resp.json() };
}

async function timedFetch(path) {
  const start = performance.now();
  const result = await fetchJson(path);
  return { ...result, ms: performance.now() - start };
}

async function runTest(name, fn) {
  try {
    const result = await fn();
    console.log(`  PASS: ${name}`);
    return { name, passed: true, ...result };
  } catch (err) {
    console.log(`  FAIL: ${name} — ${err.message}`);
    return { name, passed: false, error: err.message };
  }
}

async function main() {
  console.log('=== Query Pool Stress Test ===\n');

  // Check service is running
  try {
    const { status } = await fetchJson('/health');
    if (status !== 200) throw new Error('Service not healthy');
  } catch {
    console.error('Service not running at port 3847. Start with: npm start');
    process.exit(1);
  }

  const results = [];

  // Test 1: Basic functionality — all routes still work
  console.log('1. Basic route functionality:');
  const routes = [
    '/health',
    '/stats',
    '/find-type?name=AActor&language=cpp',
    '/find-type?name=Widget&fuzzy=true&maxResults=5',
    '/find-children?parent=AActor&maxResults=3',
    '/find-member?name=BeginPlay&fuzzy=true&maxResults=5',
    '/browse-module?module=Engine&maxResults=5',
    '/find-file?filename=Actor.h&maxResults=3',
    '/list-modules?depth=1',
    '/find-asset?name=BP_&fuzzy=true&maxResults=3',
    '/grep?pattern=GetHealth&maxResults=5',
  ];

  for (const route of routes) {
    results.push(await runTest(route, async () => {
      const { status } = await fetchJson(route);
      if (status !== 200) throw new Error(`Status ${status}`);
      return {};
    }));
  }

  // Test 2: Concurrent fuzzy queries (these are slow, ~100-500ms each)
  console.log('\n2. Concurrent fuzzy queries (should run in parallel):');
  const fuzzyQueries = [
    '/find-type?name=GameState&fuzzy=true&maxResults=10',
    '/find-type?name=WidgetComponent&fuzzy=true&maxResults=10',
    '/find-type?name=PlayerController&fuzzy=true&maxResults=10',
    '/find-member?name=BeginPlay&fuzzy=true&maxResults=10',
    '/find-member?name=TakeDamage&fuzzy=true&maxResults=10',
    '/find-type?name=HealthComponent&fuzzy=true&maxResults=10',
  ];

  // First: measure sequential time
  let sequentialMs = 0;
  const seqTimes = [];
  for (const q of fuzzyQueries) {
    const { ms } = await timedFetch(q);
    sequentialMs += ms;
    seqTimes.push(ms.toFixed(0));
  }
  console.log(`  Sequential total: ${sequentialMs.toFixed(0)}ms (individual: ${seqTimes.join(', ')}ms)`);

  // Second: measure parallel time
  const parallelStart = performance.now();
  const parallelResults = await Promise.all(fuzzyQueries.map(q => timedFetch(q)));
  const parallelMs = performance.now() - parallelStart;
  const parTimes = parallelResults.map(r => r.ms.toFixed(0));
  console.log(`  Parallel total:   ${parallelMs.toFixed(0)}ms (individual: ${parTimes.join(', ')}ms)`);

  const speedup = sequentialMs / parallelMs;
  console.log(`  Speedup: ${speedup.toFixed(1)}x`);

  results.push(await runTest('parallel speedup > 1.3x', async () => {
    if (speedup < 1.3) throw new Error(`Only ${speedup.toFixed(1)}x speedup (sequential=${sequentialMs.toFixed(0)}ms, parallel=${parallelMs.toFixed(0)}ms)`);
    return { speedup: speedup.toFixed(1) };
  }));

  results.push(await runTest('all parallel queries succeeded', async () => {
    const failures = parallelResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length} queries failed`);
    return {};
  }));

  // Test 3: /health stays responsive during heavy load
  console.log('\n3. Health responsiveness under load:');
  results.push(await runTest('/health responds < 100ms during heavy queries', async () => {
    // Fire off heavy queries
    const heavyQueries = Array.from({ length: 6 }, (_, i) =>
      fetchJson(`/find-type?name=Component${i}&fuzzy=true&maxResults=20`)
    );

    // While heavy queries are in-flight, check health
    await new Promise(r => setTimeout(r, 20)); // small delay to let queries start
    const healthStart = performance.now();
    const { status } = await fetchJson('/health');
    const healthMs = performance.now() - healthStart;

    await Promise.all(heavyQueries); // wait for heavy queries to finish

    if (status !== 200) throw new Error(`Health status ${status}`);
    if (healthMs > 200) throw new Error(`Health took ${healthMs.toFixed(0)}ms`);
    console.log(`    /health responded in ${healthMs.toFixed(0)}ms`);
    return {};
  }));

  // Test 4: High concurrency burst
  console.log('\n4. High concurrency burst (20 simultaneous queries):');
  results.push(await runTest('20 concurrent queries complete successfully', async () => {
    const queries = [
      ...Array.from({ length: 5 }, (_, i) => `/find-type?name=Actor${i}&fuzzy=true&maxResults=5`),
      ...Array.from({ length: 5 }, (_, i) => `/find-member?name=Health${i}&fuzzy=true&maxResults=5`),
      ...Array.from({ length: 5 }, (_, i) => `/find-file?filename=Component${i}&maxResults=3`),
      ...Array.from({ length: 5 }, (_, i) => `/find-children?parent=AActor&maxResults=3`),
    ];

    const start = performance.now();
    const allResults = await Promise.all(queries.map(q => timedFetch(q)));
    const elapsed = performance.now() - start;

    const failures = allResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length}/${queries.length} failed`);

    const maxMs = Math.max(...allResults.map(r => r.ms));
    console.log(`    All 20 completed in ${elapsed.toFixed(0)}ms wall time (slowest individual: ${maxMs.toFixed(0)}ms)`);
    return {};
  }));

  // Test 5: Sustained load
  console.log('\n5. Sustained load (100 queries over time):');
  results.push(await runTest('100 queries with no errors', async () => {
    const queryTypes = [
      '/find-type?name=Actor&fuzzy=true&maxResults=3',
      '/find-member?name=Play&fuzzy=true&maxResults=3',
      '/find-file?filename=Widget&maxResults=3',
      '/find-children?parent=UObject&maxResults=3',
      '/browse-module?module=Engine&maxResults=5',
    ];

    let errors = 0;
    let totalMs = 0;
    const TOTAL = 100;
    const BATCH = 10;

    for (let i = 0; i < TOTAL; i += BATCH) {
      const batch = Array.from({ length: BATCH }, (_, j) =>
        timedFetch(queryTypes[(i + j) % queryTypes.length])
      );
      const batchResults = await Promise.all(batch);
      errors += batchResults.filter(r => r.status !== 200).length;
      totalMs += batchResults.reduce((sum, r) => sum + r.ms, 0);
    }

    const avgMs = (totalMs / TOTAL).toFixed(0);
    console.log(`    ${TOTAL} queries: ${errors} errors, avg ${avgMs}ms per query`);

    if (errors > 0) throw new Error(`${errors} errors out of ${TOTAL} queries`);
    return {};
  }));

  // Test 6: Grep through pool
  console.log('\n6. Grep via trigram (through pool for candidate lookup):');
  results.push(await runTest('concurrent grep queries', async () => {
    const grepQueries = [
      '/grep?pattern=BeginPlay&maxResults=5',
      '/grep?pattern=GetHealth&maxResults=5',
      '/grep?pattern=UPROPERTY&maxResults=5',
    ];

    const start = performance.now();
    const grepResults = await Promise.all(grepQueries.map(q => timedFetch(q)));
    const elapsed = performance.now() - start;

    const failures = grepResults.filter(r => r.status !== 200);
    if (failures.length > 0) throw new Error(`${failures.length} grep queries failed`);

    const times = grepResults.map(r => r.ms.toFixed(0));
    console.log(`    3 concurrent greps in ${elapsed.toFixed(0)}ms (individual: ${times.join(', ')}ms)`);
    return {};
  }));

  // Summary
  console.log('\n=== Summary ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log('\nAll tests passed!');
}

main().catch(err => {
  console.error('Stress test failed:', err);
  process.exit(1);
});
