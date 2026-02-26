import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from './service/api.js';

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

describe('POST /internal/start-watcher heap args', () => {
  let app;
  let server;
  let spawnCalls;
  let indexer;

  beforeEach(async () => {
    const noRows = [];
    const db = {
      prepare() {
        return {
          all() { return noRows; },
          get() { return { count: 0, min_path: null, max_path: null }; },
          run() { return { changes: 0 }; }
        };
      }
    };
    const database = {
      db,
      projectExists() { return true; },
      getDistinctProjects() { return []; }
    };

    spawnCalls = [];
    const spawnProcess = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return {
        on() {},
        unref() {}
      };
    };

    indexer = {
      config: {
        watcher: {
          windowsRepoDir: 'C:\\repo'
        }
      }
    };

    app = createApi(database, indexer, null, { spawnProcess });
    server = await startServer(app);
  });

  afterEach(() => {
    if (app?._depthDebounceTimer) clearTimeout(app._depthDebounceTimer);
    if (app?._watcherPruneInterval) clearInterval(app._watcherPruneInterval);
    if (server) server.close();
  });

  it('uses normalized default heap for non-finite values', async () => {
    indexer.config.watcher.maxOldSpaceSizeMb = 'Infinity';
    const { port } = server.address();
    const { status, data } = await postJson(`http://127.0.0.1:${port}/internal/start-watcher`, {});
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args.includes('--max-old-space-size=8192'));
  });

  it('clamps negative heap values to minimum', async () => {
    indexer.config.watcher.maxOldSpaceSizeMb = -1;
    const { port } = server.address();
    const { status, data } = await postJson(`http://127.0.0.1:${port}/internal/start-watcher`, {});
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args.includes('--max-old-space-size=512'));
  });
});
