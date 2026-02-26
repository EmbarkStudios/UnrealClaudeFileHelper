#!/usr/bin/env node

// Standalone web-based setup GUI for unreal-index.
// Zero npm dependencies — uses only Node.js built-ins.
// Usage: node src/setup-gui.js [port]

import http from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, statSync, openSync, closeSync } from 'fs';
import { join, dirname, basename, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec, spawn, execFileSync, execFile } from 'child_process';
import { gzipSync } from 'zlib';

import {
  fwd,
  loadWorkspacesConfig as _loadWorkspacesConfig,
  loadWorkspaceConfig as _loadWorkspaceConfig,
  ensureWorkspacesDefaults,
  getWorkspaceMemoryLimitGB as _getWorkspaceMemoryLimitGB,
  generateDockerComposeContent,
} from './workspace-utils.js';
import { startWorkspaceWatcher } from './setup-watcher-start.js';

// Prevent unhandled rejections from silently crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[setup-gui] Unhandled rejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const WORKSPACES_PATH = join(ROOT, 'workspaces.json');
const WORKSPACE_CONFIGS_DIR = join(ROOT, 'workspace-configs');
const DOCKER_COMPOSE_PATH = join(ROOT, 'docker-compose.yml');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = parseInt(process.argv[2]) || 3846;

// ── Utilities ──────────────────────────────────────────────

function findUProjectFile(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.uproject')) {
        return join(dir, entry.name);
      }
    }
  } catch { /* */ }
  return null;
}

// ── Workspaces config I/O ───────────────────────────────────
// Thin wrappers around workspace-utils.js that bind ROOT and add caching.

function loadWorkspacesConfig() {
  try {
    return _loadWorkspacesConfig(ROOT);
  } catch {
    return null;
  }
}

function saveWorkspacesConfig(wsConfig) {
  writeFileSync(WORKSPACES_PATH, JSON.stringify(wsConfig, null, 2) + '\n');
  _wsConfigCache = { data: wsConfig, ts: Date.now() }; // bust cache on write
}

// Cached workspaces config — avoids re-reading from disk on every proxy request
let _wsConfigCache = { data: null, ts: 0 };
function loadWorkspacesConfigCached() {
  if (Date.now() - _wsConfigCache.ts < 5000 && _wsConfigCache.data) {
    return _wsConfigCache.data;
  }
  const data = loadWorkspacesConfig();
  _wsConfigCache = { data, ts: Date.now() };
  return data;
}

function getNextAvailablePort(wsConfig) {
  const usedPorts = new Set(Object.values(wsConfig.workspaces || {}).map(w => w.port));
  let port = 3847;
  while (usedPorts.has(port)) port++;
  return port;
}

// ── Per-workspace config I/O ────────────────────────────────

