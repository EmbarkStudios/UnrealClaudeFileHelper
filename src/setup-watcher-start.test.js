import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, closeSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorkspaceWatcher } from './setup-watcher-start.js';

describe('setup watcher startup heap args', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('uses normalized default heap for non-finite values', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'setup-watcher-start-'));
    tempDirs.push(rootDir);
    const calls = [];

    const result = startWorkspaceWatcher({
      rootDir,
      workspaceName: 'discovery',
      workspaceConfig: { watcher: { maxOldSpaceSizeMb: 'Infinity' } },
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options });
        return { pid: 12345 };
      },
      nodeExecPath: process.execPath
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--max-old-space-size=8192'));
    assert.equal(result.heapMb, 8192);
    closeSync(result.logFd);
  });

  it('clamps negative heap values to minimum', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'setup-watcher-start-'));
    tempDirs.push(rootDir);
    const calls = [];

    const result = startWorkspaceWatcher({
      rootDir,
      workspaceName: 'discovery',
      workspaceConfig: { watcher: { maxOldSpaceSizeMb: -1 } },
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options });
        return { pid: 12345 };
      },
      nodeExecPath: process.execPath
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--max-old-space-size=512'));
    assert.equal(result.heapMb, 512);
    closeSync(result.logFd);
  });
});

