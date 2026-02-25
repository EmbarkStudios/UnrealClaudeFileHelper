#!/usr/bin/env node

import { parentPort, workerData } from 'worker_threads';
import { readFile, stat } from 'fs/promises';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { gzipSync } from 'zlib';
import { parseContent as parseAngelscriptContent } from '../parsers/angelscript-parser.js';
import { parseCppContent } from '../parsers/cpp-parser.js';
import { parseCSharpContent } from '../parsers/csharp-parser.js';
import { parseUAssetHeader } from '../parsers/uasset-parser.js';

const MAX_CONCURRENT = 10;
const BATCH_SIZE = 50;

const serviceUrl = workerData?.serviceUrl;
const config = workerData?.config;
const task = workerData?.task;
const workerPrefix = `${workerData?.logPrefix || '[Watcher]'}[scan]`;

let filesIngested = 0;
let assetsIngested = 0;
let deletesProcessed = 0;
let errorsCount = 0;
let lastIngestAt = null;

function postMessage(type, payload = {}) {
  if (parentPort) parentPort.postMessage({ type, ...payload });
}

function log(message) {
  postMessage('log', { level: 'log', message: `${workerPrefix} ${message}` });
}

function warn(message) {
  postMessage('log', { level: 'warn', message: `${workerPrefix} ${message}` });
}

function recordIngest({ files = 0, assets = 0, deletes = 0, errors = 0 }) {
  filesIngested += files;
  assetsIngested += assets;
  deletesProcessed += deletes;
  errorsCount += errors;
  if (files > 0 || assets > 0 || deletes > 0) {
    lastIngestAt = new Date().toISOString();
    postMessage('telemetry', {
      delta: {
        filesIngested: files,
        assetsIngested: assets,
        deletesProcessed: deletes,
        errorsCount: errors,
        lastIngestAt
      }
    });
  } else if (errors > 0) {
    postMessage('telemetry', {
      delta: {
        filesIngested: 0,
        assetsIngested: 0,
        deletesProcessed: 0,
        errorsCount: errors,
        lastIngestAt
      }
    });
  }
}

function findBasePathForFile(filePath, project) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const basePath of project.paths) {
    if (normalized.startsWith(basePath.replace(/\\/g, '/').toLowerCase())) {
      return basePath;
    }
  }
  return null;
}

function deriveModule(relativePath, projectName) {
  const parts = relativePath.replace(/\.(as|h|cpp|cs)$/, '').split('/');
  parts.pop();
  return [projectName, ...parts].join('.');
}

function shouldExclude(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of config.exclude || []) {
    if (pattern.includes('**')) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(normalized)) return true;
    } else if (normalized.includes(pattern.replace(/\*/g, ''))) {
      return true;
    }
  }
  return false;
}

function collectFiles(dirPath, projectName, extensions, language, includePatterns) {
  const files = [];
  const scanDir = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldExclude(fullPath)) continue;
        scanDir(fullPath);
      } else if (entry.isFile()) {
        if (!extensions.some(ext => entry.name.endsWith(ext))) continue;
        if (includePatterns?.length > 0) {
          if (!includePatterns.some(pat => pat.startsWith('*') ? entry.name.endsWith(pat.slice(1)) : entry.name === pat)) continue;
        }
        if (shouldExclude(fullPath)) continue;
        try {
          const mtime = Math.floor(statSync(fullPath).mtimeMs);
          const relativePath = relative(dirPath, fullPath).replace(/\\/g, '/');
          const module = deriveModule(relativePath, projectName);
          files.push({ path: fullPath, project: projectName, module, mtime, basePath: dirPath, language });
        } catch {}
      }
    }
  };

  scanDir(dirPath);
  return files;
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    } catch (err) {
      const code = err.code || err.cause?.code;
      if (attempt < retries && (code === 'ECONNRESET' || code === 'ECONNREFUSED' || err.message.includes('fetch failed'))) {
        const delay = attempt * 2000;
        warn(`GET failed (${code || err.message}), retry ${attempt}/${retries} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function waitForService() {
  log(`Waiting for service at ${serviceUrl}...`);
  while (true) {
    try {
      const status = await fetchJson(`${serviceUrl}/internal/status`);
      log(`Service connected. DB counts: ${JSON.stringify(status.counts || {})}`);
      return status;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function postJson(url, body, retries = 3) {
  const json = JSON.stringify(body);
  const useGzip = json.length > 1024;
  const payload = useGzip ? gzipSync(json) : json;
  const headers = { 'Content-Type': 'application/json' };
  if (useGzip) headers['Content-Encoding'] = 'gzip';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      const code = err.code || err.cause?.code;
      if (attempt < retries && (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET' || err.message.includes('fetch failed'))) {
        const delay = attempt * 2000;
        warn(`POST failed (${code || err.message}), retry ${attempt}/${retries} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        try {
          await fetchJson(`${url.replace(/\/internal\/.*/, '')}/health`);
        } catch {
          log('Service unavailable, waiting...');
          await waitForService();
        }
        continue;
      }
      throw err;
    }
  }
}