function saveWorkspaceConfig(workspaceName, config) {
  mkdirSync(WORKSPACE_CONFIGS_DIR, { recursive: true });
  const configPath = join(WORKSPACE_CONFIGS_DIR, `${workspaceName}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return configPath;
}

function loadWorkspaceConfig(workspaceName) {
  return _loadWorkspaceConfig(ROOT, workspaceName);
}

// ── Docker compose generation ───────────────────────────────

function getWorkspaceMemoryLimitGB(wsConfig, workspaceName) {
  return _getWorkspaceMemoryLimitGB(wsConfig, workspaceName, ROOT);
}

function generateDockerCompose(wsConfig) {
  writeFileSync(DOCKER_COMPOSE_PATH, generateDockerComposeContent(wsConfig, ROOT));
}

// ── Detection ──────────────────────────────────────────────

function scanForBuildCs(dir, depth = 3) {
  if (depth <= 0) return false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.Build.cs')) return true;
      if (entry.isDirectory() && depth > 1) {
        if (scanForBuildCs(join(dir, entry.name), depth - 1)) return true;
      }
    }
  } catch { /* */ }
  return false;
}

function detectDirectories(projectRoot) {
  const candidates = [];
  const checks = [
    { subdir: 'Script', language: 'angelscript', label: 'Script/' },
    { subdir: 'Source', language: 'cpp', label: 'Source/' },
    { subdir: 'Plugins', language: 'cpp', label: 'Plugins/' },
    { subdir: 'Content', language: 'content', label: 'Content/' },
    { subdir: 'Config', language: 'config', label: 'Config/' },
  ];
  for (const check of checks) {
    const dir = join(projectRoot, check.subdir);
    if (existsSync(dir)) {
      candidates.push({ dir: fwd(dir), label: check.label, language: check.language });
    }
  }
  // Check for C# Build files in Source/
  const sourceDir = join(projectRoot, 'Source');
  if (existsSync(sourceDir)) {
    try {
      const hasBuildCs = scanForBuildCs(sourceDir);
      if (hasBuildCs) {
        candidates.push({ dir: fwd(sourceDir), label: 'Source/ (C# Build files)', language: 'csharp' });
      }
    } catch { /* */ }
  }
  return candidates;
}

function detectEngineRoot(projectRoot) {
  let dir = dirname(projectRoot);
  for (let i = 0; i < 5; i++) {
    const engineSource = join(dir, 'Engine', 'Source');
    if (existsSync(engineSource)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectEngineDirectories(engineRoot) {
  const candidates = [];
  for (const sub of [join('Engine', 'Source'), join('Engine', 'Plugins')]) {
    const dir = join(engineRoot, sub);
    if (existsSync(dir)) {
      candidates.push({ dir: fwd(dir), label: sub.replace(/\\/g, '/'), language: 'cpp' });
    }
  }
  return candidates;
}

function buildProjectsFromSelections(selections, projectName) {
  const byLanguage = {};
  for (const sel of selections) {
    if (!byLanguage[sel.language]) byLanguage[sel.language] = [];
    byLanguage[sel.language].push(sel.dir);
  }

  const projects = [];
  if (byLanguage.angelscript) {
    projects.push({ name: projectName, paths: byLanguage.angelscript, language: 'angelscript' });
  }
  if (byLanguage.cpp) {
    projects.push({ name: `${projectName}-Cpp`, paths: byLanguage.cpp, language: 'cpp' });
  }
  if (byLanguage.content) {
    projects.push({
      name: `${projectName}-Content`, paths: byLanguage.content, language: 'content',
      contentRoot: byLanguage.content[0], extensions: ['.uasset', '.umap'],
    });
  }
  if (byLanguage.config) {
    projects.push({
      name: `${projectName}-Config`, paths: byLanguage.config, language: 'config',
      extensions: ['.ini'],
    });
  }
  if (byLanguage.csharp) {
    projects.push({
      name: `${projectName}-CSharp`, paths: byLanguage.csharp, language: 'csharp',
      extensions: ['.cs'], includePatterns: ['*.Build.cs', '*.Target.cs', '*.Automation.cs'],
    });
  }
  return projects;
}

// ── Prerequisites ─────────────────────────────────────────

function checkAllPrerequisites() {
  const result = {
    node: { ok: false, version: null, required: '20.18.0' },
    wsl: { ok: false, status: 'unknown' },
    dockerEngine: { ok: false, version: null },
    dockerCompose: { ok: false, version: null },
    dockerDaemon: { ok: false },
    dockerGroup: false,
    envVar: { ok: false, path: null },
    allOk: false,
  };

  // Node.js — check running process version
  const nodeVer = process.versions.node;
  result.node.version = nodeVer;
  const [major, minor] = nodeVer.split('.').map(Number);
  result.node.ok = major > 20 || (major === 20 && minor >= 18);

  // WSL
  try {
    execFileSync('wsl', ['--status'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    result.wsl.ok = true;
    result.wsl.status = 'ok';
  } catch (err) {
    const stderr = (err.stderr || err.message || '').toLowerCase();
    if (stderr.includes('not recognized') || stderr.includes('not found') || stderr.includes('is not recognized')) {
      result.wsl.status = 'not_installed';
    } else if (stderr.includes('not installed') || stderr.includes('no installed distributions')) {
      result.wsl.status = 'no_distro';
    } else {
      // wsl --status may return non-zero even when working
      try {
        execFileSync('wsl', ['--', 'echo', 'ok'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
        result.wsl.ok = true;
        result.wsl.status = 'ok';
      } catch {
        result.wsl.status = 'error';
      }
    }
  }

  // Docker Engine (only if WSL ok)
  if (result.wsl.ok) {
    try {
      const ver = execFileSync('wsl', [
        '--', 'bash', '-c', 'docker --version 2>/dev/null',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();
      if (ver.includes('Docker')) {
        result.dockerEngine.ok = true;
        result.dockerEngine.version = ver;
      }
    } catch {}
  }

  // Docker Compose (only if Docker Engine ok)
  if (result.dockerEngine.ok) {
    try {
      const ver = execFileSync('wsl', [
        '--', 'bash', '-c', 'docker compose version 2>/dev/null',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();
      if (ver.includes('Docker Compose') || ver.includes('docker-compose')) {
        result.dockerCompose.ok = true;
        result.dockerCompose.version = ver;
      }
    } catch {}
  }

  // Docker Daemon (only if Docker Engine ok)
  if (result.dockerEngine.ok) {
    try {
      const out = execFileSync('wsl', [
        '--', 'bash', '-c', 'docker info >/dev/null 2>&1 && echo OK',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();
      result.dockerDaemon.ok = out.includes('OK');
    } catch {}
  }

  // Docker group membership
  if (result.wsl.ok) {
    try {
      const groups = execFileSync('wsl', [
        '--', 'bash', '-c', 'groups 2>/dev/null',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
      result.dockerGroup = groups.split(/\s+/).includes('docker');
    } catch {}
  }

  // UNREAL_INDEX_DIR environment variable
  if (process.platform === 'win32') {
    try {
      const envPath = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        "[Environment]::GetEnvironmentVariable('UNREAL_INDEX_DIR', 'User')",
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
      if (envPath && envPath !== '' && envPath !== 'null') {
        result.envVar.ok = true;
        result.envVar.path = envPath;
      }
    } catch {}
  } else {
    if (process.env.UNREAL_INDEX_DIR) {
      result.envVar.ok = true;
      result.envVar.path = process.env.UNREAL_INDEX_DIR;
    }
  }

  result.allOk = result.node.ok && result.wsl.ok && result.dockerEngine.ok
    && result.dockerCompose.ok && result.dockerDaemon.ok && result.envVar.ok;

  // Backward compat: include legacy fields
  result.docker = result.dockerCompose.ok && result.dockerDaemon.ok;
  result.dockerVersion = result.dockerCompose.version;

  return result;
}

// --- Docker status cache ---
// checkService() shells out to WSL (docker compose ps + docker stats) which takes 2-4s per workspace.
// Cache the results and refresh in the background so /api/workspaces responds instantly.
const _dockerStatusCache = new Map(); // workspaceName → { result, updatedAt }
const DOCKER_CACHE_MAX_AGE_MS = 10000; // serve cached for 10s

function checkService(workspaceName) {
  const cached = _dockerStatusCache.get(workspaceName);
  if (cached && Date.now() - cached.updatedAt < DOCKER_CACHE_MAX_AGE_MS) {
    return cached.result;
  }
  // Return stale cache immediately, refresh in background
  if (cached) {
    _refreshAllDockerStatusAsync();
    return cached.result;
  }
  // No cache yet (still warming up) — return unknown, don't block
  _refreshAllDockerStatusAsync();
  return { running: false, health: 'loading', memUsage: null, memLimit: null, memPercent: null };
}

function _checkServiceSync(workspaceName) {
  const result = { running: false, health: '', memUsage: null, memLimit: null, memPercent: null };
  try {
    let output;
    if (process.platform === 'win32') {
      const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
      output = execFileSync('wsl', [
        '--', 'bash', '-c', `cd "${wslRoot}" && docker compose ps ${workspaceName} --format json 2>/dev/null`,
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      output = execSync(`docker compose ps ${workspaceName} --format json`, {
        cwd: ROOT, encoding: 'utf-8', timeout: 5000,
      }).trim();
    }
    if (!output) return result;
    const info = JSON.parse(output);
    result.running = info.State === 'running';
    result.health = info.Health || '';
  } catch {
    return result;
  }

  if (result.running) {
    try {
      const containerName = `unreal-index-${workspaceName}`;
      let statsOutput;
      if (process.platform === 'win32') {
        statsOutput = execFileSync('wsl', [
          '--', 'bash', '-c', `docker stats ${containerName} --no-stream --format '{{.MemUsage}}|{{.MemPerc}}' 2>/dev/null`,
        ], { encoding: 'utf-8', timeout: 5000 }).trim();
      } else {
        statsOutput = execSync(`docker stats ${containerName} --no-stream --format '{{.MemUsage}}|{{.MemPerc}}'`, {
          encoding: 'utf-8', timeout: 5000,
        }).trim();
      }
      if (statsOutput) {
        const [usage, pct] = statsOutput.split('|');
        result.memUsage = usage?.trim() || null;
        result.memPercent = pct ? parseFloat(pct) : null;
        if (usage) {
          const parts = usage.split('/');
          result.memLimit = parts[1]?.trim() || null;
        }
      }
    } catch { /* stats unavailable, non-critical */ }
  }

  return result;
}

// Async Docker status check — does not block the event loop
// Uses execFile (not exec) to bypass cmd.exe shell and avoid quoting issues on Windows
function _execFileAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf-8', timeout: 8000, ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve((stdout || '').trim());
    });
  });
}

async function _checkServiceAsync(workspaceName) {
  const result = { running: false, health: '', memUsage: null, memLimit: null, memPercent: null };
  try {
    let output;
    if (process.platform === 'win32') {
      const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
      output = await _execFileAsync('wsl', [
        '--', 'bash', '-c', `cd "${wslRoot}" && docker compose ps ${workspaceName} --format json 2>/dev/null`,
      ]);
    } else {
      output = await _execFileAsync('docker', ['compose', 'ps', workspaceName, '--format', 'json'], { cwd: ROOT });
    }
    if (!output) return result;
    const info = JSON.parse(output);
    result.running = info.State === 'running';
    result.health = info.Health || '';
  } catch {
    return result;
  }

  if (result.running) {
    try {
      const containerName = `unreal-index-${workspaceName}`;
      let statsOutput;
      if (process.platform === 'win32') {
        statsOutput = await _execFileAsync('wsl', [
          '--', 'bash', '-c', `docker stats ${containerName} --no-stream --format '{{.MemUsage}}|{{.MemPerc}}' 2>/dev/null`,
        ]);
      } else {
        statsOutput = await _execFileAsync('docker', ['stats', containerName, '--no-stream', '--format', '{{.MemUsage}}|{{.MemPerc}}']);
      }
      if (statsOutput) {
        const [usage, pct] = statsOutput.split('|');
        result.memUsage = usage?.trim() || null;
        result.memPercent = pct ? parseFloat(pct) : null;
        if (usage) {
          const parts = usage.split('/');
          result.memLimit = parts[1]?.trim() || null;
        }
      }
    } catch { /* stats unavailable, non-critical */ }
  }

  return result;
}

let _refreshInFlight = false;
async function _refreshAllDockerStatusAsync() {
  if (_refreshInFlight) return;
  _refreshInFlight = true;
  try {
    const wsConfig = loadWorkspacesConfigCached();
    if (!wsConfig?.workspaces) return;
    // Check all workspaces in parallel
    const names = Object.keys(wsConfig.workspaces);
    const results = await Promise.all(names.map(name => _checkServiceAsync(name)));
    for (let i = 0; i < names.length; i++) {
      _dockerStatusCache.set(names[i], { result: results[i], updatedAt: Date.now() });
    }
  } finally {
    _refreshInFlight = false;
  }
}
// Initial warm-up after 500ms, then refresh every 10s — all non-blocking
setTimeout(_refreshAllDockerStatusAsync, 500);
setInterval(_refreshAllDockerStatusAsync, DOCKER_CACHE_MAX_AGE_MS);

// ── JSON body parser ──────────────────────────────────────

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// ── Static file serving ───────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

function serveStatic(req, res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const fstat = statSync(filePath);
  const etag = `"${fstat.mtimeMs.toString(36)}-${fstat.size.toString(36)}"`;

  // 304 Not Modified
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const maxAge = ext === '.html' ? 5 : 300; // HTML: 5s, JS/CSS: 5min
  const headers = {
    'Content-Type': mime,
    'Cache-Control': `public, max-age=${maxAge}`,
    'ETag': etag,
  };

  const content = readFileSync(filePath);
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptGzip && COMPRESSIBLE.has(ext) && content.length > 256) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(gzipSync(content));
  } else {
    res.writeHead(200, headers);
    res.end(content);
  }
}

// ── Drive scanning ────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Intermediate', 'Saved', 'Binaries',
  'DerivedDataCache', '.vs', '.idea', '__pycache__', 'Temp',
]);

function* scanForUProjects(startDirs, maxDepth = 4) {
  for (const startDir of startDirs) {
    if (!existsSync(startDir)) continue;
    const queue = [{ dir: startDir, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift();
      if (depth > maxDepth) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.uproject')) {
          yield { file: join(dir, entry.name), dir, name: entry.name.replace('.uproject', '') };
        }
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
  }
}

// ── Docker commands ───────────────────────────────────────

function getDockerPrefix() {
  // Determine if docker needs to run via WSL
  try {
    execSync('docker compose version', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return ''; // Docker available natively
  } catch {}
  if (process.platform === 'win32') {
    return 'wsl -- bash -c ';
  }
  return '';
}

function dockerComposePath() {
  return fwd(DOCKER_COMPOSE_PATH);
}

// ── SSE helper ────────────────────────────────────────────

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Router ─────────────────────────────────────────────────

const routes = {};

function route(method, path, handler) {
  routes[`${method} ${path}`] = handler;
}

function matchRoute(method, urlPath) {
  // Exact match first
  const exact = routes[`${method} ${urlPath}`];
  if (exact) return { handler: exact, params: {} };

  // Parameterized routes
  for (const [pattern, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = pattern.split(' ', 2);
    if (routeMethod !== method) continue;
    const routeParts = routePath.split('/');
    const urlParts = urlPath.split('/');
    if (routeParts.length !== urlParts.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = urlParts[i];
      } else if (routeParts[i] !== urlParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler, params };
  }
  return null;
}

// ── API Endpoints ──────────────────────────────────────────

// GET / — Serve setup.html
route('GET', '/', (req, res) => {
  serveStatic(req, res, join(PUBLIC_DIR, 'setup.html'));
});

// GET /api/health — Quick health check for frontend connectivity detection
route('GET', '/api/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, pid: process.pid, uptime: process.uptime() }));
});

// GET /api/prerequisites — Check all prerequisites
route('GET', '/api/prerequisites', (req, res) => {
  const prereqs = checkAllPrerequisites();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(prereqs));
});

// Fetch watcher status from a running workspace service
async function fetchWatcherStatus(port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://127.0.0.1:${port}/watcher-status`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    const activeWatchers = (data.watchers || []).filter(w => w.status === 'active');
    const w = activeWatchers[0];
    if (!w) return { hasActiveWatcher: false };
    const progress = w.progress || {};
    return {
      hasActiveWatcher: true,
      phase: progress.phase || 'unknown',
      projectProgress: progress.projectProgress || [],
    };
  } catch {
    return null;
  }
}

