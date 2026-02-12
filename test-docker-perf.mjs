#!/usr/bin/env node
/**
 * Docker Performance Test for Unreal Index Service
 *
 * Six test phases targeting Docker-specific concerns:
 * 1. Container startup time
 * 2. Core performance suite (sequential, concurrent, sustained, ramp-up)
 * 3. Container restart recovery
 * 4. Ingest under query load
 * 5. Memory pressure monitoring
 * 6. Volume I/O benchmark
 *
 * Optional --long-run flag for 30-minute sustained test.
 * Optional --baseline <file> for comparison against WSL baseline.
 */

import { execSync, exec } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

const BASE_URL = 'http://localhost:3847';
const args = process.argv.slice(2);
const longRun = args.includes('--long-run');
const baselineIdx = args.indexOf('--baseline');
const baselineFile = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

// --- Query definitions (same as perf-stress-test.mjs) ---
const QUERIES = [
  { name: 'find-type-exact/AActor', url: '/find-type?name=AActor', weight: 3 },
  { name: 'find-type-exact/UObject', url: '/find-type?name=UObject', weight: 2 },
  { name: 'find-type-exact/APlayerController', url: '/find-type?name=APlayerController', weight: 2 },
  { name: 'find-type-exact/FVector', url: '/find-type?name=FVector', weight: 2 },
  { name: 'find-type-exact/UActorComponent', url: '/find-type?name=UActorComponent', weight: 1 },
  { name: 'find-type-exact/APawn', url: '/find-type?name=APawn', weight: 1 },
  { name: 'find-type-exact/UGameplayAbility', url: '/find-type?name=UGameplayAbility', weight: 1 },
  { name: 'find-type-fuzzy/Actor', url: '/find-type?name=Actor&fuzzy=true', weight: 3 },
  { name: 'find-type-fuzzy/Player', url: '/find-type?name=Player&fuzzy=true', weight: 2 },
  { name: 'find-type-fuzzy/Widget', url: '/find-type?name=Widget&fuzzy=true', weight: 2 },
  { name: 'find-type-fuzzy/Component', url: '/find-type?name=Component&fuzzy=true', weight: 2 },
  { name: 'find-type-fuzzy/GameState', url: '/find-type?name=GameState&fuzzy=true', weight: 1 },
  { name: 'find-type-fuzzy/Animation', url: '/find-type?name=Animation&fuzzy=true', weight: 1 },
  { name: 'find-type-fuzzy/Damage', url: '/find-type?name=Damage&fuzzy=true', weight: 1 },
  { name: 'find-member-exact/BeginPlay', url: '/find-member?name=BeginPlay', weight: 3 },
  { name: 'find-member-exact/Tick', url: '/find-member?name=Tick', weight: 2 },
  { name: 'find-member-exact/GetOwner', url: '/find-member?name=GetOwner', weight: 1 },
  { name: 'find-member-exact/SetActorLocation', url: '/find-member?name=SetActorLocation', weight: 1 },
  { name: 'find-member-exact/Destroy', url: '/find-member?name=Destroy', weight: 1 },
  { name: 'find-member-fuzzy/Begin', url: '/find-member?name=Begin&fuzzy=true', weight: 2 },
  { name: 'find-member-fuzzy/OnDamage', url: '/find-member?name=OnDamage&fuzzy=true', weight: 2 },
  { name: 'find-member-fuzzy/GetWorld', url: '/find-member?name=GetWorld&fuzzy=true', weight: 1 },
  { name: 'find-member-fuzzy/Initialize', url: '/find-member?name=Initialize&fuzzy=true', weight: 1 },
  { name: 'find-file/Actor', url: '/find-file?filename=Actor', weight: 2 },
  { name: 'find-file/PlayerController', url: '/find-file?filename=PlayerController', weight: 1 },
  { name: 'find-file/GameMode', url: '/find-file?filename=GameMode', weight: 1 },
  { name: 'find-file/Widget', url: '/find-file?filename=Widget', weight: 1 },
  { name: 'find-children/AActor', url: '/find-children?parent=AActor', weight: 2 },
  { name: 'find-children/UObject', url: '/find-children?parent=UObject', weight: 1 },
  { name: 'find-children/APawn', url: '/find-children?parent=APawn', weight: 1 },
  { name: 'find-children-recursive/AActor', url: '/find-children?parent=AActor&recursive=true', weight: 1 },
  { name: 'find-children-recursive/UActorComponent', url: '/find-children?parent=UActorComponent&recursive=true', weight: 1 },
  { name: 'find-asset/BP_Player', url: '/find-asset?name=BP_Player', weight: 2 },
  { name: 'find-asset/M_Default', url: '/find-asset?name=M_Default', weight: 1 },
  { name: 'find-asset/Widget', url: '/find-asset?name=Widget&fuzzy=true', weight: 1 },
  { name: 'browse-module/Engine', url: '/browse-module?module=Engine', weight: 1 },
  { name: 'list-modules', url: '/list-modules', weight: 1 },
  { name: 'list-modules/Engine', url: '/list-modules?parent=Engine', weight: 1 },
  { name: 'grep/BeginPlay', url: '/grep?pattern=BeginPlay&maxResults=50', weight: 1 },
  { name: 'grep/UPROPERTY', url: '/grep?pattern=UPROPERTY&maxResults=50', weight: 1 },
  { name: 'health', url: '/health', weight: 1 },
  { name: 'stats', url: '/stats', weight: 1 },
];