async function readAndParseSource(filePath, project, language) {
  const basePath = findBasePathForFile(filePath, project);
  if (!basePath) return null;

  const fileStat = await stat(filePath);
  const mtime = Math.floor(fileStat.mtimeMs);
  const relativePath = relative(basePath, filePath).replace(/\\/g, '/');
  const module = deriveModule(relativePath, project.name);

  if (language === 'config') {
    const content = await readFile(filePath, 'utf-8');
    return { path: filePath, project: project.name, module, mtime, language, relativePath, content, types: [], members: [] };
  }

  const content = await readFile(filePath, 'utf-8');
  let parsed;
  if (language === 'cpp') {
    parsed = parseCppContent(content, filePath);
  } else if (language === 'csharp') {
    parsed = parseCSharpContent(content, filePath);
  } else {
    parsed = parseAngelscriptContent(content, filePath);
  }

  const types = [];
  for (const cls of parsed.classes || []) types.push({ name: cls.name, kind: cls.kind || 'class', parent: cls.parent, line: cls.line });
  for (const s of parsed.structs || []) types.push({ name: s.name, kind: 'struct', parent: s.parent || null, line: s.line });
  for (const e of parsed.enums || []) types.push({ name: e.name, kind: 'enum', parent: null, line: e.line });
  if (language === 'angelscript') {
    for (const ev of parsed.events || []) types.push({ name: ev.name, kind: 'event', parent: null, line: ev.line });
    for (const d of parsed.delegates || []) types.push({ name: d.name, kind: 'delegate', parent: null, line: d.line });
    for (const ns of parsed.namespaces || []) types.push({ name: ns.name, kind: 'namespace', parent: null, line: ns.line });
  }
  if (language === 'cpp' || language === 'csharp') {
    for (const d of parsed.delegates || []) types.push({ name: d.name, kind: 'delegate', parent: null, line: d.line });
  }

  return {
    path: filePath,
    project: project.name,
    module,
    mtime,
    language,
    content,
    relativePath,
    types,
    members: parsed.members || []
  };
}

function parseAsset(filePath, project) {
  const contentRoot = project.contentRoot || project.paths[0];
  const mtime = Math.floor(statSync(filePath).mtimeMs);
  const relativePath = relative(contentRoot, filePath).replace(/\\/g, '/');
  const ext = relativePath.match(/\.[^.]+$/)?.[0] || '';
  const contentPath = '/Game/' + relativePath.replace(/\.[^.]+$/, '');
  const name = relativePath.split('/').pop().replace(/\.[^.]+$/, '');
  const folder = '/Game/' + relativePath.split('/').slice(0, -1).join('/');

  let assetClass = null;
  let parentClass = null;
  if (ext === '.uasset') {
    try {
      const info = parseUAssetHeader(filePath);
      assetClass = info.assetClass;
      parentClass = info.parentClass;
    } catch {}
  }

  return {
    path: filePath,
    name,
    contentPath,
    folder: folder || '/Game',
    project: project.name,
    extension: ext,
    mtime,
    assetClass,
    parentClass
  };
}

