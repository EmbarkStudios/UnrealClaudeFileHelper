export const WATCHER_HEAP_DEFAULT_MB = 8192;
export const WATCHER_HEAP_MIN_MB = 512;
export const WATCHER_HEAP_MAX_MB = 32768;

/**
 * Normalize heap size for Node --max-old-space-size.
 * Ensures a finite integer and clamps to a safe range.
 */
export function normalizeWatcherHeapMb(rawValue, {
  defaultMb = WATCHER_HEAP_DEFAULT_MB,
  minMb = WATCHER_HEAP_MIN_MB,
  maxMb = WATCHER_HEAP_MAX_MB
} = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return defaultMb;

  const heapMb = Math.trunc(parsed);
  if (heapMb < minMb) return minMb;
  if (heapMb > maxMb) return maxMb;
  return heapMb;
}