// --- Helpers ---
function buildWeightedPool(queries) {
  const pool = [];
  for (const q of queries) {
    for (let i = 0; i < q.weight; i++) pool.push(q);
  }
  return pool;
}

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

async function fetchTimed(url) {
  const start = performance.now();
  try {
    const resp = await fetch(url);
    const durationMs = performance.now() - start;
    const body = await resp.text();
    return { durationMs, ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return { durationMs: performance.now() - start, ok: false, status: 0, error: err.message };
  }
}

async function waitForHealth(timeoutSec = 30) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutSec * 1000) {
    try {
      const resp = await fetch(`${BASE_URL}/health`);
      if (resp.ok) return (Date.now() - start) / 1000;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function dockerCompose(cmd) {
  return execSync(`docker compose ${cmd}`, { encoding: 'utf-8', stdio: 'pipe' });
}

// --- Latency tracker ---
class LatencyTracker {
  constructor() {
    this.byEndpoint = new Map();
    this.allTimes = [];
    this.totalErrors = 0;
    this.startTime = 0;
  }

  record(name, durationMs, isError) {
    if (!this.byEndpoint.has(name)) {
      this.byEndpoint.set(name, { times: [], errors: 0 });
    }
    const ep = this.byEndpoint.get(name);
    if (isError) {
      ep.errors++;
      this.totalErrors++;
    } else {
      ep.times.push(durationMs);
      this.allTimes.push(durationMs);
    }
  }

  summarize(label) {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const total = this.allTimes.length + this.totalErrors;
    const rps = total / elapsed;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  ${label}`);
    console.log(`${'='.repeat(80)}`);
    console.log(`  Total: ${total} | Errors: ${this.totalErrors} | Duration: ${elapsed.toFixed(1)}s | Throughput: ${rps.toFixed(1)} req/s`);
    console.log(`  Latency: p50=${percentile(this.allTimes, 50).toFixed(1)}ms  p95=${percentile(this.allTimes, 95).toFixed(1)}ms  p99=${percentile(this.allTimes, 99).toFixed(1)}ms  max=${percentile(this.allTimes, 100).toFixed(1)}ms`);
    console.log(`${'='.repeat(80)}\n`);
    return {
      total,
      errors: this.totalErrors,
      durationSec: elapsed,
      rps,
      p50: percentile(this.allTimes, 50),
      p95: percentile(this.allTimes, 95),
      p99: percentile(this.allTimes, 99),
      max: percentile(this.allTimes, 100)
    };
  }

  toJSON() {
    return {
      total: this.allTimes.length + this.totalErrors,
      errors: this.totalErrors,
      p50: percentile(this.allTimes, 50),
      p95: percentile(this.allTimes, 95),
      p99: percentile(this.allTimes, 99),
      max: percentile(this.allTimes, 100)
    };
  }
}

// --- Concurrent runner ---
async function runConcurrent(tracker, pool, concurrency, totalOrDurationSec, useTimeout = false) {
  tracker.startTime = Date.now();
  let completed = 0;
  let inflight = 0;
  let idx = 0;
  const deadline = useTimeout ? Date.now() + totalOrDurationSec * 1000 : Infinity;
  const totalRequests = useTimeout ? Infinity : totalOrDurationSec;

  return new Promise((resolve) => {
    function launch() {
      while (inflight < concurrency && idx < totalRequests && Date.now() < deadline) {
        const q = pickRandom(pool);
        inflight++;
        idx++;
        fetchTimed(`${BASE_URL}${q.url}`).then(({ durationMs, ok }) => {
          tracker.record(q.name, durationMs, !ok);
          completed++;
          inflight--;
          if ((!useTimeout && completed >= totalRequests) || (useTimeout && Date.now() >= deadline && inflight === 0)) {
            resolve(completed);
          } else if ((useTimeout && Date.now() < deadline) || (!useTimeout && completed < totalRequests)) {
            launch();
          }
        });
      }
    }
    launch();
  });
}

// --- Phase 1: Container Startup Time ---
async function phase1_startup() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 1: Container Startup Time                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Check if container is running
  let wasRunning = false;
  try {
    const status = execSync('docker compose ps --format json', { encoding: 'utf-8', stdio: 'pipe' });
    wasRunning = status.includes('"running"');
  } catch {}

  if (wasRunning) {
    console.log('  Container is already running, stopping first...');
    dockerCompose('down');
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('  Starting container...');
  const startTime = Date.now();
  dockerCompose('up -d');
  const healthTime = await waitForHealth(60);

  if (healthTime === null) {
    console.error('  FAIL: Container did not become healthy within 60s');
    return { startupTimeSec: null, pass: false };
  }

  console.log(`  Container healthy in ${healthTime.toFixed(1)}s`);
  const pass = healthTime < 20;
  console.log(`  Target: <20s — ${pass ? 'PASS' : 'FAIL'}`);

  return { startupTimeSec: healthTime, pass };
}

// --- Phase 2: Core Performance Suite ---
async function phase2_corePerformance() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 2: Core Performance Suite                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const pool = buildWeightedPool(QUERIES);
  const results = {};

  // Sequential baseline
  console.log('\n  --- Sequential Baseline (1 req at a time, all queries) ---');
  const seqTracker = new LatencyTracker();
  seqTracker.startTime = Date.now();
  for (const q of QUERIES) {
    const { durationMs, ok } = await fetchTimed(`${BASE_URL}${q.url}`);
    seqTracker.record(q.name, durationMs, !ok);
    process.stdout.write('.');
  }
  console.log(' done');
  results.sequential = seqTracker.summarize('Sequential Baseline');

  // Concurrent burst
  console.log('  --- Concurrent Burst (20 concurrent, 600 total) ---');
  const burstTracker = new LatencyTracker();
  await runConcurrent(burstTracker, pool, 20, 600);
  results.burst = burstTracker.summarize('Concurrent Burst');

  // Sustained load
  console.log('  --- Sustained Load (20 concurrent, 30s) ---');
  const sustainedTracker = new LatencyTracker();
  await runConcurrent(sustainedTracker, pool, 20, 30, true);
  results.sustained = sustainedTracker.summarize('Sustained Load (30s)');

  // Ramp-up
  console.log('  --- Ramp-up (1 → 50 concurrent, 5s per step) ---');
  const rampTracker = new LatencyTracker();
  rampTracker.startTime = Date.now();
  const steps = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  const rampSteps = [];
  for (const concurrency of steps) {
    const stepTracker = new LatencyTracker();
    await runConcurrent(stepTracker, pool, concurrency, 5, true);
    const stepCompleted = stepTracker.allTimes.length;
    const rps = stepCompleted / 5;
    const p50 = percentile(stepTracker.allTimes, 50);
    const p99 = percentile(stepTracker.allTimes, 99);
    console.log(`    concurrency=${String(concurrency).padStart(3)}: ${String(stepCompleted).padStart(5)} reqs, ${rps.toFixed(0).padStart(5)} req/s, p50=${p50.toFixed(1).padStart(7)}ms, p99=${p99.toFixed(1).padStart(7)}ms`);
    rampSteps.push({ concurrency, requests: stepCompleted, rps, p50, p99 });
    // Also record into overall tracker
    for (const t of stepTracker.allTimes) rampTracker.allTimes.push(t);
    rampTracker.totalErrors += stepTracker.totalErrors;
  }
  results.rampUp = { steps: rampSteps, ...rampTracker.summarize('Ramp-up') };

  return results;
}

// --- Phase 3: Container Restart Recovery ---
async function phase3_restart() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 3: Container Restart Recovery                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  console.log('  Restarting container...');
  const restartStart = Date.now();
  dockerCompose('restart');
  const healthTime = await waitForHealth(60);

  if (healthTime === null) {
    console.error('  FAIL: Container did not recover within 60s');
    return { restartTimeSec: null, pass: false };
  }

  // healthTime is from our polling start, but restart command also takes time
  const totalTime = (Date.now() - restartStart) / 1000;
  console.log(`  Container recovered in ${totalTime.toFixed(1)}s (health responded at ${healthTime.toFixed(1)}s after polling started)`);
  const pass = totalTime < 20;
  console.log(`  Target: <20s — ${pass ? 'PASS' : 'FAIL'}`);

  return { restartTimeSec: totalTime, pass };
}

// --- Phase 4: Ingest Under Query Load ---
async function phase4_ingestUnderLoad() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 4: Ingest Under Query Load                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const pool = buildWeightedPool(QUERIES);

  // First, measure baseline read latency
  console.log('  Measuring baseline read latency (10s, 20 concurrent)...');
  const baselineTracker = new LatencyTracker();
  await runConcurrent(baselineTracker, pool, 20, 10, true);
  const baselineP95 = percentile(baselineTracker.allTimes, 95);
  console.log(`  Baseline p95: ${baselineP95.toFixed(1)}ms`);

  // Now run reads and ingests concurrently
  console.log('  Running reads + ingest concurrently (15s)...');
  const readTracker = new LatencyTracker();
  readTracker.startTime = Date.now();
  const ingestResults = { sent: 0, errors: 0, totalMs: 0 };

  const deadline = Date.now() + 15000;

  // Generate synthetic files for ingest
  function makeSyntheticFile(i) {
    return {
      path: `/test/synthetic/TestFile${i}.as`,
      relativePath: `TestProject/Source/TestFile${i}.as`,
      project: 'TestProject',
      language: 'angelscript',
      content: `// Synthetic test file ${i}\nclass ASyntheticTest${i} : AActor\n{\n  UPROPERTY()\n  float TestValue${i} = ${i}.0f;\n\n  void BeginPlay() override\n  {\n    Super::BeginPlay();\n  }\n}\n`,
      mtime: Date.now()
    };
  }

  // Ingest loop
  const ingestPromise = (async () => {
    let fileIdx = 0;
    while (Date.now() < deadline) {
      const files = [];
      for (let j = 0; j < 10; j++) {
        files.push(makeSyntheticFile(fileIdx++));
      }
      const start = performance.now();
      try {
        const resp = await fetch(`${BASE_URL}/internal/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, assets: [], deletes: [] })
        });
        const ms = performance.now() - start;
        ingestResults.totalMs += ms;
        ingestResults.sent += files.length;
        if (!resp.ok) ingestResults.errors++;
      } catch {
        ingestResults.errors++;
      }
      // Small delay to avoid overwhelming
      await new Promise(r => setTimeout(r, 100));
    }
  })();

  // Read loop (concurrent)
  const readPromise = runConcurrent(readTracker, pool, 20, 15, true);

  await Promise.all([ingestPromise, readPromise]);

  const loadP95 = percentile(readTracker.allTimes, 95);
  const degradation = baselineP95 > 0 ? ((loadP95 - baselineP95) / baselineP95 * 100) : 0;

  console.log(`  Under-load p95: ${loadP95.toFixed(1)}ms (${degradation > 0 ? '+' : ''}${degradation.toFixed(1)}% vs baseline)`);
  console.log(`  Ingest: ${ingestResults.sent} files sent, ${ingestResults.errors} errors`);

  // Clean up synthetic files
  try {
    await fetch(`${BASE_URL}/internal/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [], assets: [], deletes: [{ path: '/test/synthetic/', prefix: true }] })
    });
  } catch {}

  return {
    baselineP95,
    underLoadP95: loadP95,
    degradationPct: degradation,
    ingestFilesSent: ingestResults.sent,
    ingestErrors: ingestResults.errors
  };
}

// --- Phase 5: Memory Pressure Monitoring ---
async function phase5_memoryPressure() {
  const durationMin = longRun ? 30 : 5;
  const sampleIntervalSec = longRun ? 60 : 30;

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Phase 5: Memory Pressure (${durationMin}min sustained, 20 concurrent)     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  const pool = buildWeightedPool(QUERIES);
  const tracker = new LatencyTracker();
  tracker.startTime = Date.now();
  const memorySamples = [];
  const deadline = Date.now() + durationMin * 60 * 1000;

  // Memory sampling loop
  const samplePromise = (async () => {
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${BASE_URL}/health`);
        const health = await resp.json();
        memorySamples.push({
          timestamp: Date.now(),
          rss: health.memoryMB?.rss || 0,
          heapUsed: health.memoryMB?.heapUsed || 0,
          heapTotal: health.memoryMB?.heapTotal || 0
        });
        const sample = memorySamples[memorySamples.length - 1];
        const elapsed = ((Date.now() - tracker.startTime) / 1000).toFixed(0);
        console.log(`  [${elapsed}s] RSS: ${sample.rss}MB | Heap: ${sample.heapUsed}MB / ${sample.heapTotal}MB | Requests: ${tracker.allTimes.length}`);
      } catch {}
      await new Promise(r => setTimeout(r, sampleIntervalSec * 1000));
    }
  })();

  // Load generation
  const loadPromise = runConcurrent(tracker, pool, 20, durationMin * 60, true);

  await Promise.all([samplePromise, loadPromise]);

  const finalSample = memorySamples[memorySamples.length - 1];
  const firstSample = memorySamples[0];
  const rssGrowth = finalSample ? (finalSample.rss - firstSample.rss) : 0;
  const rssMax = Math.max(...memorySamples.map(s => s.rss));
  const rssUnder3500 = rssMax < 3500;

  console.log(`\n  Memory summary:`);
  console.log(`    RSS max: ${rssMax}MB — ${rssUnder3500 ? 'PASS (<3500MB)' : 'FAIL (>=3500MB)'}`);
  console.log(`    RSS growth: ${rssGrowth > 0 ? '+' : ''}${rssGrowth}MB over ${durationMin}min`);

  const stats = tracker.summarize(`Memory Pressure (${durationMin}min)`);

  // Check for latency degradation in long-run mode
  let latencyDegradation = null;
  if (longRun && tracker.allTimes.length > 1000) {
    const firstQuarter = tracker.allTimes.slice(0, Math.floor(tracker.allTimes.length / 4));
    const lastQuarter = tracker.allTimes.slice(Math.floor(tracker.allTimes.length * 3 / 4));
    const firstP99 = percentile(firstQuarter, 99);
    const lastP99 = percentile(lastQuarter, 99);
    latencyDegradation = firstP99 > 0 ? ((lastP99 - firstP99) / firstP99 * 100) : 0;
    const pass = latencyDegradation < 50;
    console.log(`    p99 degradation: ${latencyDegradation.toFixed(1)}% (first vs last quarter) — ${pass ? 'PASS (<50%)' : 'FAIL (>=50%)'}`);
  }

  return {
    durationMin,
    memorySamples,
    rssMax,
    rssGrowth,
    rssPass: rssUnder3500,
    latencyDegradation,
    ...stats
  };
}

// --- Phase 6: Volume I/O Benchmark ---
async function phase6_volumeIO() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Phase 6: Volume I/O Benchmark                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const totalFiles = 1000;
  const batchSize = 50;
  console.log(`  Ingesting ${totalFiles} synthetic files in batches of ${batchSize}...`);

  function makeBatch(startIdx, count) {
    const files = [];
    for (let i = startIdx; i < startIdx + count; i++) {
      files.push({
        path: `/test/volumeio/VolumeTest${i}.as`,
        relativePath: `VolumeTestProject/Source/VolumeTest${i}.as`,
        project: 'VolumeTestProject',
        language: 'angelscript',
        content: `// Volume I/O test file ${i}\nclass AVolumeTest${i} : AActor\n{\n  UPROPERTY()\n  float Value = ${i}.0f;\n\n  UFUNCTION()\n  void DoSomething${i}()\n  {\n    Print("Test ${i}");\n  }\n}\n`,
        mtime: Date.now()
      });
    }
    return files;
  }

  const ingestStart = performance.now();
  let totalSent = 0;
  let errors = 0;

  for (let i = 0; i < totalFiles; i += batchSize) {
    const count = Math.min(batchSize, totalFiles - i);
    const files = makeBatch(i, count);
    try {
      const resp = await fetch(`${BASE_URL}/internal/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, assets: [], deletes: [] })
      });
      if (!resp.ok) errors++;
      totalSent += count;
    } catch {
      errors++;
    }
    if (totalSent % 200 === 0) process.stdout.write(`\r  ${totalSent}/${totalFiles}`);
  }

  const ingestMs = performance.now() - ingestStart;
  const filesPerSec = totalSent / (ingestMs / 1000);

  console.log(`\r  ${totalSent}/${totalFiles} done`);
  console.log(`  Ingest time: ${(ingestMs / 1000).toFixed(1)}s`);
  console.log(`  Throughput: ${filesPerSec.toFixed(0)} files/sec`);
  console.log(`  Errors: ${errors}`);

  // Clean up
  try {
    await fetch(`${BASE_URL}/internal/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [], assets: [], deletes: [{ path: '/test/volumeio/', prefix: true }] })
    });
  } catch {}

  return {
    totalFiles: totalSent,
    ingestTimeSec: ingestMs / 1000,
    filesPerSec,
    errors
  };
}