// GET /api/workspaces — Load workspaces + per-workspace configs + live status
route('GET', '/api/workspaces', async (req, res) => {
  let wsConfig = loadWorkspacesConfig();
  if (!wsConfig) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workspaces: {} }));
    return;
  }
  wsConfig = ensureWorkspacesDefaults(wsConfig);

  const result = { ...wsConfig };
  // Enrich each workspace with config, status, and memory info
  const watcherFetches = [];
  for (const [name, ws] of Object.entries(result.workspaces)) {
    ws.config = loadWorkspaceConfig(name);
    const status = checkService(name);
    ws.running = status.running;
    ws.health = status.health;
    ws.memUsage = status.memUsage || null;
    ws.memLimit = status.memLimit || null;
    ws.memPercent = status.memPercent || null;
    ws.computedMemLimitGB = getWorkspaceMemoryLimitGB(wsConfig, name);
    // Fetch watcher status for running workspaces
    if (ws.running) {
      watcherFetches.push(
        fetchWatcherStatus(ws.port).then(watcherStatus => { ws.watcherStatus = watcherStatus; })
      );
    }
  }
  // Await all watcher status fetches (with overall timeout)
  if (watcherFetches.length > 0) {
    await Promise.allSettled(watcherFetches);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});

// POST /api/workspaces — Create workspace
route('POST', '/api/workspaces', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const { name, description, projectGroups, projects, engineSelections } = body;

    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid workspace name. Use lowercase letters, numbers, and hyphens.' }));
      return;
    }

    // Build projects list from either new format (projectGroups) or old format (projects)
    let allProjects;
    if (projectGroups && projectGroups.length > 0) {
      allProjects = [];
      for (const group of projectGroups) {
        allProjects.push(...buildProjectsFromSelections(group.selections, group.projectName));
      }
    } else if (projects && projects.length > 0) {
      allProjects = [...projects];
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'At least one project is required.' }));
      return;
    }

    // Add engine projects
    if (engineSelections && engineSelections.length > 0) {
      allProjects.push({ name: 'Engine', paths: engineSelections.map(s => s.dir), language: 'cpp' });
    }

    // Deduplicate projects by name
    const seen = new Set();
    allProjects = allProjects.filter(p => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });

    // Build per-workspace config
    const wsConfig = {
      projects: allProjects,
      service: { port: 3847, host: '0.0.0.0' },
      data: {
        dbPath: '/data/db/index.db',
        mirrorDir: '/data/mirror',
        indexDir: '/data/zoekt-index',
      },
      zoekt: { webPort: 6070, parallelism: 4, reindexDebounceMs: 5000 },
      watcher: { debounceMs: 100 },
      exclude: ['**/Intermediate/**', '**/Saved/**', '**/DerivedDataCache/**', '**/Binaries/**'],
    };

    // Load or create workspaces.json
    let workspaces = loadWorkspacesConfig() || {};
    workspaces = ensureWorkspacesDefaults(workspaces);

    const existingWs = workspaces.workspaces[name];
    const port = existingWs ? existingWs.port : getNextAvailablePort(workspaces);

    workspaces.workspaces[name] = {
      port,
      description: description || `${name} workspace`,
    };

    if (Object.keys(workspaces.workspaces).length === 1) {
      workspaces.defaultWorkspace = name;
    }

    // Save
    const configPath = saveWorkspaceConfig(name, wsConfig);
    saveWorkspacesConfig(workspaces);
    generateDockerCompose(workspaces);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      workspace: name,
      port,
      configPath,
      workspacesPath: WORKSPACES_PATH,
      composePath: DOCKER_COMPOSE_PATH,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// PUT /api/workspaces/:name — Update existing workspace
