import { normalizeWatcherHeapMb } from './heap-config.js';

export function buildWatcherNodeSpawnArgs({ scriptPath, workspaceName = null, maxOldSpaceSizeMb }) {
  const heapMb = normalizeWatcherHeapMb(maxOldSpaceSizeMb);
  const args = [`--max-old-space-size=${heapMb}`, scriptPath];
  if (workspaceName) args.push('--workspace', workspaceName);
  return { heapMb, args };
}

export function buildWatcherCmdStartArgs({ scriptPath, title = 'Unreal Index Watcher', maxOldSpaceSizeMb }) {
  const heapMb = normalizeWatcherHeapMb(maxOldSpaceSizeMb);
  return {
    heapMb,
    args: ['/c', 'start', title, 'node', `--max-old-space-size=${heapMb}`, scriptPath]
  };
}

