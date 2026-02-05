import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { extractTrigrams, contentHash } from './trigram.js';

const { files } = workerData;
const results = [];

for (const file of files) {
  try {
    const content = readFileSync(file.path, 'utf-8');
    if (content.length > 500000) continue;

    const trigrams = [...extractTrigrams(content)];
    const compressed = deflateSync(content);
    const hash = contentHash(content);

    results.push({
      fileId: file.id,
      trigrams,
      compressedContent: compressed,
      contentHash: hash
    });
  } catch {
    // skip unreadable files
  }
}

parentPort.postMessage({ type: 'complete', results });
