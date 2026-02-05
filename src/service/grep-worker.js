import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';

const { files, pattern, flags, maxResults, contextLines, literals } = workerData;

const regex = new RegExp(pattern, flags);
const results = [];
let totalMatches = 0;
let filesSearched = 0;
let aborted = false;

parentPort.on('message', (msg) => {
  if (msg === 'abort') aborted = true;
});

for (const entry of files) {
  if (aborted || results.length >= maxResults) break;
  filesSearched++;

  let content;
  try {
    content = readFileSync(entry.filePath, 'utf-8');
  } catch {
    continue;
  }

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
        file: entry.filePath,
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