async function readAndParseBatch(batch, project, language) {
  const parsed = [];
  for (let j = 0; j < batch.length; j += MAX_CONCURRENT) {
    const concurrent = batch.slice(j, j + MAX_CONCURRENT);
    const results = await Promise.all(concurrent.map(async (f) => {
      try {
        return await readAndParseSource(f.path, project, language);
      } catch (err) {
        warn(`Error parsing ${f.path}: ${err.message}`);
        return null;
      }
    }));
    parsed.push(...results.filter(Boolean));
  }
  return parsed;
}

async function runFullScan(languages) {
  log(`Starting full scan for empty languages: ${languages.join(', ')}`);
  const scanStart = performance.now();

  for (const project of config.projects) {
    if (!languages.includes(project.language)) continue;
    const extensions = project.extensions || (project.language === 'cpp' ? ['.h', '.cpp'] : ['.as']);

    for (const basePath of project.paths) {
      const collectStart = performance.now();
      const files = collectFiles(basePath, project.name, extensions, project.language, project.includePatterns);
      const collectMs = (performance.now() - collectStart).toFixed(0);
      log(`Collected ${files.length} files from ${project.name} (${collectMs}ms)`);

      if (project.language === 'content') {
        for (let i = 0; i < files.length; i += BATCH_SIZE * 10) {
          const batch = files.slice(i, i + BATCH_SIZE * 10);
          const assets = [];
          for (const f of batch) {
            try { assets.push(parseAsset(f.path, project)); } catch {}
          }
          if (assets.length > 0) {
            await postJson(`${serviceUrl}/internal/ingest`, { assets });
            recordIngest({ assets: assets.length });
          }
          if ((i + batch.length) % 5000 < BATCH_SIZE * 10) {
            log(`${project.name}: ${i + batch.length}/${files.length} assets`);
          }
        }
      } else {
        let pendingPost = null;
        let pendingFilesCount = 0;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const parsePromise = readAndParseBatch(batch, project, project.language);

          if (pendingPost) {
            await pendingPost;
            recordIngest({ files: pendingFilesCount });
          }

          const parsed = await parsePromise;

          if (parsed.length > 0) {
            pendingFilesCount = parsed.length;
            pendingPost = postJson(`${serviceUrl}/internal/ingest`, { files: parsed });
          } else {
            pendingFilesCount = 0;
            pendingPost = null;
          }

          if ((i + batch.length) % 500 < BATCH_SIZE) {
            log(`${project.name}: ${i + batch.length}/${files.length} files`);
          }
        }
        if (pendingPost) {
          await pendingPost;
          recordIngest({ files: pendingFilesCount });
        }
      }
    }
  }

  const totalS = ((performance.now() - scanStart) / 1000).toFixed(1);
  log(`Full scan complete (${totalS}s)`);
}