// --- Comparison ---
function printComparison(results, baseline) {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Docker vs Baseline Comparison                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const rows = [];
  function addRow(metric, docker, wsl, unit = 'ms') {
    if (docker == null || wsl == null) return;
    const diff = wsl > 0 ? ((docker - wsl) / wsl * 100).toFixed(1) : 'N/A';
    rows.push({ metric, docker: docker.toFixed(1), wsl: wsl.toFixed(1), unit, diff: `${diff}%` });
  }

  if (results.corePerformance?.burst && baseline.burst) {
    addRow('Burst p50', results.corePerformance.burst.p50, baseline.burst.p50);
    addRow('Burst p95', results.corePerformance.burst.p95, baseline.burst.p95);
    addRow('Burst p99', results.corePerformance.burst.p99, baseline.burst.p99);
    addRow('Burst throughput', results.corePerformance.burst.rps, baseline.burst.rps, 'req/s');
  }

  if (results.corePerformance?.sustained && baseline.sustained) {
    addRow('Sustained p95', results.corePerformance.sustained.p95, baseline.sustained.p95);
    addRow('Sustained throughput', results.corePerformance.sustained.rps, baseline.sustained.rps, 'req/s');
  }

  if (rows.length === 0) {
    console.log('  No comparable metrics found in baseline file.');
    return;
  }

  console.log(`\n  ${'Metric'.padEnd(25)} ${'Docker'.padStart(10)} ${'Baseline'.padStart(10)} ${'Unit'.padStart(8)} ${'Diff'.padStart(10)}`);
  console.log(`  ${'-'.repeat(25)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(10)}`);
  for (const r of rows) {
    console.log(`  ${r.metric.padEnd(25)} ${r.docker.padStart(10)} ${r.wsl.padStart(10)} ${r.unit.padStart(8)} ${r.diff.padStart(10)}`);
  }
  console.log('');
}

