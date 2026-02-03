#!/usr/bin/env node

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Indexer } from './indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const configPath = join(__dirname, '..', 'config.json');
  const configContent = await readFile(configPath, 'utf-8');
  const config = JSON.parse(configContent);

  console.log('Building index...');
  const startTime = Date.now();

  const indexer = new Indexer(config);
  await indexer.buildIndex();

  const stats = indexer.getStats();
  console.log(`\nIndex built in ${stats.buildTimeMs}ms`);
  console.log(`\nStatistics:`);
  console.log(`  Total files: ${stats.totalFiles}`);
  console.log(`  Classes: ${stats.totalClasses}`);
  console.log(`  Structs: ${stats.totalStructs}`);
  console.log(`  Enums: ${stats.totalEnums}`);
  console.log(`  Events: ${stats.totalEvents}`);
  console.log(`  Delegates: ${stats.totalDelegates}`);
  console.log(`  Namespaces: ${stats.totalNamespaces}`);

  console.log(`\nPer project:`);
  for (const [name, data] of Object.entries(stats.projects)) {
    console.log(`  ${name}: ${data.files} files, ${data.classes} classes, ${data.structs} structs`);
  }

  const cachePath = join(__dirname, '..', config.cacheFile);
  await indexer.saveToCache(cachePath);
  console.log(`\nIndex saved to: ${cachePath}`);

  console.log('\nTest queries:');

  console.log('\n1. Finding ADiscoveryPlayerController:');
  const result1 = indexer.findTypeByName('ADiscoveryPlayerController');
  console.log(JSON.stringify(result1, null, 2));

  console.log('\n2. Fuzzy search for "PlayerController":');
  const result2 = indexer.findTypeByName('PlayerController', { fuzzy: true, maxResults: 5 });
  console.log(JSON.stringify(result2, null, 2));

  console.log('\n3. Finding children of ADiscoveryPlayerControllerBase:');
  const result3 = indexer.findChildrenOf('ADiscoveryPlayerControllerBase');
  console.log(JSON.stringify(result3, null, 2));
}

main().catch(console.error);
