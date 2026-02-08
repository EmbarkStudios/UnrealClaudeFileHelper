#!/usr/bin/env node

/**
 * Full reindex: clean database, restart service, run watcher full scan.
 * Shows live progress dashboard during indexing.
 *
 * Usage: node scripts/full-reindex.js
 *        node scripts/full-reindex.js --keep-db    (skip DB wipe, just reconcile)
 *        node scripts/full-reindex.js --yes         (skip confirmation)
 */

import { spawnSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, createReadStream } from 'fs';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVICE_URL = 'http://127.0.0.1:3847';
const keepDb = process.argv.includes('--keep-db');
const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

// --- WSL helpers (use spawnSync to avoid cmd.exe quote mangling) ---
// NOTE: use ~ instead of $HOME in paths — JS string escaping mangles $HOME

function wsl(cmd) {
  const result = spawnSync('wsl', ['--', 'bash', '-c', cmd], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`WSL command failed (exit ${result.status}): ${cmd.slice(0, 80)}`);
  }
}

function wslQuiet(cmd) {
  spawnSync('wsl', ['--', 'bash', '-c', cmd], { stdio: 'pipe' });
}

// --- User confirmation ---

async function confirm(message) {
  if (skipConfirm) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// --- Service helpers ---

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function waitForService(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await fetchJson(`${SERVICE_URL}/health`);
      if (data.status === 'ok') return data;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Service not ready after ${timeoutMs / 1000}s`);
}

// --- Dashboard ---

const state = {
  phase: 'init',
  startTime: Date.now(),
  currentProject: '',
  currentProjectTotal: 0,    // total files for current project
  currentProjectStartTime: 0,
  projectProgress: '',
  projectsComplete: [],       // [{name, files, timeS}]
  dbCounts: {},
  dbMemory: 0,
  watcherLines: [],
  scanComplete: false,
};

function fmt(n) {
  return n.toLocaleString();
}

function elapsed() {
  const s = Math.floor((Date.now() - state.startTime) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function renderDashboard() {
  const lines = [];

  lines.push('\x1b[1m=== Unreal Index — Full Reindex ===\x1b[0m');
  lines.push('');

  const phaseLabels = {
    init: 'Initializing...',
    stopping: 'Stopping service...',
    cleaning: 'Cleaning database...',
    syncing: 'Syncing code to WSL...',
    starting: 'Starting service...',
    waiting: 'Waiting for service...',
    scanning: 'Scanning files...',
    watching: 'Scan complete — live watching for changes',
  };
  const phaseIcon = state.scanComplete ? '\x1b[32m✓\x1b[0m' : '\x1b[33m●\x1b[0m';
  lines.push(`${phaseIcon} Phase: ${phaseLabels[state.phase] || state.phase}  (${elapsed()})`);
  lines.push('');

  if (state.phase === 'scanning' && state.currentProject) {
    lines.push(`\x1b[36m▸\x1b[0m ${state.currentProject}: ${state.projectProgress}`);
    lines.push('');
  }

  if (state.projectsComplete.length > 0) {
    lines.push('\x1b[1mCompleted:\x1b[0m');
    for (const p of state.projectsComplete) {
      lines.push(`  \x1b[32m✓\x1b[0m ${p.name}: ${fmt(p.files)} files (${p.timeS})`);
    }
    lines.push('');
  }

  const counts = Object.entries(state.dbCounts);
  if (counts.length > 0) {
    lines.push('\x1b[1mDatabase:\x1b[0m');
    for (const [lang, count] of counts) {
      lines.push(`  ${lang}: ${fmt(count)}`);
    }
    const total = counts.reduce((s, [, c]) => s + c, 0);
    lines.push(`  \x1b[1mtotal: ${fmt(total)}\x1b[0m`);
    if (state.dbMemory) {
      lines.push(`  service RSS: ${state.dbMemory} MB`);
    }
    lines.push('');
  }

  if (state.watcherLines.length > 0) {
    lines.push('\x1b[2mWatcher output:\x1b[0m');
    for (const l of state.watcherLines.slice(-5)) {
      lines.push(`  \x1b[2m${l}\x1b[0m`);
    }
  }

  if (state.scanComplete) {
    lines.push('');
    lines.push('\x1b[32mPress Ctrl+C to stop. Service stays running in WSL.\x1b[0m');
  }

  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(lines.join('\n') + '\n');
}

async function pollStatus() {
  try {
    const status = await fetchJson(`${SERVICE_URL}/internal/status`);
    state.dbCounts = status.counts || {};
  } catch {}
  try {
    const health = await fetchJson(`${SERVICE_URL}/health`);
    state.dbMemory = health.memoryMB?.rss || 0;
  } catch {}
}

function finishCurrentProject() {
  if (state.currentProject && state.currentProjectTotal > 0) {
    const elapsed = state.currentProjectStartTime
      ? ((Date.now() - state.currentProjectStartTime) / 1000).toFixed(1) + 's'
      : '';
    // Avoid duplicates
    if (!state.projectsComplete.some(p => p.name === state.currentProject)) {
      state.projectsComplete.push({
        name: state.currentProject,
        files: state.currentProjectTotal,
        timeS: elapsed,
      });
    }
  }
  state.currentProject = '';
  state.currentProjectTotal = 0;
  state.projectProgress = '';
}

function parseWatcherLine(line) {
  // [Watcher] Collected 4086 files from Discovery (200ms)
  const collectMatch = line.match(/Collected (\d+) files? from (\S+)/);
  if (collectMatch) {
    // A new project is starting — finalize the previous one
    finishCurrentProject();
    state.currentProject = collectMatch[2];
    state.currentProjectTotal = parseInt(collectMatch[1]);
    state.currentProjectStartTime = Date.now();
    state.projectProgress = `scanning ${fmt(state.currentProjectTotal)} files...`;
  }

  // [Watcher] Discovery: 500/4086 files
  const progressMatch = line.match(/(\S+): ([\d,]+)\/([\d,]+) (files|assets)$/);
  if (progressMatch) {
    state.currentProject = progressMatch[1];
    state.currentProjectTotal = parseInt(progressMatch[3].replace(/,/g, ''));
    state.projectProgress = `${progressMatch[2]} / ${progressMatch[3]} ${progressMatch[4]}`;
  }

  // [Watcher] Discovery: 500/4086 files reconciled
  const reconcileMatch = line.match(/(\S+): ([\d,]+)\/([\d,]+) (files|assets) reconciled/);
  if (reconcileMatch) {
    state.currentProject = reconcileMatch[1];
    state.currentProjectTotal = parseInt(reconcileMatch[3].replace(/,/g, ''));
    state.projectProgress = `${reconcileMatch[2]} / ${reconcileMatch[3]} ${reconcileMatch[4]} reconciled`;
  }

  // [Watcher] Discovery: up to date (5000 files, scan 200ms)
  const upToDateMatch = line.match(/(\S+): up to date \((\d+) files/);
  if (upToDateMatch) {
    state.projectsComplete.push({
      name: upToDateMatch[1],
      files: parseInt(upToDateMatch[2]),
      timeS: 'up to date'
    });
    state.currentProject = '';
    state.currentProjectTotal = 0;
    state.projectProgress = '';
  }

  // [Watcher] Discovery: 500 changed, 3 deleted (of 5000 on disk, scan 200ms)
  const reconcileSummary = line.match(/(\S+): (\d+) changed, (\d+) deleted \(of (\d+) on disk/);
  if (reconcileSummary) {
    state.currentProject = reconcileSummary[1];
    const changed = parseInt(reconcileSummary[2]);
    const deleted = parseInt(reconcileSummary[3]);
    const total = parseInt(reconcileSummary[4]);
    state.currentProjectTotal = changed;
    state.currentProjectStartTime = Date.now();
    state.projectProgress = `${fmt(changed)} changed, ${fmt(deleted)} deleted (of ${fmt(total)} on disk)`;
  }

  // [Watcher] Full scan complete (120.5s)
  if (line.includes('Full scan complete')) {
    finishCurrentProject();
    state.scanComplete = true;
    state.phase = 'watching';
  }

  // [Watcher] Reconciliation complete
  if (line.includes('Reconciliation complete')) {
    finishCurrentProject();
    state.scanComplete = true;
    state.phase = 'watching';
  }

  if (line.includes('Reconciling populated languages')) {
    state.phase = 'scanning';
  }

  if (line.includes('Starting full scan')) {
    state.phase = 'scanning';
  }

  // [Watcher] Watching N paths for changes
  if (line.includes('Watching') && line.includes('paths for changes')) {
    finishCurrentProject();
    if (!state.scanComplete) {
      state.scanComplete = true;
      state.phase = 'watching';
    }
  }

  const cleaned = line.replace(/^\[Watcher\]\s*/, '').trim();
  if (cleaned) {
    state.watcherLines.push(cleaned);
    if (state.watcherLines.length > 20) {
      state.watcherLines = state.watcherLines.slice(-20);
    }
  }
}

// --- Code sync ---

function syncToWSL() {
  const winMnt = ROOT.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/mnt/${d.toLowerCase()}`);
  wsl(`rsync -a --delete ${winMnt}/src/ ~/repos/unreal-index/src/`);
  wsl(`cp ${winMnt}/config.json ~/repos/unreal-index/config.json`);
  wsl(`cp ${winMnt}/package.json ~/repos/unreal-index/package.json`);
  wsl(`cp ${winMnt}/start-service.sh ~/repos/unreal-index/start-service.sh`);
  // Fix CRLF line endings on shell scripts (Windows git checkout may add \r)
  wsl('find ~/repos/unreal-index -name "*.sh" -exec sed -i "s/\\r$//" {} +');
}

// --- Main ---

async function main() {
  // Load config to show project info
  const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
  const projects = config.projects || [];
  const sourceProjects = projects.filter(p => p.language !== 'content');
  const contentProjects = projects.filter(p => p.language === 'content');

  // Show what we're about to do and ask for confirmation
  console.log('\x1b[1m=== Unreal Index — Full Reindex ===\x1b[0m\n');

  if (keepDb) {
    console.log('Mode: \x1b[36mReconcile\x1b[0m (keep existing data, re-ingest only changes)\n');
  } else {
    console.log('Mode: \x1b[33mClean reindex\x1b[0m (wipe database and rebuild from scratch)\n');
  }

  console.log(`Projects (${projects.length}):`);
  for (const p of projects) {
    const paths = p.paths.map(pp => pp.replace(/\\/g, '/')).join(', ');
    console.log(`  ${p.name} (${p.language}) — ${paths}`);
  }

  console.log(`\nService: ${SERVICE_URL}`);
  console.log(`Database: ~/.unreal-index/index.db (WSL ext4)`);

  if (!keepDb) {
    console.log('\n\x1b[33mThis will delete the existing database, mirror, and zoekt index.\x1b[0m');
  }

  console.log('');
  const ok = await confirm('Continue? (y/N) ');
  if (!ok) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('');
  state.startTime = Date.now();

  // Step 1: Stop service
  state.phase = 'stopping';
  renderDashboard();
  wslQuiet('screen -S unreal-index -X quit');
  wslQuiet('lsof -ti:3847 | xargs kill -9 2>/dev/null || true');
  await new Promise(r => setTimeout(r, 1000));

  // Step 2: Clean database (unless --keep-db)
  if (!keepDb) {
    state.phase = 'cleaning';
    renderDashboard();
    wsl('rm -f ~/.unreal-index/index.db ~/.unreal-index/index.db-wal ~/.unreal-index/index.db-shm');
    wsl('rm -rf ~/.unreal-index/mirror/*');
    wsl('rm -rf ~/.unreal-index/zoekt-index/*');
  }

  // Step 3: Sync code
  state.phase = 'syncing';
  renderDashboard();
  syncToWSL();

  // Step 4: Start service via start-service.sh (handles PATH + screen)
  state.phase = 'starting';
  renderDashboard();
  wsl('cd ~/repos/unreal-index && bash start-service.sh --bg');

  state.phase = 'waiting';
  renderDashboard();
  await waitForService();

  // Step 5: Start watcher with output capture
  state.phase = 'scanning';
  renderDashboard();

  const watcher = spawn('node', [join(ROOT, 'src', 'watcher', 'watcher-client.js')], {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: ROOT
  });

  const rlOut = readline.createInterface({ input: watcher.stdout });
  rlOut.on('line', (line) => {
    parseWatcherLine(line);
    renderDashboard();
  });

  const rlErr = readline.createInterface({ input: watcher.stderr });
  rlErr.on('line', (line) => {
    parseWatcherLine(line);
    renderDashboard();
  });

  const pollInterval = setInterval(async () => {
    await pollStatus();
    renderDashboard();
  }, 3000);

  watcher.on('exit', (code) => {
    clearInterval(pollInterval);
    state.phase = code === 0 ? 'done' : 'error';
    renderDashboard();
    console.log(`\nWatcher exited with code ${code}`);
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    clearInterval(pollInterval);
    watcher.kill('SIGINT');
    console.log('\n\nStopped. Service is still running in WSL (screen -r unreal-index).');
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
