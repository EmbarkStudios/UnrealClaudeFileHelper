import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';

const { files, candidates, pattern, flags, maxResults, contextLines, literals } = workerData;

const regex = new RegExp(pattern, flags);
const results = [];
let totalMatches = 0;
let filesSearched = 0;
let aborted = false;

parentPort.on('message', (msg) => {
  if (msg === 'abort') aborted = true;
});

// Use pre-fetched candidates (trigram path) or file paths (fallback)
const entries = candidates || files;

for (const entry of entries) {
  if (aborted || results.length >= maxResults) break;
  filesSearched++;

  let content;
  if (entry.content) {
    // Pre-fetched compressed content from trigram index
    try {
      content = inflateSync(entry.content).toString('utf-8');
    } catch {
      continue;
    }
  } else {
    // Fallback: read from disk
    try {
      content = readFileSync(entry.filePath, 'utf-8');
    } catch {
      continue;
    }
  }

  const filePath = entry.path || entry.filePath;

  // Fast pre-check: skip files that contain none of the literal terms
  if (literals && !literals.some(lit => content.includes(lit))) continue;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = regex.exec(lines[i]);
    if (!match) continue;

    totalMatches++;
    if (results.length < maxResults) {
      const ctxStart = Math.max(0, i - contextLines);
      const ctxEnd = Math.min(lines.length - 1, i + contextLines);
      const context = [];
      for (let c = ctxStart; c <= ctxEnd; c++) {
        context.push(lines[c]);
      }

      results.push({
        file: filePath,
        project: entry.project,
        language: entry.language,
        line: i + 1,
        column: match.index + 1,
        match: lines[i],
        context
      });
    }

    if (results.length >= maxResults) break;
  }
}

parentPort.postMessage({
  type: 'complete',
  results,
  totalMatches,
  filesSearched,
  aborted
});
