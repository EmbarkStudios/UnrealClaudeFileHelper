import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldExclude } from './scan-worker.js';
import {
  getConfigReloadAction,
  mergeScanTelemetrySnapshot,
  reconcileFinalTelemetry
} from './scan-telemetry.js';

describe('watcher scan telemetry helpers', () => {
  it('accumulates scan telemetry counters and preserves last ingest timestamp', () => {
    const base = {
      filesIngested: 10,
      assetsIngested: 5,
      deletesProcessed: 2,
      errorsCount: 1,
      lastIngestAt: '2026-02-25T10:00:00.000Z'
    };
    const merged = mergeScanTelemetrySnapshot(base, {
      filesIngested: 3,
      assetsIngested: 2,
      deletesProcessed: 1,
      errorsCount: 4,
      lastIngestAt: '2026-02-25T11:00:00.000Z'
    });

    assert.deepEqual(merged, {
      filesIngested: 13,
      assetsIngested: 7,
      deletesProcessed: 3,
      errorsCount: 5,
      lastIngestAt: '2026-02-25T11:00:00.000Z'
    });
  });

  it('reconciles final worker telemetry against streamed deltas', () => {
    const delta = reconcileFinalTelemetry({
      streamedTelemetry: true,
      streamedTotals: {
        filesIngested: 8,
        assetsIngested: 3,
        deletesProcessed: 1,
        errorsCount: 2
      },
      finalTelemetry: {
        filesIngested: 10,
        assetsIngested: 5,
        deletesProcessed: 4,
        errorsCount: 5,
        lastIngestAt: '2026-02-25T11:00:00.000Z'
      }
    });

    assert.deepEqual(delta, {
      filesIngested: 2,
      assetsIngested: 2,
      deletesProcessed: 3,
      errorsCount: 3,
      lastIngestAt: '2026-02-25T11:00:00.000Z'
    });
  });

  it('clamps reconciled counters at zero and handles missing final telemetry', () => {
    const clamped = reconcileFinalTelemetry({
      streamedTelemetry: true,
      streamedTotals: { filesIngested: 10, assetsIngested: 2, deletesProcessed: 3, errorsCount: 2 },
      finalTelemetry: { filesIngested: 1, assetsIngested: 1, deletesProcessed: 1, errorsCount: 0, lastIngestAt: null }
    });
    assert.deepEqual(clamped, {
      filesIngested: 0,
      assetsIngested: 0,
      deletesProcessed: 0,
      errorsCount: 0,
      lastIngestAt: null
    });

    const missingFinal = reconcileFinalTelemetry({
      streamedTelemetry: true,
      streamedTotals: { filesIngested: 1, assetsIngested: 1, deletesProcessed: 1, errorsCount: 1 },
      finalTelemetry: null
    });
    assert.equal(missingFinal, null);
  });
});

describe('watcher exclude patterns', () => {
  it('matches exact path segments, wildcards, and escaped regex literals', () => {
    const patterns = [
      'Intermediate',
      'Saved/**',
      '*.tmp',
      'Plugins/*/Binaries/**',
      'Dir.With.Dot/**'
    ];

    assert.equal(shouldExclude('C:/Repo/Game/Intermediate/Foo.cpp', patterns), true);
    assert.equal(shouldExclude('C:/Repo/Game/NotIntermediate/Foo.cpp', patterns), false);
    assert.equal(shouldExclude('C:/Repo/Game/Saved/Logs/Run.log', patterns), true);
    assert.equal(shouldExclude('C:/Repo/Game/Plugins/PluginA/Binaries/Win64/a.dll', patterns), true);
    assert.equal(shouldExclude('C:/Repo/Game/Plugins/PluginA/Source/a.cpp', patterns), false);
    assert.equal(shouldExclude('C:/Repo/Game/Dir.With.Dot/file.txt', patterns), true);
    assert.equal(shouldExclude('C:\\Repo\\Game\\Temp\\cache.tmp', patterns), true);
  });
});

describe('watcher bootstrap config reload guard', () => {
  it('defers watcher restart while bootstrap has not started the watcher yet', () => {
    assert.equal(getConfigReloadAction(true, false), 'defer');
    assert.equal(getConfigReloadAction(true, true), 'restart');
    assert.equal(getConfigReloadAction(false, false), 'none');
    assert.equal(getConfigReloadAction(false, true), 'none');
  });
});
