import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { inflateSync } from 'zlib';

export class ZoektMirror {
  constructor(mirrorDir) {
    this.mirrorDir = mirrorDir;
    this.pathPrefix = '';
    this.markerPath = join(mirrorDir, '.zoekt-mirror-marker');
  }

  isReady() {
    return existsSync(this.markerPath);
  }

  getMirrorRoot() {
    return this.mirrorDir;
  }

  bootstrapFromDatabase(database) {
    const startMs = performance.now();
    console.log('[ZoektMirror] Bootstrapping mirror from database...');

    mkdirSync(this.mirrorDir, { recursive: true });

    // Compute common path prefix across ALL projects (one sample per project + extras)
    const sample = database.db.prepare(
      `SELECT path FROM (
        SELECT path, ROW_NUMBER() OVER (PARTITION BY project ORDER BY ROWID) as rn
        FROM files WHERE language NOT IN ('content', 'asset')
      ) WHERE rn <= 5`
    ).all().map(r => r.path.replace(/\\/g, '/'));

    if (sample.length > 0) {
      this.pathPrefix = sample[0];
      for (const p of sample) {
        while (this.pathPrefix && !p.startsWith(this.pathPrefix)) {
          this.pathPrefix = this.pathPrefix.slice(0, this.pathPrefix.lastIndexOf('/'));
        }
      }
      if (this.pathPrefix && !this.pathPrefix.endsWith('/')) this.pathPrefix += '/';
    }

    // Fetch all source file content from SQLite
    const rows = database.db.prepare(
      `SELECT fc.content, f.path FROM file_content fc
       JOIN files f ON f.id = fc.file_id
       WHERE f.language NOT IN ('content', 'asset')`
    ).all();

    let written = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        const content = inflateSync(row.content);
        const relativePath = this._toRelativePath(row.path);
        const fullPath = join(this.mirrorDir, relativePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
        written++;
      } catch (err) {
        errors++;
        if (errors <= 5) {
          console.warn(`[ZoektMirror] Error writing ${row.path}: ${err.message}`);
        }
      }
    }

    // Write marker file
    writeFileSync(this.markerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      fileCount: written,
      pathPrefix: this.pathPrefix
    }));

    const durationS = ((performance.now() - startMs) / 1000).toFixed(1);
    console.log(`[ZoektMirror] Bootstrap complete: ${written} files written, ${errors} errors (${durationS}s)`);
    return written;
  }

  loadPrefix(database) {
    // Load prefix from marker or recompute
    if (existsSync(this.markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(this.markerPath, 'utf-8'));
        if (marker.pathPrefix) {
          this.pathPrefix = marker.pathPrefix;
          return;
        }
      } catch {}
    }

    const sample = database.db.prepare(
      `SELECT path FROM (
        SELECT path, ROW_NUMBER() OVER (PARTITION BY project ORDER BY ROWID) as rn
        FROM files WHERE language NOT IN ('content', 'asset')
      ) WHERE rn <= 5`
    ).all().map(r => r.path.replace(/\\/g, '/'));

    if (sample.length > 0) {
      this.pathPrefix = sample[0];
      for (const p of sample) {
        while (this.pathPrefix && !p.startsWith(this.pathPrefix)) {
          this.pathPrefix = this.pathPrefix.slice(0, this.pathPrefix.lastIndexOf('/'));
        }
      }
      if (this.pathPrefix && !this.pathPrefix.endsWith('/')) this.pathPrefix += '/';
    }
  }

  updateFile(filePath, content) {
    try {
      const relativePath = this._toRelativePath(filePath);
      const fullPath = join(this.mirrorDir, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    } catch (err) {
      console.warn(`[ZoektMirror] Error updating ${filePath}: ${err.message}`);
    }
  }

  deleteFile(filePath) {
    try {
      const relativePath = this._toRelativePath(filePath);
      const fullPath = join(this.mirrorDir, relativePath);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    } catch (err) {
      // File may already be gone
    }
  }

  getPathPrefix() {
    return this.pathPrefix;
  }

  _toRelativePath(fullPath) {
    const normalized = fullPath.replace(/\\/g, '/');
    if (this.pathPrefix && normalized.startsWith(this.pathPrefix)) {
      return normalized.slice(this.pathPrefix.length);
    }
    return normalized;
  }
}