route('PUT', '/api/workspaces/:name', async (req, res, params) => {
  try {
    const { name } = params;
    const body = await parseJsonBody(req);

    let workspaces = loadWorkspacesConfig();
    if (!workspaces || !workspaces.workspaces[name]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace '${name}' not found.` }));
      return;
    }

    if (body.description !== undefined) {
      workspaces.workspaces[name].description = body.description;
    }

    if (body.memoryLimitGB !== undefined) {
      const mem = parseFloat(body.memoryLimitGB);
      if (mem > 0) {
        workspaces.workspaces[name].memoryLimitGB = mem;
      } else {
        delete workspaces.workspaces[name].memoryLimitGB;
      }
    }

    if (body.projects) {
      const existingConfig = loadWorkspaceConfig(name) || {};
      existingConfig.projects = body.projects;
      if (body.engineSelections && body.engineSelections.length > 0) {
        existingConfig.projects.push({ name: 'Engine', paths: body.engineSelections.map(s => s.dir), language: 'cpp' });
      }
      saveWorkspaceConfig(name, existingConfig);
    }

    saveWorkspacesConfig(workspaces);
    generateDockerCompose(workspaces);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/workspaces/:name/rename — Rename workspace
route('POST', '/api/workspaces/:name/rename', async (req, res, params) => {
  try {
    const { name } = params;
    const body = await parseJsonBody(req);
    const newName = body.newName;

    if (!newName || !/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid name. Use lowercase letters, numbers, and hyphens.' }));
      return;
    }

    let workspaces = loadWorkspacesConfig();
    if (!workspaces || !workspaces.workspaces[name]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace '${name}' not found.` }));
      return;
    }
    if (newName === name) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (workspaces.workspaces[newName]) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace '${newName}' already exists.` }));
      return;
    }

    // Stop existing container before renaming
    try {
      if (process.platform === 'win32') {
        const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
        execFileSync('wsl', [
          '--', 'bash', '-c', `cd "${wslRoot}" && docker compose rm -sf ${name} 2>/dev/null; true`,
        ], { encoding: 'utf-8', timeout: 30000 });
      } else {
        execSync(`docker compose rm -sf ${name}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
      }
    } catch { /* container may not exist */ }

    // Rename in workspaces.json — preserve volumePrefix so Docker volumes stay mapped
    const wsEntry = { ...workspaces.workspaces[name] };
    if (!wsEntry.volumePrefix) {
      wsEntry.volumePrefix = name; // keep old volume names
    }
    workspaces.workspaces[newName] = wsEntry;
    delete workspaces.workspaces[name];
    if (workspaces.defaultWorkspace === name) {
      workspaces.defaultWorkspace = newName;
    }

    // Rename workspace config file
    const oldConfigPath = join(WORKSPACE_CONFIGS_DIR, `${name}.json`);
    const newConfigPath = join(WORKSPACE_CONFIGS_DIR, `${newName}.json`);
    if (existsSync(oldConfigPath)) {
      renameSync(oldConfigPath, newConfigPath);
    }

    saveWorkspacesConfig(workspaces);
    generateDockerCompose(workspaces);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, oldName: name, newName }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// DELETE /api/workspaces/:name — Remove workspace