// --- Main ---
async function main() {
  console.log('');
  console.log('+====================================================================+');
  console.log('|      Unreal Index - Docker Performance Test                         |');
  console.log('+====================================================================+');
  if (longRun) console.log('  Mode: --long-run (30 minute sustained test)');
  if (baselineFile) console.log(`  Baseline: ${baselineFile}`);

  const results = {};

  // Phase 1
  results.startup = await phase1_startup();

  // Phase 2
  results.corePerformance = await phase2_corePerformance();

  // Phase 3
  results.restart = await phase3_restart();

  // Phase 4
  results.ingestUnderLoad = await phase4_ingestUnderLoad();

  // Phase 5
  results.memoryPressure = await phase5_memoryPressure();

  // Phase 6
  results.volumeIO = await phase6_volumeIO();

  // Baseline comparison
  if (baselineFile) {
    try {
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
      printComparison(results, baseline);
    } catch (err) {
      console.error(`  Could not load baseline: ${err.message}`);
    }
  }

  // Save results
  const outFile = `docker-perf-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outFile}`);

  // Final summary
  console.log('\n+====================================================================+');
  console.log('|                    DOCKER PERF TEST COMPLETE                       |');
  console.log('+====================================================================+');

  const checks = [
    { name: 'Startup time', pass: results.startup.pass, detail: `${results.startup.startupTimeSec?.toFixed(1) || 'N/A'}s (target: <20s)` },
    { name: 'Restart recovery', pass: results.restart.pass, detail: `${results.restart.restartTimeSec?.toFixed(1) || 'N/A'}s (target: <20s)` },
    { name: 'Burst errors', pass: results.corePerformance.burst.errors === 0, detail: `${results.corePerformance.burst.errors} errors` },
    { name: 'RSS under limit', pass: results.memoryPressure.rssPass, detail: `max ${results.memoryPressure.rssMax}MB (limit: 3500MB)` },
    { name: 'Volume I/O', pass: results.volumeIO.errors === 0, detail: `${results.volumeIO.filesPerSec.toFixed(0)} files/sec` },
  ];

  if (results.memoryPressure.latencyDegradation != null) {
    checks.push({
      name: 'Latency stability',
      pass: results.memoryPressure.latencyDegradation < 50,
      detail: `${results.memoryPressure.latencyDegradation.toFixed(1)}% degradation (limit: 50%)`
    });
  }

  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Docker perf test failed:', err);
  process.exit(1);
});
