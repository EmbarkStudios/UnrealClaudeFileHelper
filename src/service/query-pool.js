import { Worker } from 'worker_threads';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, 'query-worker.js');

export class QueryPool {
  constructor(dbPath, workerCount = 3) {
    this.dbPath = dbPath;
    this.workerCount = workerCount;
    this.workers = [];         // { worker, busy, pending: Map<id, {resolve,reject,timer}> }
    this.queue = [];           // { id, method, args, resolve, reject, timeoutMs }
    this.nextId = 0;
  }

  async spawn() {
    const readyPromises = [];

    for (let i = 0; i < this.workerCount; i++) {
      readyPromises.push(this._spawnWorker(i));
    }

    await Promise.all(readyPromises);
  }

  _spawnWorker(index) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: { dbPath: this.dbPath }
      });

      const entry = { worker, busy: false, pending: new Map(), index };

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          resolve();
          return;
        }

        const cb = entry.pending.get(msg.id);
        if (!cb) return;
        entry.pending.delete(msg.id);

        clearTimeout(cb.timer);

        if (entry.pending.size === 0) {
          entry.busy = false;
        }

        if (msg.error) {
          cb.reject(new Error(msg.error));
        } else {
          cb.resolve({ result: msg.result, durationMs: msg.durationMs });
        }

        // Process next queued request
        this._processQueue();
      });

      worker.on('error', (err) => {
        console.error(`[QueryPool] Worker ${index} error:`, err.message);
        // Reject all pending requests
        for (const [, cb] of entry.pending) {
          clearTimeout(cb.timer);
          cb.reject(err);
        }
        entry.pending.clear();
        this._replaceWorker(index);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[QueryPool] Worker ${index} exited with code ${code}`);
          this._replaceWorker(index);
        }
      });

      this.workers[index] = entry;
    });
  }

  _replaceWorker(index) {
    console.log(`[QueryPool] Respawning worker ${index}...`);
    this._spawnWorker(index).then(() => {
      console.log(`[QueryPool] Worker ${index} respawned`);
      this._processQueue();
    }).catch(err => {
      console.error(`[QueryPool] Failed to respawn worker ${index}:`, err.message);
    });
  }

  execute(method, args, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request = { id, method, args, resolve, reject, timeoutMs };

      // Find an idle worker
      const worker = this.workers.find(w => !w.busy);
      if (worker) {
        this._dispatch(worker, request);
      } else {
        this.queue.push(request);
      }
    });
  }

  _dispatch(entry, request) {
    entry.busy = true;

    const timer = setTimeout(() => {
      entry.pending.delete(request.id);
      if (entry.pending.size === 0) entry.busy = false;
      request.reject(new Error(`Query timeout after ${request.timeoutMs}ms: ${request.method}`));
      this._processQueue();
    }, request.timeoutMs);

    entry.pending.set(request.id, {
      resolve: request.resolve,
      reject: request.reject,
      timer
    });

    entry.worker.postMessage({
      id: request.id,
      method: request.method,
      args: request.args
    });
  }

  _processQueue() {
    while (this.queue.length > 0) {
      const worker = this.workers.find(w => !w.busy);
      if (!worker) break;
      this._dispatch(worker, this.queue.shift());
    }
  }

  shutdown() {
    for (const entry of this.workers) {
      if (entry) {
        for (const [, cb] of entry.pending) {
          clearTimeout(cb.timer);
          cb.reject(new Error('Pool shutting down'));
        }
        entry.worker.terminate();
      }
    }
    this.workers = [];
    this.queue = [];
  }
}
