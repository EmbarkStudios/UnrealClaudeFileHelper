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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const WORKSPACES_PATH = join(ROOT, 'workspaces.json');
const WORKSPACE_CONFIGS_DIR = join(ROOT, 'workspace-configs');
const DOCKER_COMPOSE_PATH = join(ROOT, 'docker-compose.yml');
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = parseInt(process.argv[2]) || 3846;

// ── Utilities ──────────────────────────────────────────────

function fwd(path) {
  return path.replace(/\\/g, '/');
}

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

function loadWorkspacesConfig() {
  if (!existsSync(WORKSPACES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(WORKSPACES_PATH, 'utf-8'));
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

function ensureWorkspacesDefaults(wsConfig) {
  if (!wsConfig.workspaces) wsConfig.workspaces = {};
  if (!wsConfig.defaultWorkspace) {
    const names = Object.keys(wsConfig.workspaces);
    wsConfig.defaultWorkspace = names[0] || 'main';
  }
  if (!wsConfig.dockerImage) wsConfig.dockerImage = 'unreal-index:latest';
  if (!wsConfig.shared) {
    wsConfig.shared = {
      exclude: ['**/Intermediate/**', '**/Saved/**', '**/DerivedDataCache/**', '**/Binaries/**'],
      zoekt: { parallelism: 4, reindexDebounceMs: 5000 },
      watcher: { debounceMs: 100, reconcileIntervalMinutes: 10 },
    };
  }
  return wsConfig;
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
  const configPath = join(WORKSPACE_CONFIGS_DIR, `${workspaceName}.json`);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Docker compose generation ───────────────────────────────

function getWorkspaceMemoryLimitGB(wsConfig, workspaceName) {
  const ws = wsConfig.workspaces[workspaceName];
  // User-configurable override takes priority
  if (ws && ws.memoryLimitGB && ws.memoryLimitGB > 0) {
    return ws.memoryLimitGB;
  }
  // Auto-calculate based on project languages.
  // Memory is dominated by in-memory index size which varies heavily by language:
  //   content (assets): ~1.5GB for a large game (200K+ assets)
  //   cpp (engine):     ~2GB for full UE engine source
  //   cpp (game):       ~0.5GB for typical game source+plugins
  //   angelscript:      ~0.5GB for typical script project
  //   config:           negligible
  // Base overhead: ~2GB (Node.js heap, SQLite, Zoekt webserver, OS)
  const config = loadWorkspaceConfig(workspaceName);
  const projects = config?.projects || [];
  let estimatedGB = 2; // base overhead
  for (const p of projects) {
    const isEngine = /engine/i.test(p.name);
    switch (p.language) {
      case 'content':    estimatedGB += 1.5; break;
      case 'cpp':        estimatedGB += isEngine ? 2 : 0.5; break;
      case 'angelscript': estimatedGB += 0.5; break;
      default:           estimatedGB += 0.1; break;
    }
  }
  // Round up to nearest 0.5, clamp to [4, 16]
  return Math.min(16, Math.max(4, Math.ceil(estimatedGB * 2) / 2));
}

function generateDockerCompose(wsConfig) {
  const lines = [
    "# Generated by unreal-index setup. Re-run 'npm run setup' to regenerate.",
    'services:',
  ];

  for (const [name, ws] of Object.entries(wsConfig.workspaces)) {
    const memGB = getWorkspaceMemoryLimitGB(wsConfig, name);
    const swapGB = memGB + 2;
    const vol = ws.volumePrefix || name; // preserved across renames
    lines.push(`  ${name}:`);
    lines.push(`    build: .`);
    lines.push(`    image: ${wsConfig.dockerImage}`);
    lines.push(`    container_name: unreal-index-${name}`);
    lines.push(`    ports:`);
    lines.push(`      - "${ws.port}:3847"`);
    lines.push(`    volumes:`);
    lines.push(`      - ${vol}-db:/data/db`);
    lines.push(`      - ${vol}-mirror:/data/mirror`);
    lines.push(`      - ${vol}-zoekt:/data/zoekt-index`);
    lines.push(`      - ./workspaces.json:/app/workspaces.json:ro`);
    lines.push(`      - ./workspace-configs/${name}.json:/app/config.json:ro`);
    lines.push(`    mem_limit: ${memGB}g`);
    lines.push(`    memswap_limit: ${swapGB}g`);
    lines.push(`    restart: unless-stopped`);
    lines.push(`    stop_grace_period: 15s`);
    lines.push('');
  }

  lines.push('volumes:');
  for (const [name, ws] of Object.entries(wsConfig.workspaces)) {
    const vol = ws.volumePrefix || name;
    lines.push(`  ${vol}-db:`);
    lines.push(`  ${vol}-mirror:`);
    lines.push(`  ${vol}-zoekt:`);
  }

  writeFileSync(DOCKER_COMPOSE_PATH, lines.join('\n') + '\n');
}

// ── Detection ──────────────────────────────────────────────

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
  return projects;
}

// ── Prerequisites ─────────────────────────────────────────

function checkPrerequisites() {
  const results = { docker: false, dockerVersion: null };

  try {
    const dockerVer = execSync('docker compose version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
    results.docker = true;
    results.dockerVersion = dockerVer;
  } catch {}
  if (!results.docker && process.platform === 'win32') {
    try {
      const dockerVer = execFileSync('wsl', [
        '--', 'bash', '-c', 'docker compose version 2>/dev/null',
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();
      if (dockerVer.includes('Docker Compose')) {
        results.docker = true;
        results.dockerVersion = dockerVer + ' (WSL)';
      }
    } catch {}
  }

  return results;
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

// GET /api/prerequisites — Check Docker availability
route('GET', '/api/prerequisites', (req, res) => {
  const prereqs = checkPrerequisites();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(prereqs));
});

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
  for (const [name, ws] of Object.entries(result.workspaces)) {
    ws.config = loadWorkspaceConfig(name);
    const status = checkService(name);
    ws.running = status.running;
    ws.health = status.health;
    ws.memUsage = status.memUsage || null;
    ws.memLimit = status.memLimit || null;
    ws.memPercent = status.memPercent || null;
    ws.computedMemLimitGB = getWorkspaceMemoryLimitGB(wsConfig, name);
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
      const volSuffixes = [`${name}-db`, `${name}-mirror`, `${name}-zoekt`];
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
          volSuffixes.some(suffix => v.endsWith('_' + suffix))
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      projectRoot: fwd(projectRoot),
      projectName,
      directories,
      engineRoot: engineRoot ? fwd(engineRoot) : null,
      engineDirectories: engineDirs,
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

    const watcherScript = join(ROOT, 'src', 'watcher', 'watcher-client.js');

    // Spawn watcher as a detached process with --workspace flag
    // Write stdout/stderr to a log file so we can diagnose crashes
    const logPath = join(ROOT, `watcher-${wsName}.log`);
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [watcherScript, '--workspace', wsName], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    child.on('error', err => {
      console.error(`[Setup] Watcher spawn error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      closeSync(logFd);
      console.error(`[Setup] Watcher for ${wsName} exited (code=${code}, signal=${signal})`);
    });
    child.unref();
    console.log(`[Setup] Started watcher for ${wsName} (PID ${child.pid}, port ${wsConfig.port}, log: ${logPath})`);

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

server.listen(PORT, () => {
  console.log(`Setup GUI running at http://localhost:${PORT}`);

  // Auto-open browser on Windows
  if (process.platform === 'win32') {
    try {
      exec(`start http://localhost:${PORT}`);
    } catch {}
  }
});
