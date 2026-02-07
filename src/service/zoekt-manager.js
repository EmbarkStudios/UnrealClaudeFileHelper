import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class ZoektManager {
  constructor(config) {
    this.indexDir = config.indexDir;
    this.wslIndexDir = null; // WSL-native index path (faster than /mnt/c/)
    this.wslMirrorDir = null; // WSL-native mirror copy (faster reads for indexing)
    this.webPort = config.webPort || 6070;
    this.parallelism = config.parallelism || 4;
    this.fileLimitBytes = config.fileLimitBytes || 524288;
    this.reindexDebounceMs = config.reindexDebounceMs || 5000;
    this.zoektBin = config.zoektBin || null;

    this.webProcess = null;
    this.indexProcess = null;
    this.reindexTimer = null;
    this.reindexPromise = null;
    this.mirrorRoot = null;
    this.available = false;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 5;
    this.zoektIndexPath = null;
    this.zoektWebPath = null;
    this.useWsl = false; // Whether to run Zoekt via WSL2
  }

  /**
   * Convert a Windows path to WSL path format.
   * C:\Users\foo\bar -> /mnt/c/Users/foo/bar
   */
  _toWslPath(winPath) {
    const normalized = winPath.replace(/\\/g, '/');
    // Match drive letter: C:/... -> /mnt/c/...
    const match = normalized.match(/^([A-Za-z]):\/(.*)/);
    if (match) {
      return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
    }
    return normalized;
  }

  _findBinaries() {
    const candidates = [];

    if (this.zoektBin) {
      candidates.push(this.zoektBin);
    }

    // Check GOPATH/bin
    const gopath = process.env.GOPATH || join(process.env.USERPROFILE || process.env.HOME || '', 'go');
    candidates.push(join(gopath, 'bin'));

    // Check PATH for native binaries
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const indexPath = execSync(`${which} zoekt-index`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0].trim();
      if (indexPath) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = indexPath.replace('zoekt-index', 'zoekt-webserver');
        if (process.platform === 'win32') {
          this.zoektWebPath = this.zoektWebPath.replace('zoekt-index.exe', 'zoekt-webserver.exe');
        }
        return true;
      }
    } catch {}

    // Check candidate directories for native binaries
    for (const dir of candidates) {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const indexPath = join(dir, `zoekt-index${ext}`);
      const webPath = join(dir, `zoekt-webserver${ext}`);
      if (existsSync(indexPath) && existsSync(webPath)) {
        this.zoektIndexPath = indexPath;
        this.zoektWebPath = webPath;
        return true;
      }
    }

    // On Windows, try WSL2 as fallback (Zoekt doesn't build natively on Windows)
    if (process.platform === 'win32') {
      return this._findWslBinaries();
    }

    return false;
  }

  _findWslBinaries() {
    try {
      // Check if WSL is available and has Zoekt installed
      // Also get the home directory for WSL-native index storage
      const result = execSync(
        'wsl -d Ubuntu -- bash -c "export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH && which zoekt-index 2>/dev/null && which zoekt-webserver 2>/dev/null && echo $HOME"',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
      ).trim();

      const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length >= 3) {
        this.zoektIndexPath = lines[0];
        this.zoektWebPath = lines[1];
        const wslHome = lines[2];
        // Use WSL-native filesystem for index + mirror (much faster than /mnt/c/)
        this.wslIndexDir = `${wslHome}/.zoekt-index`;
        this.wslMirrorDir = `${wslHome}/.zoekt-mirror`;
        this.useWsl = true;
        return true;
      }
    } catch {}

    return false;
  }

  /**
   * Spawn a process, either directly or via WSL depending on platform.
   */
  _spawn(binaryPath, args) {
    if (this.useWsl) {
      // Run via WSL: translate all path arguments to WSL paths
      const wslArgs = args.map(arg => {
        // Detect Windows absolute paths and convert them
        if (/^[A-Za-z]:[\\/]/.test(arg)) {
          return this._toWslPath(arg);
        }
        return arg;
      });

      const bashCmd = `export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH && ${binaryPath} ${wslArgs.map(a => `'${a}'`).join(' ')}`;
      return spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', bashCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    }

    return spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  }

  async start() {
    if (!this._findBinaries()) {
      console.warn('[ZoektManager] Zoekt binaries not found. Install with: go install github.com/sourcegraph/zoekt/cmd/...@latest');
      return false;
    }

    const mode = this.useWsl ? 'WSL2' : 'native';
    console.log(`[ZoektManager] Found binaries (${mode}): ${this.zoektIndexPath}`);

    if (this.useWsl && this.wslIndexDir) {
      // Create directories on WSL-native filesystem (fast ext4)
      try {
        execSync(`wsl -d Ubuntu -- bash -c "mkdir -p '${this.wslIndexDir}' '${this.wslMirrorDir}'"`, { stdio: 'ignore', timeout: 5000 });
        console.log(`[ZoektManager] Using WSL-native dirs: index=${this.wslIndexDir}, mirror=${this.wslMirrorDir}`);
      } catch (err) {
        console.warn(`[ZoektManager] Failed to create WSL dirs, falling back to Windows paths`);
        this.wslIndexDir = null;
        this.wslMirrorDir = null;
      }
    }

    if (!this.useWsl) {
      mkdirSync(this.indexDir, { recursive: true });
    }

    return this._startWebserver();
  }

  /**
   * Get the effective index directory path (WSL-native or Windows).
   * Used in _startWebserver and runIndex.
   */
  _getIndexDirArg() {
    if (this.useWsl && this.wslIndexDir) {
      return this.wslIndexDir; // Already a Linux path
    }
    return this.useWsl ? this._toWslPath(this.indexDir) : this.indexDir;
  }

  async _startWebserver() {
    return new Promise((resolve) => {
      const args = [
        '-index', this._getIndexDirArg(),
        '-rpc',
        '-listen', `:${this.webPort}`
      ];

      console.log(`[ZoektManager] Starting webserver on port ${this.webPort}...`);
      this.webProcess = this._spawn(this.zoektWebPath, args);

      this.webProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-web] ${line}`);
      });

      this.webProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-web] ${line}`);
      });

      this.webProcess.on('exit', (code, signal) => {
        console.log(`[ZoektManager] Webserver exited (code=${code}, signal=${signal})`);
        this.available = false;
        this.webProcess = null;

        if (this.restartAttempts < this.maxRestartAttempts) {
          const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 30000);
          this.restartAttempts++;
          console.log(`[ZoektManager] Restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`);
          setTimeout(() => this._startWebserver(), delay);
        }
      });

      // Wait for health check
      this._waitForHealthy(10000).then((healthy) => {
        if (healthy) {
          this.available = true;
          this.restartAttempts = 0;
          console.log(`[ZoektManager] Webserver ready on port ${this.webPort}`);
        } else {
          console.warn('[ZoektManager] Webserver failed health check');
        }
        resolve(healthy);
      });
    });
  }

  async _waitForHealthy(timeoutMs) {
    const start = Date.now();
    const interval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.webPort}/`);
        if (resp.ok || resp.status === 200) return true;
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }

  /**
   * Sync mirror from Windows filesystem to WSL-native filesystem.
   * Uses tar pipe for initial copy (much faster than rsync through 9P bridge),
   * and rsync for incremental updates.
   */
  async _syncMirrorToWsl(mirrorRoot) {
    if (!this.useWsl || !this.wslMirrorDir) return this.useWsl ? this._toWslPath(mirrorRoot) : mirrorRoot;

    const wslMirrorSrc = this._toWslPath(mirrorRoot);
    const startMs = performance.now();

    // Check if WSL mirror already has files (incremental sync)
    let existingCount = 0;
    try {
      const countOutput = execSync(
        `wsl -d Ubuntu -- bash -c "find '${this.wslMirrorDir}' -type f 2>/dev/null | wc -l"`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      existingCount = parseInt(countOutput, 10) || 0;
    } catch {}

    if (existingCount > 1000) {
      // Incremental sync with rsync (fast for small changes)
      console.log(`[ZoektManager] Incremental sync (${existingCount} existing files)...`);
      return new Promise((resolve) => {
        const rsyncCmd = `rsync -a --delete '${wslMirrorSrc}/' '${this.wslMirrorDir}/'`;
        const proc = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', rsyncCmd], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('exit', (code) => {
          const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
          if (code === 0) {
            console.log(`[ZoektManager] Incremental sync complete (${durationS}s)`);
            resolve(this.wslMirrorDir);
          } else {
            console.warn(`[ZoektManager] Sync failed, using /mnt/c/: ${stderr.slice(0, 100)}`);
            resolve(wslMirrorSrc);
          }
        });
        proc.on('error', () => resolve(wslMirrorSrc));
      });
    }

    // Initial bulk copy: tar pipe is 10x+ faster than individual file copies through 9P
    console.log('[ZoektManager] Initial mirror sync to WSL-native filesystem (tar pipe)...');
    return new Promise((resolve) => {
      const tarCmd = `cd '${wslMirrorSrc}' && tar cf - . | (mkdir -p '${this.wslMirrorDir}' && cd '${this.wslMirrorDir}' && tar xf -)`;
      const proc = spawn('wsl', ['-d', 'Ubuntu', '--', 'bash', '-c', tarCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('exit', (code) => {
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`[ZoektManager] Mirror sync complete (${durationS}s)`);
          resolve(this.wslMirrorDir);
        } else {
          console.warn(`[ZoektManager] Tar sync failed (code=${code}): ${stderr.slice(0, 200)}`);
          console.warn('[ZoektManager] Falling back to /mnt/c/ path');
          resolve(wslMirrorSrc);
        }
      });
      proc.on('error', () => resolve(wslMirrorSrc));
    });
  }

  async runIndex(mirrorRoot) {
    this.mirrorRoot = mirrorRoot;

    if (this.indexProcess) {
      console.log('[ZoektManager] Index already running, skipping...');
      return;
    }

    // Sync mirror to WSL-native filesystem for fast reads
    const effectiveMirrorPath = await this._syncMirrorToWsl(mirrorRoot);

    return new Promise((resolve, reject) => {
      const startMs = performance.now();
      const args = [
        '-index', this._getIndexDirArg(),
        '-parallelism', String(this.parallelism),
        '-file_limit', String(this.fileLimitBytes),
        effectiveMirrorPath
      ];

      console.log(`[ZoektManager] Starting index of ${mirrorRoot}...`);
      this.indexProcess = this._spawn(this.zoektIndexPath, args);

      let stderr = '';
      this.indexProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index] ${line}`);
      });
      this.indexProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line) console.log(`[zoekt-index] ${line}`);
      });

      this.indexProcess.on('exit', (code) => {
        this.indexProcess = null;
        const durationS = ((performance.now() - startMs) / 1000).toFixed(1);

        if (code === 0) {
          console.log(`[ZoektManager] Index complete (${durationS}s)`);
          resolve();
        } else {
          const msg = `Index failed (code=${code}, ${durationS}s): ${stderr.slice(0, 200)}`;
          console.error(`[ZoektManager] ${msg}`);
          reject(new Error(msg));
        }
      });

      this.indexProcess.on('error', (err) => {
        this.indexProcess = null;
        reject(err);
      });
    });
  }

  triggerReindex() {
    if (!this.mirrorRoot) return;

    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }

    this.reindexTimer = setTimeout(async () => {
      this.reindexTimer = null;
      try {
        await this.runIndex(this.mirrorRoot);
      } catch (err) {
        console.error(`[ZoektManager] Reindex failed: ${err.message}`);
      }
    }, this.reindexDebounceMs);
  }

  isAvailable() {
    return this.available && this.webProcess !== null;
  }

  getPort() {
    return this.webPort;
  }

  async stop() {
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }

    // Prevent auto-restart during shutdown
    this.maxRestartAttempts = 0;

    if (this.indexProcess) {
      this.indexProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (this.indexProcess) {
        try { this.indexProcess.kill('SIGKILL'); } catch {}
      }
    }

    if (this.webProcess) {
      this.webProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      if (this.webProcess) {
        try { this.webProcess.kill('SIGKILL'); } catch {}
      }
    }

    this.available = false;
    console.log('[ZoektManager] Stopped');
  }
}
