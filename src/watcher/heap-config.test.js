import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWatcherHeapMb,
  WATCHER_HEAP_DEFAULT_MB,
  WATCHER_HEAP_MIN_MB,
  WATCHER_HEAP_MAX_MB
} from './heap-config.js';

test('normalizeWatcherHeapMb uses default for non-finite values', () => {
  assert.equal(normalizeWatcherHeapMb(undefined), WATCHER_HEAP_DEFAULT_MB);
  assert.equal(normalizeWatcherHeapMb('Infinity'), WATCHER_HEAP_DEFAULT_MB);
  assert.equal(normalizeWatcherHeapMb(NaN), WATCHER_HEAP_DEFAULT_MB);
});

test('normalizeWatcherHeapMb clamps low and high values', () => {
  assert.equal(normalizeWatcherHeapMb(-1), WATCHER_HEAP_MIN_MB);
  assert.equal(normalizeWatcherHeapMb(1), WATCHER_HEAP_MIN_MB);
  assert.equal(normalizeWatcherHeapMb(WATCHER_HEAP_MAX_MB + 1), WATCHER_HEAP_MAX_MB);
});

test('normalizeWatcherHeapMb returns integer value inside bounds', () => {
  assert.equal(normalizeWatcherHeapMb('4096'), 4096);
  assert.equal(normalizeWatcherHeapMb(2048.9), 2048);
});

