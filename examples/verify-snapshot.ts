#!/usr/bin/env npx ts-node
/**
 * Example: Verify a Bao-encoded snapshot.
 *
 * This script demonstrates how to verify snapshots using both:
 * - Local file verification (verifyBaoData, verifyBaoOutboard)
 * - HTTP streaming verification (BaoVerifier)
 *
 * Usage:
 *   npx ts-node examples/verify-snapshot.ts <metadata.json>
 *   npx ts-node examples/verify-snapshot.ts ./snapshots/2000000.metadata.json
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  verifyBaoData,
  verifyBaoOutboard,
  BaoVerifier,
  BaoVerifierError,
} from '../src/verifier/index.js';
import type { SnapshotMetadata } from '../src/index.js';

async function main() {
  const metadataPath = process.argv[2];

  if (!metadataPath) {
    console.log('Usage: npx ts-node examples/verify-snapshot.ts <metadata.json>');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node examples/verify-snapshot.ts ./snapshots/2000000.metadata.json');
    process.exit(1);
  }

  console.log('Zcash Bao Snapshot Verifier');
  console.log('===========================\n');

  // Load metadata
  console.log(`Loading metadata from: ${metadataPath}`);
  const metadataContent = await readFile(metadataPath, 'utf-8');
  const metadata: SnapshotMetadata = JSON.parse(metadataContent);

  console.log('');
  console.log('Snapshot Info:');
  console.log(`  Type: ${metadata.type}`);
  console.log(`  Network: ${metadata.network}`);
  console.log(`  Height: ${metadata.height}`);
  console.log(`  Block Hash: ${metadata.hash}`);
  console.log(`  Root Hash: ${metadata.rootHash}`);
  console.log(`  Original Size: ${formatBytes(metadata.originalSize)}`);
  console.log(`  Encoded Size: ${formatBytes(metadata.encodedSize)}`);
  console.log(`  Mode: ${metadata.outboard ? 'outboard' : 'combined'}`);
  if (metadata.irohCompatible) {
    console.log(`  Iroh Compatible: yes`);
  }
  console.log('');

  // Determine file paths
  const dir = dirname(metadataPath);
  const baseName = metadataPath.replace('.metadata.json', '');
  const baoPath = `${baseName}.bao`;

  // Verify the snapshot
  console.log('Verifying snapshot...');
  console.log('--------------------');

  const startTime = Date.now();

  try {
    let verifiedData: Uint8Array;

    if (metadata.outboard) {
      // Outboard mode - need both .bao (outboard tree) and .data (original data)
      const dataPath = `${baseName}.data`;
      console.log(`Reading data file: ${dataPath}`);
      console.log(`Reading outboard file: ${baoPath}`);

      const [originalData, outboardData] = await Promise.all([
        readFile(dataPath),
        readFile(baoPath),
      ]);

      console.log(`Data size: ${formatBytes(originalData.length)}`);
      console.log(`Outboard size: ${formatBytes(outboardData.length)}`);
      console.log('');

      console.log('Verifying with outboard hash tree...');
      verifiedData = await verifyBaoOutboard(
        new Uint8Array(originalData),
        new Uint8Array(outboardData),
        metadata.rootHash
      );
    } else {
      // Combined mode - .bao contains data + tree interleaved
      console.log(`Reading BAO file: ${baoPath}`);
      const baoData = await readFile(baoPath);
      console.log(`BAO size: ${formatBytes(baoData.length)}`);
      console.log('');

      console.log('Verifying combined data...');
      verifiedData = await verifyBaoData(new Uint8Array(baoData), metadata.rootHash);
    }

    const elapsedMs = Date.now() - startTime;

    console.log('');
    console.log('Verification successful!');
    console.log(`  Verified size: ${formatBytes(verifiedData.length)}`);
    console.log(`  Expected size: ${formatBytes(metadata.originalSize)}`);
    console.log(`  Time: ${elapsedMs}ms`);
    console.log(`  Speed: ${formatBytes(verifiedData.length / (elapsedMs / 1000))}/s`);

    // Validate size matches
    if (verifiedData.length !== metadata.originalSize) {
      console.warn('\n  Warning: Size mismatch!');
    }

    // Show a preview of the data (if it's JSON)
    console.log('');
    console.log('Data Preview:');
    try {
      const text = new TextDecoder().decode(verifiedData.slice(0, 500));
      const json = JSON.parse(text.split('\n')[0] + (text.includes('\n') ? '...' : ''));
      console.log(JSON.stringify(json, null, 2).slice(0, 500) + '...');
    } catch {
      console.log(`  (Binary data, first 64 bytes as hex)`);
      console.log(
        '  ' +
          Array.from(verifiedData.slice(0, 64))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')
      );
    }
  } catch (error) {
    console.error('');
    console.error('Verification failed!');

    if (error instanceof BaoVerifierError) {
      console.error(`  Error code: ${error.code}`);
      console.error(`  Message: ${error.message}`);
      if (error.chunkIndex !== undefined) {
        console.error(`  Failed at chunk: ${error.chunkIndex}`);
      }
    } else if (error instanceof Error) {
      console.error(`  ${error.message}`);
    }

    process.exit(1);
  }

  console.log('');
  console.log('Done!');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