async function runReconcile(project) {
  const language = project.language;
  const extensions = project.extensions || (language === 'cpp' ? ['.h', '.cpp'] : ['.as']);

  for (const basePath of project.paths) {
    const endpoint = language === 'content'
      ? `${serviceUrl}/internal/asset-mtimes?project=${encodeURIComponent(project.name)}`
      : `${serviceUrl}/internal/file-mtimes?language=${encodeURIComponent(language)}&project=${encodeURIComponent(project.name)}`;

    const storedMtimes = await fetchJson(endpoint);

    const collectStart = performance.now();
    const diskFiles = collectFiles(basePath, project.name, extensions, language, project.includePatterns);
    const diskMap = new Map(diskFiles.map(f => [f.path, f]));
    const collectMs = (performance.now() - collectStart).toFixed(0);

    const changed = [];
    const deleted = [];

    for (const f of diskFiles) {
      const storedMtime = storedMtimes[f.path];
      if (storedMtime === undefined || storedMtime !== f.mtime) {
        changed.push(f);
      }
    }

    const basePrefix = basePath.replace(/\\/g, '/');
    for (const storedPath of Object.keys(storedMtimes)) {
      const normalized = storedPath.replace(/\\/g, '/');
      if (normalized.startsWith(basePrefix) && !diskMap.has(storedPath)) {
        deleted.push(storedPath);
      }
    }

    if (changed.length === 0 && deleted.length === 0) {
      log(`${project.name}: up to date (${diskFiles.length} files, scan ${collectMs}ms)`);
      continue;
    }

    log(`${project.name}: ${changed.length} changed, ${deleted.length} deleted (of ${diskFiles.length} on disk, scan ${collectMs}ms)`);

    if (deleted.length > 0) {
      for (let i = 0; i < deleted.length; i += BATCH_SIZE) {
        const batch = deleted.slice(i, i + BATCH_SIZE);
        await postJson(`${serviceUrl}/internal/ingest`, { deletes: batch });
        recordIngest({ deletes: batch.length });
      }
    }

    if (language === 'content') {
      for (let i = 0; i < changed.length; i += BATCH_SIZE * 10) {
        const batch = changed.slice(i, i + BATCH_SIZE * 10);
        const assets = [];
        for (const f of batch) {
          try { assets.push(parseAsset(f.path, project)); } catch {}
        }
        if (assets.length > 0) {
          await postJson(`${serviceUrl}/internal/ingest`, { assets });
          recordIngest({ assets: assets.length });
        }
        if ((i + batch.length) % 5000 < BATCH_SIZE * 10) {
          log(`${project.name}: ${i + batch.length}/${changed.length} assets reconciled`);
        }
      }
    } else {
      let pendingPost = null;
      let pendingFilesCount = 0;
      for (let i = 0; i < changed.length; i += BATCH_SIZE) {
        const batch = changed.slice(i, i + BATCH_SIZE);
        const parsePromise = readAndParseBatch(batch, project, language);

        if (pendingPost) {
          await pendingPost;
          recordIngest({ files: pendingFilesCount });
        }

        const parsed = await parsePromise;

        if (parsed.length > 0) {
          pendingFilesCount = parsed.length;
          pendingPost = postJson(`${serviceUrl}/internal/ingest`, { files: parsed });
        } else {
          pendingFilesCount = 0;
          pendingPost = null;
        }

        if ((i + batch.length) % 500 < BATCH_SIZE) {
          log(`${project.name}: ${i + batch.length}/${changed.length} files reconciled`);
        }
      }
      if (pendingPost) {
        await pendingPost;
        recordIngest({ files: pendingFilesCount });
      }
    }
  }
}

async function runReconcileProjects(projectNames) {
  log(`Reconciling languages/projects in worker...`);
  const reconcileStart = performance.now();

  const selected = projectNames?.length
    ? config.projects.filter(p => projectNames.includes(p.name))
    : config.projects;

  for (const project of selected) {
    try {
      await runReconcile(project);
    } catch (err) {
      errorsCount++;
      recordIngest({ errors: 1 });
      warn(`Reconcile failed for ${project.name}: ${err.message}`);
    }
  }

  const reconcileS = ((performance.now() - reconcileStart) / 1000).toFixed(1);
  log(`Reconciliation complete (${reconcileS}s)`);
}

async function main() {
  if (!serviceUrl) throw new Error('scan-worker missing serviceUrl');
  if (!config || !Array.isArray(config.projects)) throw new Error('scan-worker missing config.projects');
  if (!task || !task.kind) throw new Error('scan-worker missing task.kind');

  if (task.kind === 'full-scan') {
    await runFullScan(task.languages || []);
    return;
  }

  if (task.kind === 'reconcile') {
    await runReconcileProjects(task.projectNames || null);
    return;
  }

  throw new Error(`Unknown task kind: ${task.kind}`);
}

main()
  .then(() => {
    postMessage('result', {
      telemetry: {
        filesIngested,
        assetsIngested,
        deletesProcessed,
        errorsCount,
        lastIngestAt
      }
    });
  })
  .catch((err) => {
    postMessage('log', {
      level: 'error',
      message: `${workerPrefix} Fatal error: ${err.stack || err.message}`
    });
    process.exit(1);
  });
