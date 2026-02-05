#!/usr/bin/env node

/**
 * Performance test suite for Unreal Index API.
 * Tests all endpoints, collects timing metrics, and supports concurrent load testing.
 *
 * Usage: node src/perf-test.js [baseUrl] [--concurrent N] [--iterations N]
 *   Default baseUrl: http://127.0.0.1:3847
 *   --concurrent N: Run N concurrent requests (default: 1)
 *   --iterations N: Run N iterations per test (default: 10)
 */

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:3847';
const ITERATIONS = parseInt(process.argv.find(a => a.startsWith('--iterations='))?.split('=')[1]) || 10;
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--concurrent='))?.split('=')[1]) || 1;

// Store all results for final summary
const allResults = [];

async function fetchJson(path) {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const ms = performance.now() - start;
  const data = await res.json();
  return { status: res.status, ms, data };
}

function calcStats(times) {
  if (times.length === 0) return { min: 0, max: 0, avg: 0, p95: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1]
  };
}

async function runBenchmark(name, path, iterations = ITERATIONS) {
  const times = [];
  const errors = [];

  for (let i = 0; i < iterations; i++) {
    try {
      const result = await fetchJson(path);
      if (result.status === 200) {
        times.push(result.ms);
      } else {
        errors.push(`Status ${result.status}`);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  const stats = calcStats(times);
  const result = {
    name,
    path,
    iterations,
    successful: times.length,
    errors: errors.length,
    ...stats
  };

  allResults.push(result);

  const status = errors.length === 0 ? 'OK' : `${errors.length} errors`;
  console.log(`  ${name.padEnd(25)} min=${stats.min.toFixed(0).padStart(5)}ms  avg=${stats.avg.toFixed(0).padStart(5)}ms  p95=${stats.p95.toFixed(0).padStart(5)}ms  max=${stats.max.toFixed(0).padStart(5)}ms  [${status}]`);

  return result;
}

async function runConcurrentBenchmark(name, path, concurrency = CONCURRENCY, iterations = ITERATIONS) {
  const times = [];
  const errors = [];
  const totalRequests = concurrency * iterations;

  for (let batch = 0; batch < iterations; batch++) {
    const start = performance.now();
    const promises = Array(concurrency).fill(null).map(() => fetchJson(path));
    const results = await Promise.all(promises);
    const batchMs = performance.now() - start;

    // Record batch time (all concurrent requests)
    times.push(batchMs);

    for (const r of results) {
      if (r.status !== 200) {
        errors.push(`Status ${r.status}`);
      }
    }
  }

  const stats = calcStats(times);
  const throughput = (totalRequests / (times.reduce((a, b) => a + b, 0) / 1000)).toFixed(1);

  const result = {
    name,
    path,
    concurrency,
    iterations,
    totalRequests,
    successful: totalRequests - errors.length,
    errors: errors.length,
    throughput: parseFloat(throughput),
    ...stats
  };

  allResults.push(result);

  console.log(`  ${name.padEnd(25)} ${concurrency}x concurrent: avg=${stats.avg.toFixed(0).padStart(5)}ms/batch  throughput=${throughput.padStart(5)} req/s`);

  return result;
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Unreal Index Performance Test`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Base URL: ${BASE}`);
  console.log(`Iterations: ${ITERATIONS}, Concurrency: ${CONCURRENCY}`);
  console.log(`${'='.repeat(70)}\n`);

  // Check service is up
  try {
    const health = await fetchJson('/health');
    if (health.status !== 200) {
      console.log('Service not reachable. Start with: npm start');
      process.exit(1);
    }
    console.log(`Service up (uptime: ${health.data.uptimeSeconds}s, heap: ${health.data.memoryMB?.heapUsed?.toFixed(0) || '?'}MB)\n`);
  } catch (err) {
    console.log(`Service not reachable at ${BASE}. Start with: npm start`);
    process.exit(1);
  }

  // Get initial stats for representative test data
  const stats = await fetchJson('/stats');
  console.log(`Index stats: ${stats.data.totalFiles} files, ${stats.data.totalTypes} types, ${stats.data.totalMembers || 0} members\n`);

  // ============================================================
  // 1. Baseline endpoint tests (sequential)
  // ============================================================
  console.log('1. BASELINE ENDPOINT TESTS (sequential)\n');

  // Health & Status
  console.log('  --- Health & Status ---');
  await runBenchmark('/health', '/health');
  await runBenchmark('/status', '/status');
  await runBenchmark('/stats (cached)', '/stats');
  await runBenchmark('/summary', '/summary');

  // Type searches
  console.log('\n  --- Type Searches ---');
  await runBenchmark('/find-type exact', '/find-type?name=AActor&language=cpp');
  await runBenchmark('/find-type fuzzy', '/find-type?name=Actor&fuzzy=true&maxResults=20');
  await runBenchmark('/find-type prefix', '/find-type?name=Widget&fuzzy=true&maxResults=20');

  // Children (known bottleneck)
  console.log('\n  --- Inheritance Queries (known bottleneck) ---');
  await runBenchmark('/find-children shallow', '/find-children?parent=AActor&recursive=false&maxResults=20');
  await runBenchmark('/find-children deep', '/find-children?parent=AActor&recursive=true&maxResults=50');
  await runBenchmark('/find-children UObject', '/find-children?parent=UObject&recursive=true&maxResults=100');

  // Member searches
  console.log('\n  --- Member Searches ---');
  await runBenchmark('/find-member exact', '/find-member?name=BeginPlay&maxResults=20');
  await runBenchmark('/find-member fuzzy', '/find-member?name=Health&fuzzy=true&maxResults=20');
  await runBenchmark('/find-member +type', '/find-member?name=Tick&containingType=AActor&fuzzy=true');

  // File searches (N+1 issue)
  console.log('\n  --- File Searches (N+1 issue) ---');
  await runBenchmark('/find-file exact', '/find-file?filename=Actor.h&maxResults=10');
  await runBenchmark('/find-file fuzzy', '/find-file?filename=Widget&maxResults=20');
  await runBenchmark('/find-file broad', '/find-file?filename=Component&maxResults=20');

  // Module browsing (unbounded fetch issue)
  console.log('\n  --- Module Browsing (unbounded fetch issue) ---');
  await runBenchmark('/list-modules root', '/list-modules?depth=1');
  await runBenchmark('/list-modules deep', '/list-modules?parent=Engine&depth=2');
  await runBenchmark('/browse-module', '/browse-module?module=Engine&maxResults=50');

  // Asset searches
  console.log('\n  --- Asset Searches ---');
  await runBenchmark('/find-asset exact', '/find-asset?name=BP_&fuzzy=true&maxResults=20');
  await runBenchmark('/asset-stats', '/asset-stats');

  // Grep (trigram index)
  console.log('\n  --- Content Search (Grep) ---');
  await runBenchmark('/grep simple', '/grep?pattern=class&project=Discovery&language=angelscript&maxResults=10');
  await runBenchmark('/grep alternation', '/grep?pattern=DestroyActor|SetTimer&project=Discovery&language=angelscript&maxResults=20');
  await runBenchmark('/grep regex', '/grep?pattern=void.*Begin&project=Discovery&language=angelscript&maxResults=10');

  // ============================================================
  // 2. Concurrent load tests
  // ============================================================
  if (CONCURRENCY > 1) {
    console.log(`\n2. CONCURRENT LOAD TESTS (${CONCURRENCY}x)\n`);

    await runConcurrentBenchmark('/stats concurrent', '/stats', CONCURRENCY);
    await runConcurrentBenchmark('/find-type concurrent', '/find-type?name=Actor&fuzzy=true&maxResults=10', CONCURRENCY);
    await runConcurrentBenchmark('/find-file concurrent', '/find-file?filename=Actor&maxResults=10', CONCURRENCY);
    await runConcurrentBenchmark('/find-member concurrent', '/find-member?name=Tick&fuzzy=true&maxResults=10', CONCURRENCY);
    await runConcurrentBenchmark('/grep concurrent', '/grep?pattern=class&project=Discovery&language=angelscript&maxResults=5', CONCURRENCY);
  }

  // ============================================================
  // 3. Memory check
  // ============================================================
  console.log('\n3. MEMORY CHECK\n');
  const finalHealth = await fetchJson('/health');
  console.log(`  Heap used: ${finalHealth.data.memoryMB?.heapUsed?.toFixed(0) || '?'}MB`);
  console.log(`  Heap total: ${finalHealth.data.memoryMB?.heapTotal?.toFixed(0) || '?'}MB`);
  console.log(`  RSS: ${finalHealth.data.memoryMB?.rss?.toFixed(0) || '?'}MB`);

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(70)}\n`);

  // Sort by P95 latency (slowest first)
  const sorted = allResults
    .filter(r => !r.concurrency)  // Only sequential tests
    .sort((a, b) => b.p95 - a.p95);

  console.log('Top 5 slowest endpoints (by P95):');
  for (const r of sorted.slice(0, 5)) {
    console.log(`  ${r.name.padEnd(30)} P95: ${r.p95.toFixed(0)}ms`);
  }

  console.log('\nAll endpoints:');
  console.log('  Endpoint                      Min      Avg      P95      Max');
  console.log('  ' + '-'.repeat(60));
  for (const r of allResults.filter(r => !r.concurrency)) {
    console.log(`  ${r.name.padEnd(28)} ${r.min.toFixed(0).padStart(5)}ms  ${r.avg.toFixed(0).padStart(5)}ms  ${r.p95.toFixed(0).padStart(5)}ms  ${r.max.toFixed(0).padStart(5)}ms`);
  }

  // Export results as JSON for comparison
  const outputPath = `perf-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), base: BASE, iterations: ITERATIONS, concurrency: CONCURRENCY, results: allResults }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
