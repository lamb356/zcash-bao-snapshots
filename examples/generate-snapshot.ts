#!/usr/bin/env npx ts-node
/**
 * Example: Generate a Bao-encoded snapshot from zcashd.
 *
 * This script demonstrates how to use the SnapshotGenerator to create
 * verified snapshots of Zcash tree states.
 *
 * Prerequisites:
 * - Running zcashd node with RPC enabled
 * - RPC credentials configured
 *
 * Usage:
 *   npx ts-node examples/generate-snapshot.ts
 *
 * Or set environment variables:
 *   ZCASH_RPC_USER=myuser ZCASH_RPC_PASSWORD=mypass npx ts-node examples/generate-snapshot.ts
 */

import { ZcashRpcClient, SnapshotGenerator } from '../src/index.js';
import type { SnapshotProgress } from '../src/index.js';

async function main() {
  // Configuration - modify these or use environment variables
  const config = {
    rpcHost: process.env['ZCASH_RPC_HOST'] ?? '127.0.0.1',
    rpcPort: parseInt(process.env['ZCASH_RPC_PORT'] ?? '8232', 10),
    rpcUser: process.env['ZCASH_RPC_USER'] ?? 'zcashrpc',
    rpcPass: process.env['ZCASH_RPC_PASSWORD'] ?? 'your-password-here',
    outputDir: './snapshots',
    // Set to a specific height, or leave undefined to use current height - 100
    targetHeight: undefined as number | undefined,
  };

  console.log('Zcash Bao Snapshot Generator');
  console.log('============================\n');

  // Create RPC client
  console.log(`Connecting to zcashd at ${config.rpcHost}:${config.rpcPort}...`);

  const client = new ZcashRpcClient({
    host: config.rpcHost,
    port: config.rpcPort,
    username: config.rpcUser,
    password: config.rpcPass,
    logger: {
      debug: () => {},
      info: (msg) => console.log(`[RPC] ${msg}`),
      warn: (msg) => console.warn(`[RPC] ${msg}`),
      error: (msg) => console.error(`[RPC] ${msg}`),
    },
  });

  // Wait for node to be ready
  try {
    console.log('Waiting for node to be ready...');
    await client.waitForReady(60000, 2000);
    console.log('Node is ready!\n');
  } catch (error) {
    console.error('Failed to connect to zcashd. Is it running?');
    console.error('Make sure RPC is enabled and credentials are correct.');
    process.exit(1);
  }

  // Get blockchain info
  const info = await client.getBlockchainInfo();
  console.log(`Network: ${info.chain}`);
  console.log(`Current height: ${info.blocks}`);
  console.log(`Headers: ${info.headers}\n`);

  // Determine target height
  const height = config.targetHeight ?? Math.max(0, info.blocks - 100);
  console.log(`Target snapshot height: ${height}\n`);

  // Create generator
  const generator = new SnapshotGenerator(client);

  // Progress tracking
  const startTime = Date.now();
  let lastPhase = '';

  // Generate snapshot - Combined mode
  console.log('Generating combined mode snapshot...');
  console.log('-----------------------------------');

  try {
    const combinedResult = await generator.createSnapshot({
      height,
      outputDir: config.outputDir,
      network: info.chain as 'mainnet' | 'testnet' | 'regtest',
      mode: 'combined',
      description: `Example snapshot at height ${height}`,
      onProgress: (progress: SnapshotProgress) => {
        if (progress.phase !== lastPhase) {
          console.log(`\n[${progress.phase}]`);
          lastPhase = progress.phase;
        }
        if (progress.percent !== undefined) {
          process.stdout.write(`\r  Progress: ${progress.percent.toFixed(1)}%`);
        }
      },
    });

    console.log('\n');
    console.log('Combined snapshot created!');
    console.log(`  BAO file: ${combinedResult.baoPath}`);
    console.log(`  Metadata: ${combinedResult.metadataPath}`);
    console.log(`  Root hash: ${combinedResult.metadata.rootHash}`);
    console.log(`  Original size: ${formatBytes(combinedResult.metadata.originalSize)}`);
    console.log(`  Encoded size: ${formatBytes(combinedResult.metadata.encodedSize)}`);
    console.log(`  Time: ${combinedResult.elapsedMs}ms\n`);
  } catch (error) {
    console.error('\nFailed to create combined snapshot:', error);
  }

  // Generate snapshot - Outboard mode with Iroh compatibility
  console.log('Generating Iroh-compatible outboard snapshot...');
  console.log('----------------------------------------------');
  lastPhase = '';

  try {
    const outboardResult = await generator.createSnapshot({
      height,
      outputDir: config.outputDir,
      network: info.chain as 'mainnet' | 'testnet' | 'regtest',
      mode: 'outboard',
      irohCompatible: true,
      description: `Iroh-compatible snapshot at height ${height}`,
      onProgress: (progress: SnapshotProgress) => {
        if (progress.phase !== lastPhase) {
          console.log(`\n[${progress.phase}]`);
          lastPhase = progress.phase;
        }
        if (progress.percent !== undefined) {
          process.stdout.write(`\r  Progress: ${progress.percent.toFixed(1)}%`);
        }
      },
    });

    console.log('\n');
    console.log('Outboard snapshot created!');
    console.log(`  BAO file (outboard): ${outboardResult.baoPath}`);
    console.log(`  Data file: ${outboardResult.dataPath}`);
    console.log(`  Metadata: ${outboardResult.metadataPath}`);
    console.log(`  Root hash: ${outboardResult.metadata.rootHash}`);
    console.log(`  Original size: ${formatBytes(outboardResult.metadata.originalSize)}`);
    console.log(`  Outboard size: ${formatBytes(outboardResult.metadata.encodedSize)}`);
    console.log(`  Iroh compatible: ${outboardResult.metadata.irohCompatible}`);
    console.log(`  Time: ${outboardResult.elapsedMs}ms\n`);
  } catch (error) {
    console.error('\nFailed to create outboard snapshot:', error);
  }

  const totalTime = Date.now() - startTime;
  console.log(`\nTotal time: ${(totalTime / 1000).toFixed(2)}s`);
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