// Query param: ?deleteVolumes=true to also remove Docker volumes (indexed data)
route('DELETE', '/api/workspaces/:name', async (req, res, params) => {
  try {
    const { name } = params;
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const deleteVolumes = url.searchParams.get('deleteVolumes') === 'true';

    let workspaces = loadWorkspacesConfig();
    if (!workspaces || !workspaces.workspaces[name]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace '${name}' not found.` }));
      return;
    }

    // Stop and remove the Docker container before updating config
    try {
      if (process.platform === 'win32') {
        const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
        execFileSync('wsl', [
          '--', 'bash', '-c', `cd "${wslRoot}" && docker compose rm -sf ${name} 2>/dev/null; true`,
        ], { encoding: 'utf-8', timeout: 30000 });
      } else {
        execSync(`docker compose rm -sf ${name}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
      }
    } catch { /* container may not exist, that's ok */ }

    // Remove Docker volumes if requested
    if (deleteVolumes) {
      const ws = workspaces.workspaces[name];
      const volPrefix = ws.volumePrefix || name;
      // Match both old-style (project_<vol>-db) and new-style (unreal-index-<vol>-db) volume names
      const volNames = [`${volPrefix}-db`, `${volPrefix}-mirror`, `${volPrefix}-zoekt`];
      const stableNames = volNames.map(n => `unreal-index-${n}`);
      try {
        let volList;
        if (process.platform === 'win32') {
          volList = execFileSync('wsl', [
            '--', 'bash', '-c', `docker volume ls -q 2>/dev/null`,
          ], { encoding: 'utf-8', timeout: 10000 }).trim();
        } else {
          volList = execSync('docker volume ls -q', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }).trim();
        }
        const matchingVols = volList.split('\n').filter(v =>
          volNames.some(suffix => v.endsWith('_' + suffix)) || stableNames.includes(v)
        );
        for (const vol of matchingVols) {
          try {
            if (process.platform === 'win32') {
              execFileSync('wsl', ['--', 'bash', '-c', `docker volume rm "${vol}" 2>/dev/null; true`],
                { encoding: 'utf-8', timeout: 10000 });
            } else {
              execSync(`docker volume rm "${vol}"`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
            }
          } catch { /* volume may be in use or already gone */ }
        }
      } catch { /* non-critical — volumes can be cleaned up manually */ }
    }

    delete workspaces.workspaces[name];

    // Update default if deleted
    if (workspaces.defaultWorkspace === name) {
      const remaining = Object.keys(workspaces.workspaces);
      workspaces.defaultWorkspace = remaining[0] || 'main';
    }

    saveWorkspacesConfig(workspaces);
    generateDockerCompose(workspaces);

    // Remove per-workspace config
    const configPath = join(WORKSPACE_CONFIGS_DIR, `${name}.json`);
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/scan — SSE scan drives for .uproject files
route('GET', '/api/scan', (req, res) => {
  sseHeaders(res);

  const startDirs = [
    'D:/p4', 'E:/p4', 'C:/p4',
    'D:/Code', 'E:/Code', 'C:/Code',
    'D:/Games', 'E:/Games',
    'D:/Unreal', 'E:/Unreal',
    'D:/Projects', 'E:/Projects',
  ];

  // Run scanning asynchronously to not block
  const seen = new Set();
  setImmediate(() => {
    try {
      for (const project of scanForUProjects(startDirs, 4)) {
        if (seen.has(project.dir)) continue;
        seen.add(project.dir);
        project.hasEngine = !!detectEngineRoot(project.dir);
        sseSend(res, 'project', project);
      }
    } catch (err) {
      sseSend(res, 'error', { message: err.message });
    }
    sseSend(res, 'done', { total: seen.size });
    res.end();
  });
});

// GET /api/p4clients — SSE scan P4 clients for projects
route('GET', '/api/p4clients', (req, res) => {
  sseHeaders(res);

  try {
    // Get P4 user
    let p4user;
    try {
      p4user = execSync('p4 set -q P4USER', { encoding: 'utf-8', timeout: 5000 }).trim();
      p4user = p4user.replace(/^P4USER=/, '');
    } catch {
      sseSend(res, 'error', { message: 'Could not determine P4 user. Is p4 installed and configured?' });
      sseSend(res, 'done', { total: 0 });
      res.end();
      return;
    }

    sseSend(res, 'info', { message: `Scanning P4 clients for ${p4user}...` });

    // List clients
    let clientOutput;
    try {
      clientOutput = execSync(`p4 clients -u ${p4user}`, { encoding: 'utf-8', timeout: 15000 });
    } catch {
      sseSend(res, 'error', { message: 'Could not list P4 clients.' });
      sseSend(res, 'done', { total: 0 });
      res.end();
      return;
    }

    const clients = [];
    for (const line of clientOutput.split('\n')) {
      // Format: Client <name> <date> root <rootpath> '<desc>'
      const match = line.match(/^Client\s+(\S+)\s+\S+\s+root\s+(\S+)/);
      if (match) {
        clients.push({ name: match[1], root: match[2] });
      }
    }

    sseSend(res, 'clients', { count: clients.length });

    let totalProjects = 0;
    for (const client of clients) {
      const root = client.root.replace(/\\/g, '/');
      if (!existsSync(root)) {
        sseSend(res, 'client', { name: client.name, root, exists: false });
        continue;
      }

      sseSend(res, 'client', { name: client.name, root, exists: true, scanning: true });

      const found = [];
      for (const project of scanForUProjects([root], 4)) {
        found.push(project);
        project.hasEngine = !!detectEngineRoot(project.dir);
        sseSend(res, 'project', { ...project, p4client: client.name });
        totalProjects++;
      }

      sseSend(res, 'clientDone', { name: client.name, projectCount: found.length });
    }

    sseSend(res, 'done', { total: totalProjects, clientCount: clients.length });
  } catch (err) {
    sseSend(res, 'error', { message: err.message });
    sseSend(res, 'done', { total: 0 });
  }
  res.end();
});

// POST /api/detect — Detect directories + engine for a project path
route('POST', '/api/detect', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    let { path: inputPath } = body;

    if (!inputPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path is required.' }));
      return;
    }

    inputPath = resolve(inputPath.trim().replace(/^["']|["']$/g, ''));

    if (!existsSync(inputPath)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Path does not exist: ${inputPath}` }));
      return;
    }

    let projectRoot, projectName;
    if (inputPath.endsWith('.uproject')) {
      projectRoot = dirname(inputPath);
      projectName = basename(inputPath, '.uproject');
    } else {
      projectRoot = inputPath;
      const uproject = findUProjectFile(inputPath);
      projectName = uproject ? basename(uproject, '.uproject') : basename(inputPath);
    }

    const directories = detectDirectories(projectRoot);
    const engineRoot = detectEngineRoot(projectRoot);
    const engineDirs = engineRoot ? detectEngineDirectories(engineRoot) : [];

    // Build diagnostic hints when no directories are found
    let hints = null;
    if (directories.length === 0) {
      hints = [];
      const expectedDirs = ['Script', 'Source', 'Plugins', 'Content', 'Config'];
      let foundEntries;
      try { foundEntries = readdirSync(projectRoot, { withFileTypes: true }); } catch { foundEntries = []; }
      const subdirs = foundEntries.filter(e => e.isDirectory()).map(e => e.name);
      const files = foundEntries.filter(e => e.isFile()).map(e => e.name);
      hints.push(`Path resolved to: ${fwd(projectRoot)}`);
      if (subdirs.length === 0 && files.length === 0) {
        hints.push('Directory is empty.');
      } else {
        const uprojectFile = files.find(f => f.endsWith('.uproject'));
        if (!uprojectFile && files.length > 0) {
          hints.push(`No .uproject file found. Top-level files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''}`);
        }
        if (subdirs.length > 0) {
          hints.push(`Subdirectories found: ${subdirs.slice(0, 10).join(', ')}${subdirs.length > 10 ? '...' : ''}`);
        }
        const missing = expectedDirs.filter(d => !subdirs.includes(d));
        if (missing.length > 0 && missing.length < expectedDirs.length) {
          hints.push(`Expected dirs not found: ${missing.join(', ')}`);
        } else if (missing.length === expectedDirs.length) {
          hints.push(`None of the expected UE dirs found (${expectedDirs.join(', ')}). Is this the correct project root?`);
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      projectRoot: fwd(projectRoot),
      projectName,
      directories,
      engineRoot: engineRoot ? fwd(engineRoot) : null,
      engineDirectories: engineDirs,
      ...(hints ? { hints } : {}),
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/docker/status — Docker compose status
route('GET', '/api/docker/status', (req, res) => {
  try {
    const output = execSync('docker compose ps --format json', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();

    let containers = [];
    if (output) {
      // Docker compose outputs one JSON object per line
      for (const line of output.split('\n')) {
        if (line.trim()) {
          try { containers.push(JSON.parse(line)); } catch {}
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ containers }));
  } catch (err) {
    // Try WSL fallback
    if (process.platform === 'win32') {
      try {
        const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
        const output = execFileSync('wsl', [
          '--', 'bash', '-c', `cd "${wslRoot}" && docker compose ps --format json 2>/dev/null`,
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }).trim();

        let containers = [];
        if (output) {
          for (const line of output.split('\n')) {
            if (line.trim()) {
              try { containers.push(JSON.parse(line)); } catch {}
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ containers }));
        return;
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ containers: [], error: 'Docker not available' }));
  }
});

// POST /api/docker/build — SSE build Docker image
route('POST', '/api/docker/build', (req, res) => {
  sseHeaders(res);

  const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);

  // Resolve git hash at build time for version tracking inside the container
  let gitHash = 'unknown';
  try {
    gitHash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {}

  // Use spawn to bypass cmd.exe shell interpretation on Windows
  // (cmd.exe splits on && inside single quotes, breaking the bash command)
  let child;
  if (process.platform === 'win32') {
    child = spawn('wsl', ['--', 'bash', '-c', `cd "${wslRoot}" && docker compose build --build-arg BUILD_GIT_HASH=${gitHash} 2>&1`]);
  } else {
    child = spawn('docker', ['compose', 'build', '--build-arg', `BUILD_GIT_HASH=${gitHash}`], { cwd: ROOT });
  }

  child.stdout?.on('data', data => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) sseSend(res, 'output', { line: line.trimEnd() });
    }
  });

  child.stderr?.on('data', data => {
    for (const line of data.toString().split('\n')) {
      if (line.trim()) sseSend(res, 'output', { line: line.trimEnd() });
    }
  });

  child.on('close', code => {
    sseSend(res, 'done', { code });
    res.end();
  });

  child.on('error', err => {
    sseSend(res, 'error', { message: err.message });
    res.end();
  });

  req.on('close', () => {
    child.kill();
  });
});

// POST /api/docker/start — Start workspace container(s)
route('POST', '/api/docker/start', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const workspace = body.workspace; // optional, start specific or all

    const service = workspace ? ` ${workspace}` : '';

    let output;
    if (process.platform === 'win32') {
      const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
      output = execFileSync('wsl', [
        '--', 'bash', '-c', `cd "${wslRoot}" && docker compose up -d${service} 2>&1`,
      ], { encoding: 'utf-8', timeout: 60000 });
    } else {
      output = execSync(`docker compose up -d${service}`, { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, output: output.trim() }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/docker/stop — Stop workspace container(s)
route('POST', '/api/docker/stop', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const workspace = body.workspace;

    const service = workspace ? ` ${workspace}` : '';

    let output;
    if (process.platform === 'win32') {
      const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
      output = execFileSync('wsl', [
        '--', 'bash', '-c', `cd "${wslRoot}" && docker compose stop${service} 2>&1`,
      ], { encoding: 'utf-8', timeout: 30000 });
    } else {
      output = execSync(`docker compose stop${service}`, { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, output: output.trim() }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/watcher/start — Start watcher for a workspace (runs on Windows)
route('POST', '/api/watcher/start', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const workspace = body.workspace;

    // Read workspaces.json to get the port
    const ws = JSON.parse(readFileSync(WORKSPACES_PATH, 'utf-8'));
    const wsName = workspace || ws.defaultWorkspace;
    const wsConfig = ws.workspaces?.[wsName];
    if (!wsConfig) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace "${wsName}" not found` }));
      return;
    }

    // Spawn watcher as a detached process with --workspace flag
    // Use the per-workspace service config value for consistency with /internal/start-watcher.
    const workspaceConfig = loadWorkspaceConfig(wsName);
    const { child, heapMb, logPath, logFd } = startWorkspaceWatcher({
      rootDir: ROOT,
      workspaceName: wsName,
      workspaceConfig,
      spawnProcess: spawn,
      nodeExecPath: process.execPath
    });
    child.on('error', err => {
      console.error(`[Setup] Watcher spawn error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      closeSync(logFd);
      console.error(`[Setup] Watcher for ${wsName} exited (code=${code}, signal=${signal})`);
    });
    child.unref();
    console.log(`[Setup] Started watcher for ${wsName} (PID ${child.pid}, port ${wsConfig.port}, heap ${heapMb}MB, log: ${logPath})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: child.pid, workspace: wsName }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/watcher/logs/:workspace — Tail the watcher log file
route('GET', '/api/watcher/logs/:workspace', async (req, res, params) => {
  try {
    const { workspace } = params;
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const tail = Math.min(parseInt(url.searchParams.get('tail'), 10) || 100, 500);
    const logPath = join(ROOT, `watcher-${workspace}.log`);

    if (!existsSync(logPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, logs: '', lineCount: 0 }));
      return;
    }

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    const sliced = lines.slice(-tail);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logs: sliced.join('\n'), lineCount: sliced.length }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/watcher/stop — Stop watcher by signaling via service heartbeat
route('POST', '/api/watcher/stop', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const workspace = body.workspace;

    // Read workspaces.json to get the port
    const ws = JSON.parse(readFileSync(WORKSPACES_PATH, 'utf-8'));
    const wsName = workspace || ws.defaultWorkspace;
    const wsConfig = ws.workspaces?.[wsName];
    if (!wsConfig) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Workspace "${wsName}" not found` }));
      return;
    }

    const serviceUrl = `http://127.0.0.1:${wsConfig.port}`;

    // Tell the service to signal watchers to shut down
    const resp = await fetch(`${serviceUrl}/internal/stop-watcher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await resp.json();
    console.log(`[Setup] Watcher stop requested for ${wsName}: ${JSON.stringify(data)}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workspace: wsName }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/docker/logs/:workspace — Fetch recent container logs
route('GET', '/api/docker/logs/:workspace', (req, res, params) => {
  const workspace = params.workspace;
  try {
    let output;
    if (process.platform === 'win32') {
      const wslRoot = fwd(ROOT).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
      output = execFileSync('wsl', [
        '--', 'bash', '-c', `cd "${wslRoot}" && docker compose logs --tail 80 ${workspace} 2>&1`,
      ], { encoding: 'utf-8', timeout: 10000 });
    } else {
      output = execSync(`docker compose logs --tail 80 ${workspace}`, {
        cwd: ROOT, encoding: 'utf-8', timeout: 10000,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logs: output }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/port-check/:port — Check what process is using a port (WSL)
route('GET', '/api/port-check/:port', (req, res, params) => {
  const port = parseInt(params.port, 10);
  if (!port || port < 1 || port > 65535) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid port' }));
    return;
  }
  try {
    let output;
    if (process.platform === 'win32') {
      output = execFileSync('wsl', [
        '--', 'bash', '-c', `ss -tlnp 2>/dev/null | grep ':${port} ' || true`,
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      output = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`, {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
    }
    if (!output) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ inUse: false }));
      return;
    }
    // Extract PID and process name from ss output, e.g.: users:(("node",pid=828,fd=37))
    const pidMatch = output.match(/pid=(\d+)/);
    const procMatch = output.match(/\("([^"]+)"/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inUse: true,
      pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
      process: procMatch ? procMatch[1] : null,
      raw: output,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/port-kill — Kill the process using a specific port (WSL)
route('POST', '/api/port-kill', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const { port } = body;
    if (!port || port < 1 || port > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid port' }));
      return;
    }
    // Find the PID first
    let ssOutput;
    if (process.platform === 'win32') {
      ssOutput = execFileSync('wsl', [
        '--', 'bash', '-c', `ss -tlnp 2>/dev/null | grep ':${port} ' || true`,
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
    } else {
      ssOutput = execSync(`ss -tlnp 2>/dev/null | grep ':${port} ' || true`, {
        encoding: 'utf-8', timeout: 5000,
      }).trim();
    }
    const pidMatch = ssOutput.match(/pid=(\d+)/);
    if (!pidMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'No process found on port' }));
      return;
    }
    const pid = pidMatch[1];
    if (process.platform === 'win32') {
      execFileSync('wsl', [
        '--', 'bash', '-c', `kill ${pid} 2>/dev/null; sleep 0.5; kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null; true`,
      ], { encoding: 'utf-8', timeout: 5000 });
    } else {
      execSync(`kill ${pid} 2>/dev/null; sleep 0.5; kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null; true`, {
        encoding: 'utf-8', timeout: 5000,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, killedPid: parseInt(pid, 10) }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// POST /api/hooks/install — Install hooks for a project dir
route('POST', '/api/hooks/install', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const { projectDir } = body;

    if (!projectDir) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'projectDir is required.' }));
      return;
    }

    const { installHooks } = await import('./hooks/install.js');
    const result = await installHooks(projectDir, { silent: true, tryGo: true });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      compiled: result.compiled,
      proxyCommand: result.proxyCommand,
      hooksDir: result.hooksDir,
      settingsPath: result.settingsPath,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// GET /api/mcp-config — Generate MCP server config for docker exec bridge
route('GET', '/api/mcp-config', (req, res) => {
  const wsConfig = loadWorkspacesConfig();
  if (!wsConfig || !wsConfig.workspaces || Object.keys(wsConfig.workspaces).length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No workspaces configured. Create a workspace first.' }));
    return;
  }

  const workspaces = Object.entries(wsConfig.workspaces);

  // Single workspace: one MCP server entry called "unreal-index"
  // Multi-workspace: one entry per workspace called "unreal-index-<name>"
  const mcpServers = {};
  for (const [name, ws] of workspaces) {
    const containerName = `unreal-index-${name}`;
    const serverName = workspaces.length === 1 ? 'unreal-index' : `unreal-index-${name}`;
    mcpServers[serverName] = {
      command: 'docker',
      args: ['exec', '-i', containerName, 'node', 'src/bridge/mcp-bridge.js']
    };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ mcpServers }, null, 2));
});

// GET /api/service-status/:workspace — Health proxy for workspace service
route('GET', '/api/service-status/:workspace', async (req, res, params) => {
  const wsConfig = loadWorkspacesConfig();
  const ws = wsConfig?.workspaces?.[params.workspace];
  if (!ws) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://127.0.0.1:${ws.port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'unreachable' }));
  }
});

// ── Prerequisites Installation Endpoints ────────────────────

// POST /api/prerequisites/install-wsl — Launch WSL install with UAC elevation
route('POST', '/api/prerequisites/install-wsl', (req, res) => {
  try {
    spawn('powershell.exe', ['-Command', "Start-Process wsl -ArgumentList '--install' -Verb RunAs"], {
      detached: true, stdio: 'ignore',
    }).unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'WSL install launched. A reboot will be required after installation completes.' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// POST /api/prerequisites/install-docker — Generate install script + open in new console
route('POST', '/api/prerequisites/install-docker', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const scenario = body.scenario || 'full';

    let script;
    if (scenario === 'compose-only') {
      script = [
        '#!/bin/bash',
        'set -e',
        'echo "=== Installing Docker Compose plugin ==="',
        'mkdir -p ~/.docker/cli-plugins',
        'curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" -o ~/.docker/cli-plugins/docker-compose',
        'chmod +x ~/.docker/cli-plugins/docker-compose',
        'echo ""',
        'echo "Docker Compose installed:"',
        'docker compose version',
        'echo ""',
        'echo "Done! You can close this window and click Re-check in the dashboard."',
        'read -p "Press Enter to close..."',
      ].join('\n');
    } else if (scenario === 'daemon-start') {
      script = [
        '#!/bin/bash',
        'set -e',
        'echo "=== Starting Docker daemon ==="',
        'sudo service docker start',
        'echo ""',
        'echo "Checking Docker daemon..."',
        'docker info > /dev/null 2>&1 && echo "Docker daemon is running!" || echo "Failed to start Docker daemon."',
        'echo ""',
        'echo "Done! You can close this window and click Re-check in the dashboard."',
        'read -p "Press Enter to close..."',
      ].join('\n');
    } else {
      // full install
      script = [
        '#!/bin/bash',
        'set -e',
        'echo "=== Installing Docker Engine in WSL ==="',
        'echo ""',
        'echo "This will install Docker Engine from the official Docker repository."',
        'echo "You will be prompted for your sudo password."',
        'echo ""',
        '',
        '# Install prerequisites',
        'sudo apt-get update',
        'sudo apt-get install -y ca-certificates curl',
        '',
        '# Add Docker GPG key',
        'sudo install -m 0755 -d /etc/apt/keyrings',
        'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
        'sudo chmod a+r /etc/apt/keyrings/docker.asc',
        '',
        '# Add Docker repository',
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null',
        '',
        '# Install Docker Engine + Compose plugin',
        'sudo apt-get update',
        'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
        '',
        '# Add user to docker group',
        'sudo usermod -aG docker $USER',
        '',
        '# Start Docker daemon',
        'sudo service docker start',
        '',
        'echo ""',
        'echo "=== Docker installed successfully! ==="',
        'echo ""',
        'docker --version',
        'docker compose version',
        'echo ""',
        'echo "IMPORTANT: WSL needs to restart for group changes to take effect."',
        'echo "After closing this window, click Complete Installation in the dashboard."',
        'echo ""',
        'read -p "Press Enter to close..."',
      ].join('\n');
    }

    // Write shell script (LF line endings)
    const scriptPath = join(ROOT, 'install-docker.sh');
    writeFileSync(scriptPath, script, { encoding: 'utf-8' });

    // Write .bat launcher with pre-computed WSL path
    const wslScriptPath = fwd(scriptPath).replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
    const batPath = join(ROOT, 'install-docker.bat');
    const batContent = `@echo off\r\ntitle Docker Installation\r\nwsl -- bash "${wslScriptPath}"\r\n`;
    writeFileSync(batPath, batContent, { encoding: 'utf-8' });

    // Open .bat in new console window
    // Use exec with shell to avoid Node.js double-quoting the start title
    exec(`start "" "${batPath}"`, { shell: 'cmd.exe', windowsHide: false });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: `Docker ${scenario} install launched in new window.` }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// POST /api/prerequisites/complete-docker — Shutdown WSL, wait, re-check
route('POST', '/api/prerequisites/complete-docker', async (req, res) => {
  try {
    // Shutdown WSL so group membership changes take effect
    try {
      execFileSync('wsl', ['--shutdown'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    } catch {}

    // Wait for WSL to fully stop
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Re-check prerequisites
    const prereqs = checkAllPrerequisites();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(prereqs));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// POST /api/prerequisites/set-env — Set UNREAL_INDEX_DIR environment variable
route('POST', '/api/prerequisites/set-env', async (req, res) => {
  try {
    const body = await parseJsonBody(req);
    const envPath = body.path || ROOT;

    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `[Environment]::SetEnvironmentVariable('UNREAL_INDEX_DIR', '${envPath.replace(/'/g, "''")}', 'User')`,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
      // Also set it in current process so re-check picks it up
      process.env.UNREAL_INDEX_DIR = envPath;
    } else {
      process.env.UNREAL_INDEX_DIR = envPath;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: envPath }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// POST /api/prerequisites/install-node — Install Node.js via winget (elevated)
route('POST', '/api/prerequisites/install-node', (req, res) => {
  try {
    spawn('powershell.exe', [
      '-Command',
      "Start-Process powershell -ArgumentList '-Command','winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; Read-Host \"Press Enter to close\"' -Verb RunAs",
    ], { detached: true, stdio: 'ignore' }).unref();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Node.js install launched. Restart terminal after installation.' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// GET /api/autostart — Check if autostart scheduled task exists
route('GET', '/api/autostart', (req, res) => {
  try {
    execFileSync('schtasks', ['/Query', '/TN', 'UnrealIndexDashboard', '/FO', 'CSV', '/NH'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: true }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: false }));
  }
});

// POST /api/autostart/enable — Create scheduled task for autostart
route('POST', '/api/autostart/enable', (req, res) => {
  try {
    const nodePath = process.execPath;
    const scriptPath = join(ROOT, 'src', 'setup-gui.js');
    // Create a scheduled task that runs at logon
    // Use execFileSync to avoid MINGW path conversion of /Create, /TN, etc.
    execFileSync('schtasks', [
      '/Create', '/TN', 'UnrealIndexDashboard',
      '/TR', `"${nodePath}" "${scriptPath}"`,
      '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enabled: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// POST /api/autostart/disable — Remove autostart scheduled task
route('POST', '/api/autostart/disable', (req, res) => {
  try {
    execFileSync('schtasks', ['/Delete', '/TN', 'UnrealIndexDashboard', '/F'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enabled: false }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

// ── HTTP Server ────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Service proxy — forwards /api/service-proxy/* to the workspace's service port
  // Avoids CORS issues by keeping everything same-origin on :3846
  if (pathname.startsWith('/api/service-proxy/')) {
    const workspace = url.searchParams.get('workspace');
    const wsConfig = loadWorkspacesConfigCached();
    const ws = wsConfig?.workspaces?.[workspace];
    if (!ws) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown workspace' }));
      return;
    }
    // Strip /api/service-proxy prefix to get the original service path
    const servicePath = pathname.slice('/api/service-proxy'.length);
    // Rebuild query string without the workspace param
    const serviceParams = new URLSearchParams(url.searchParams);
    serviceParams.delete('workspace');
    const qs = serviceParams.toString();
    const serviceUrl = `http://127.0.0.1:${ws.port}${servicePath}${qs ? '?' + qs : ''}`;

    try {
      // Read body for POST/PUT/DELETE
      let body = null;
      if (method !== 'GET' && method !== 'HEAD') {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const fetchOpts = {
        method,
        signal: controller.signal,
        headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
      };
      if (body && body.length > 0) fetchOpts.body = body;

      const proxyResp = await fetch(serviceUrl, fetchOpts);
      clearTimeout(timeout);

      const contentType = proxyResp.headers.get('content-type') || 'application/json';
      const respBody = await proxyResp.arrayBuffer();
      const buf = Buffer.from(respBody);
      const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');

      if (acceptGzip && buf.length > 256) {
        const compressed = gzipSync(buf);
        res.writeHead(proxyResp.status, {
          'Content-Type': contentType,
          'Content-Encoding': 'gzip',
        });
        res.end(compressed);
      } else {
        res.writeHead(proxyResp.status, { 'Content-Type': contentType });
        res.end(buf);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service unreachable: ' + err.message }));
      }
    }
    return;
  }

  // Match route
  const match = matchRoute(method, pathname);
  if (match) {
    try {
      await match.handler(req, res, match.params);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // Static file fallback for /setup.html or other public files
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    const safePath = pathname.replace(/\.\./g, '');
    const filePath = join(PUBLIC_DIR, safePath);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      serveStatic(req, res, filePath);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use.`);
    console.error(`  Another instance of the setup GUI may be running.`);
    console.error(`  Try: npx kill-port ${PORT}   or   netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error(`\n  ERROR: Failed to start setup GUI: ${err.message}`);
    console.error(`  Code: ${err.code || 'unknown'}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Setup GUI running at http://localhost:${PORT}`);

  // Auto-open browser on Windows
  if (process.platform === 'win32') {
    try {
      exec(`start http://localhost:${PORT}`);
    } catch {}
  }
});
