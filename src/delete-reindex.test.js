/**
 * A deleted source file must leave the zoekt layer too, not only the database.
 *
 * A delete-only /internal/ingest batch never triggered a zoekt reindex (affectedProjects stayed
 * empty), so unreal_grep kept returning a file that find_file had already forgotten.
 *
 * Also: POST /refresh must not answer success when the service cannot see any source path.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IndexDatabase } from './service/database.js';
import { createApi } from './service/api.js';
import { ZoektMirror } from './service/zoekt-mirror.js';

const PORT = 3898;
const BASE = `http://127.0.0.1:${PORT}`;
const calls = { reindexed: [] };
let database, server, app, tmpDir;

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

function fileOf(tree, project, relativePath, typeName) {
  return {
    path: `${tree}${project}/${relativePath}`,
    project, relativePath, module: `${project}.Probe`, language: 'cpp', mtime: 1700000000,
    content: `struct ${typeName} {};`,
    types: [{ name: typeName, kind: 'struct', parent: null, line: 1 }], members: []
  };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'unreal-index-delete-'));
  mkdirSync(join(tmpDir, 'mirror'), { recursive: true });
  database = new IndexDatabase(join(tmpDir, 'test.db')).open();
  const mirror = new ZoektMirror(join(tmpDir, 'mirror'));
  mirror.pathPrefix = '/t/';
  const zoektManager = {
    updateMirrorFile() {},
    deleteMirrorFile() {},
    triggerReindex(count, projects) { calls.reindexed.push([...(projects || [])]); },
    isAvailable() { return false; },
    getStatus() { return { available: false }; }
  };
  app = createApi(database, null, null, { zoektClient: null, zoektManager, zoektMirror: mirror });
  server = await new Promise((r) => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });
});

after(() => {
  if (app?._depthDebounceTimer) clearTimeout(app._depthDebounceTimer);
  if (app?._watcherPruneInterval) clearInterval(app._watcherPruneInterval);
  if (server) server.close();
  if (database) database.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('POST /internal/ingest - a source delete reaches zoekt', () => {
  it('a delete-only batch reindexes the deleted file\'s project', async () => {
    const f = fileOf('/t/', 'MyPlugins', 'Probe/Probe.h', 'FDeleteProbeA');
    assert.equal((await postJson(`${BASE}/internal/ingest`, { files: [f] })).status, 200);
    calls.reindexed.length = 0;
    const { data } = await postJson(`${BASE}/internal/ingest`, { deletes: [f.path] });
    assert.equal(data.processed, 1);
    assert.deepEqual(calls.reindexed, [['MyPlugins']], 'the delete must trigger a reindex of MyPlugins');
  });

  it('a delete of a file the index never had reindexes nothing', async () => {
    calls.reindexed.length = 0;
    const { data } = await postJson(`${BASE}/internal/ingest`, { deletes: ['/t/MyPlugins/Never/There.h'] });
    assert.equal(data.processed, 0);
    assert.deepEqual(calls.reindexed, []);
  });
});

describe('POST /refresh - never a silent no-op', () => {
  const PORT2 = 3897;
  let srv2, app2, rebuilt = 0;
  const start = async (paths) => {
    rebuilt = 0;
    app2 = createApi(database, { config: { projects: [{ name: 'X', paths }] }, fullRebuild: async () => { rebuilt++; return {}; } },
                     null, { zoektClient: null, zoektManager: null, zoektMirror: null });
    srv2 = await new Promise((r) => { const s = app2.listen(PORT2, '127.0.0.1', () => r(s)); });
  };
  const stop = () => {
    if (app2?._depthDebounceTimer) clearTimeout(app2._depthDebounceTimer);
    if (app2?._watcherPruneInterval) clearInterval(app2._watcherPruneInterval);
    srv2.close();
  };

  it('refuses, and says why, when no configured source path is visible', async () => {
    await start(['/nonexistent/source/tree']);
    try {
      const { status, data } = await postJson(`http://127.0.0.1:${PORT2}/refresh`, {});
      assert.equal(status, 409);
      assert.equal(data.success, false);
      assert.match(data.error, /watcher/);
      assert.equal(rebuilt, 0, 'no rebuild may be reported when none could run');
    } finally { stop(); }
  });

  it('rebuilds when the source paths are visible', async () => {
    await start([tmpDir]);
    try {
      const { status } = await postJson(`http://127.0.0.1:${PORT2}/refresh`, {});
      assert.equal(status, 200);
      assert.equal(rebuilt, 1);
    } finally { stop(); }
  });
});
