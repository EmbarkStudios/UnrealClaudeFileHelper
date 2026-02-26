import { join } from 'path';
import { openSync, closeSync } from 'fs';
import { buildWatcherNodeSpawnArgs } from './watcher/watcher-launch.js';

export function startWorkspaceWatcher({
  rootDir,
  workspaceName,
  workspaceConfig,
  spawnProcess,
  nodeExecPath
}) {
  const watcherScript = join(rootDir, 'src', 'watcher', 'watcher-client.js');
  const { heapMb, args } = buildWatcherNodeSpawnArgs({
    scriptPath: watcherScript,
    workspaceName,
    maxOldSpaceSizeMb: workspaceConfig?.watcher?.maxOldSpaceSizeMb
  });

  const logPath = join(rootDir, `watcher-${workspaceName}.log`);
  const logFd = openSync(logPath, 'a');
  let child;
  try {
    child = spawnProcess(nodeExecPath, args, {
      cwd: rootDir,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
  } catch (err) {
    try { closeSync(logFd); } catch {}
    throw err;
  }

  return { child, heapMb, logPath, logFd };
}
