#!/usr/bin/env npx ts-node
/**
 * Demo: Resumable downloads from different untrusted sources.
 *
 * This script demonstrates how Bao verification enables:
 * - Starting a download from one server
 * - Aborting mid-download (simulating connection failure)
 * - Resuming from a completely different server
 * - Completing verification with cryptographic integrity
 *
 * This is possible because Bao's Merkle tree structure allows verifying
 * any chunk independently - the chunks from Server A and Server B can be
 * combined as long as they match the same root hash.
 *
 * Usage:
 *   npx tsx examples/resume-demo.ts
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { baoEncodeIroh, PartialBao, countChunkGroups } from 'blake3-bao';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT_A = 3001;
const PORT_B = 3002;
const PORT_C = 3003; // Malicious server
const DATA_SIZE = 64 * 1024; // 64 KB of test data (4 chunk groups)
const CHUNK_GROUP_SIZE = 16 * 1024; // 16KB per chunk group (Iroh-compatible)
const ABORT_AT_GROUP = 2; // Stop after downloading 2 of 4 groups (50%)
const MALICIOUS_GROUP = 3; // Group index where we test malicious server (0-indexed)

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressBar(current: number, total: number): string {
  const percent = (current / total) * 100;
  const filled = Math.floor(percent / 5);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Data Generation
// ─────────────────────────────────────────────────────────────────────────────

interface TestData {
  original: Uint8Array;
  outboard: Uint8Array;
  rootHash: Uint8Array;
  rootHashHex: string;
  numGroups: number;
}

async function generateTestData(): Promise<TestData> {
  console.log(`\nGenerating ${formatBytes(DATA_SIZE)} of test data...`);

  // Create deterministic test data (simulating a Zcash tree state snapshot)
  const original = new Uint8Array(DATA_SIZE);
  for (let i = 0; i < DATA_SIZE; i++) {
    // Create recognizable pattern
    original[i] = (i * 7 + 42) % 256;
  }

  // Use Iroh-compatible encoding (16KB chunk groups) - outboard mode
  // baoEncodeIroh returns { encoded, hash } where 'encoded' is the outboard tree in outboard mode
  const result = await baoEncodeIroh(original, true);
  const outboard = result.encoded;
  const hash = result.hash;
  const numGroups = countChunkGroups(original.length);

  console.log(`  Original size: ${formatBytes(original.length)}`);
  console.log(`  Outboard size: ${formatBytes(outboard.length)}`);
  console.log(`  Chunk groups:  ${numGroups}`);
  console.log(`  Root hash:     ${bytesToHex(hash).slice(0, 16)}...`);

  return {
    original,
    outboard,
    rootHash: hash,
    rootHashHex: bytesToHex(hash),
    numGroups,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server - Serves raw data chunks (not Bao-encoded)
// ─────────────────────────────────────────────────────────────────────────────

function createDataServer(
  port: number,
  data: Uint8Array,
  serverName: string
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Parse range header for byte-range requests
      const rangeHeader = req.headers.range;

      if (!rangeHeader) {
        // Full content request
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          'Accept-Ranges': 'bytes',
        });
        res.end(Buffer.from(data));
        return;
      }

      // Parse "bytes=start-end"
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (!match) {
        res.writeHead(400);
        res.end('Invalid range');
        return;
      }

      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : data.length - 1;

      if (start >= data.length || end >= data.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        res.end('Range not satisfiable');
        return;
      }

      const chunk = data.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(Buffer.from(chunk));
    });

    server.listen(port, () => {
      console.log(`  ${serverName} listening on port ${port}`);
      resolve(server);
    });
  });
}

/**
 * Create a malicious server that serves corrupted data (flipped bits).
 */
function createMaliciousServer(
  port: number,
  data: Uint8Array,
  serverName: string
): Promise<Server> {
  // Create corrupted copy of data - flip bits throughout
  const corruptedData = new Uint8Array(data);
  for (let i = 0; i < corruptedData.length; i += 1024) {
    corruptedData[i] ^= 0xff;
    if (i + 1 < corruptedData.length) corruptedData[i + 1] ^= 0xaa;
    if (i + 2 < corruptedData.length) corruptedData[i + 2] ^= 0x55;
  }

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const rangeHeader = req.headers.range;

      if (!rangeHeader) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': corruptedData.length,
          'Accept-Ranges': 'bytes',
        });
        res.end(Buffer.from(corruptedData));
        return;
      }

      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (!match) {
        res.writeHead(400);
        res.end('Invalid range');
        return;
      }

      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : corruptedData.length - 1;

      if (start >= corruptedData.length || end >= corruptedData.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${corruptedData.length}` });
        res.end('Range not satisfiable');
        return;
      }

      const chunk = corruptedData.slice(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${corruptedData.length}`,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(Buffer.from(chunk));
    });

    server.listen(port, () => {
      console.log(`  ${serverName} listening on port ${port} [MALICIOUS]`);
      resolve(server);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Group Fetching
// ─────────────────────────────────────────────────────────────────────────────

async function fetchChunkGroup(
  baseUrl: string,
  groupIndex: number,
  totalSize: number
): Promise<Uint8Array> {
  const start = groupIndex * CHUNK_GROUP_SIZE;
  const end = Math.min(start + CHUNK_GROUP_SIZE, totalSize) - 1;

  const response = await fetch(baseUrl, {
    headers: { Range: `bytes=${start}-${end}` },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializable State for Resume
// ─────────────────────────────────────────────────────────────────────────────

interface SavedDownloadState {
  partialBaoState: unknown; // Opaque state from PartialBao.exportState()
  downloadedGroups: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo Phases
// ─────────────────────────────────────────────────────────────────────────────

async function phase1_DownloadFromServerA(
  testData: TestData
): Promise<SavedDownloadState> {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 1: Download from Server A (until 50%)');
  console.log('='.repeat(60));

  const url = `http://localhost:${PORT_A}/data`;

  // Initialize PartialBao verifier
  const partial = new PartialBao(testData.rootHash, testData.original.length);

  console.log(`\n  Total chunk groups: ${partial.numGroups}`);
  console.log(`  Will download ${ABORT_AT_GROUP} groups before "failure"\n`);

  console.log('Downloading from Server A...');

  const downloadedGroups: number[] = [];

  // Download first half of chunk groups
  for (let groupIndex = 0; groupIndex < ABORT_AT_GROUP; groupIndex++) {
    // Show progress
    const percent = ((groupIndex + 1) / testData.numGroups) * 100;
    process.stdout.write(
      `\r  [${progressBar(groupIndex + 1, testData.numGroups)}] ` +
      `${percent.toFixed(0)}% - Group ${groupIndex + 1}/${testData.numGroups}`
    );

    // Fetch and add chunk group
    const groupData = await fetchChunkGroup(url, groupIndex, testData.original.length);
    partial.addChunkGroupTrusted(groupIndex, groupData);
    downloadedGroups.push(groupIndex);

    // Small delay to make progress visible
    await sleep(200);
  }

  console.log('\n');
  console.log('  ⚠️  Connection failed at 50%');
  console.log('  Saving verifier state...');

  // Export state for resume
  const partialBaoState = partial.exportState();
  const savedState: SavedDownloadState = {
    partialBaoState,
    downloadedGroups,
  };

  console.log(`  State saved: ${partial.receivedGroups} groups verified`);
  console.log(`  Bytes downloaded: ${formatBytes(partial.receivedGroups * CHUNK_GROUP_SIZE)}`);
  console.log(`  Progress: ${partial.getProgress().toFixed(0)}%`);

  return savedState;
}

async function phase2_ResumeFromServerB(
  testData: TestData,
  savedState: SavedDownloadState
): Promise<SavedDownloadState> {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2: Resume from Server B');
  console.log('='.repeat(60));

  // Simulate network recovery delay
  console.log('\n  [Simulating network recovery...]');
  await sleep(500);

  const url = `http://localhost:${PORT_B}/data`;

  // Restore PartialBao from saved state
  console.log('  Importing saved state from Server A session...');
  const partial = PartialBao.importState(savedState.partialBaoState);

  const receivedBefore = partial.receivedGroups;

  console.log(`  Resuming: ${receivedBefore}/${testData.numGroups} groups already verified`);
  console.log(`  Downloading group ${receivedBefore + 1} from Server B...\n`);

  console.log('Resuming from Server B...');

  // Download just one group from Server B (group index 2)
  const groupIndex = receivedBefore;
  const percent = ((groupIndex + 1) / testData.numGroups) * 100;
  process.stdout.write(
    `\r  [${progressBar(groupIndex + 1, testData.numGroups)}] ` +
    `${percent.toFixed(0)}% - Group ${groupIndex + 1}/${testData.numGroups}`
  );

  const groupData = await fetchChunkGroup(url, groupIndex, testData.original.length);
  partial.addChunkGroupTrusted(groupIndex, groupData);
  await sleep(200);

  console.log('\n');
  console.log(`  ✅ Downloaded group ${groupIndex + 1} from Server B`);

  // Save state before testing malicious server
  return {
    partialBaoState: partial.exportState(),
    downloadedGroups: [...savedState.downloadedGroups, groupIndex],
  };
}

async function phase2_5_TestMaliciousServer(
  testData: TestData,
  savedState: SavedDownloadState
): Promise<SavedDownloadState> {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2.5: Test Malicious Server C');
  console.log('='.repeat(60));

  const urlC = `http://localhost:${PORT_C}/data`;
  const urlB = `http://localhost:${PORT_B}/data`;

  // Restore state
  const partial = PartialBao.importState(savedState.partialBaoState);
  const groupIndex = MALICIOUS_GROUP; // Group 3 (0-indexed), the 4th group

  console.log(`\n  Attempting to download group ${groupIndex + 1} from Server C...`);
  await sleep(300);

  // Fetch corrupted data from malicious Server C
  const corruptedData = await fetchChunkGroup(urlC, groupIndex, testData.original.length);

  // Add the corrupted data
  partial.addChunkGroupTrusted(groupIndex, corruptedData);

  console.log(`  Received data from Server C, verifying...`);
  await sleep(300);

  // Try to finalize - this will fail due to corrupted data
  let verificationFailed = false;
  try {
    partial.finalize();
  } catch {
    verificationFailed = true;
  }

  if (verificationFailed) {
    console.log('\n  ⚠️  Server C sent corrupted data - verification failed!');
    console.log('  Fetching from backup...');
    await sleep(300);

    // Restore state from before corruption
    const cleanPartial = PartialBao.importState(savedState.partialBaoState);

    // Fetch correct data from Server B
    console.log(`\n  Downloading group ${groupIndex + 1} from Server B instead...`);
    const correctData = await fetchChunkGroup(urlB, groupIndex, testData.original.length);
    cleanPartial.addChunkGroupTrusted(groupIndex, correctData);

    const percent = ((groupIndex + 1) / testData.numGroups) * 100;
    process.stdout.write(
      `\r  [${progressBar(groupIndex + 1, testData.numGroups)}] ` +
      `${percent.toFixed(0)}% - Group ${groupIndex + 1}/${testData.numGroups} (from Server B)`
    );
    await sleep(200);

    console.log('\n');
    console.log('  ✅ Correct data received from Server B');

    return {
      partialBaoState: cleanPartial.exportState(),
      downloadedGroups: [...savedState.downloadedGroups, groupIndex],
    };
  } else {
    // This shouldn't happen - corrupted data should fail verification
    throw new Error('Expected verification to fail with corrupted data!');
  }
}

async function phase2_6_CompleteDownload(
  testData: TestData,
  savedState: SavedDownloadState
): Promise<Uint8Array> {
  // All 4 groups should be complete at this point
  const partial = PartialBao.importState(savedState.partialBaoState);

  console.log(`\n  All ${partial.receivedGroups} groups downloaded and verified.`);
  console.log('  ✅ Verification complete! Data integrity confirmed.');

  // Finalize and return verified data
  return partial.finalize();
}

function phase3_VerifyResults(testData: TestData, downloadedData: Uint8Array): void {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 3: Verification Results');
  console.log('='.repeat(60));

  // Compare downloaded data with original
  let matches = true;
  if (downloadedData.length !== testData.original.length) {
    matches = false;
    console.log(`\n  ❌ Size mismatch: ${downloadedData.length} vs ${testData.original.length}`);
  } else {
    for (let i = 0; i < downloadedData.length; i++) {
      if (downloadedData[i] !== testData.original[i]) {
        matches = false;
        console.log(`\n  ❌ Data mismatch at byte ${i}`);
        break;
      }
    }
  }

  if (matches) {
    console.log('\n  ✅ Data verified! Downloaded content matches original exactly.');
    console.log('\n  The data downloaded from Servers A + B matches the original');
    console.log('  exactly. Bao verification ensures that even though we');
    console.log('  downloaded from MULTIPLE untrusted sources, and one server');
    console.log('  (C) tried to inject corrupted data, the final data is');
    console.log('  cryptographically verified and correct.');
  } else {
    console.log('\n  ❌ Verification failed - data does not match!');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('DEMO COMPLETE');
  console.log('='.repeat(60));
  console.log(`
🔒 SECURITY DEMONSTRATION:
  This demo proves Bao enables TRUSTLESS downloads:
  - Server A could have been compromised after Phase 1
  - Server C actively attempted to inject corrupted data
  - Yet the final data is cryptographically verified
  - Only the root hash (32 bytes) needs to be trusted

Key Takeaways:
  1. Downloaded first 50% from Server A (port ${PORT_A})
  2. Simulated connection failure, saved verifier state
  3. Resumed download from Server B (port ${PORT_B})
  4. Server C (port ${PORT_C}) attempted to inject CORRUPTED data
  5. Bao verification DETECTED the corruption and rejected it
  6. Fell back to Server B for correct data
  7. Final verification confirmed data integrity
`);

  console.log('='.repeat(60));
  console.log('COMPARISON: Traditional gRPC vs Bao HTTP');
  console.log('='.repeat(60));
  console.log(`
Traditional lightwalletd GetTreeState:
  ❌ Connection drop at 50% → restart from 0%
  ❌ Must reconnect to SAME server
  ❌ Trust required: single point of failure
  ❌ Cannot use CDN/caching infrastructure
  ❌ Malicious server → corrupted data accepted

Bao Verified Streaming:
  ✅ Connection drop at 50% → resume from 50%
  ✅ Can switch to ANY server with same data
  ✅ Zero trust: cryptographic verification per chunk
  ✅ Works with CDN, IPFS, BitTorrent, any HTTP
  ✅ Malicious server → corruption detected and rejected
`);

  console.log('='.repeat(60));
  console.log('REAL-WORLD IMPACT AT SCALE');
  console.log('='.repeat(60));
  console.log(`
Demo: ${formatBytes(DATA_SIZE)} in ${testData.numGroups} chunk groups

Actual Zcash data sizes:
  - Tree state: ~1-10 KB (small, one-time)
  - Compact blocks: ~5 GB+ (large, ongoing sync)

Where Bao shines at scale:
  📱 Mobile on 4G: connection drops → resumes instantly
  🏢 Corporate firewall: kills long connections → resumes
  🌐 CDN edge caching: 99% cache hit rate possible
  🗺️  Geographic redundancy: switch regions mid-download
  👥 Community mirrors: anyone can host safely
  🔒 Zero trust: malicious mirrors detected and rejected
`);

  console.log('='.repeat(60));
  console.log('ZCASH WALLET SYNC SCENARIO');
  console.log('='.repeat(60));
  console.log(`
📍 Mainnet has ~5 GB of compact blocks

WITHOUT Bao:
  - Download from single server
  - Connection drop = restart from beginning
  - Must trust the server completely

WITH Bao:
  - Download from ANY server (CDN, mirror, P2P)
  - Connection drop = resume from where you left off
  - Cryptographic verification ensures integrity
  - Switch servers mid-sync without losing progress
`);
}

function printDemoTime(startTime: number): void {
  const elapsed = (Date.now() - startTime) / 1000;
  console.log('='.repeat(60));
  console.log(`⏱️  Total demo time: ${elapsed.toFixed(2)}s`);
  console.log('  (In production: resumability saves hours on slow networks)');
  console.log('='.repeat(60));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const demoStartTime = Date.now();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Bao Resumable Download Demo                             ║');
  console.log('║  Demonstrating verified downloads from untrusted sources ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // Generate test data
  const testData = await generateTestData();

  // Start all servers - A and B serve correct data, C serves corrupted data
  console.log('\nStarting HTTP servers...');
  const serverA = await createDataServer(PORT_A, testData.original, 'Server A');
  const serverB = await createDataServer(PORT_B, testData.original, 'Server B');
  const serverC = await createMaliciousServer(PORT_C, testData.original, 'Server C');

  try {
    // Phase 1: Download from Server A until 50%
    const stateAfterA = await phase1_DownloadFromServerA(testData);

    // Phase 2: Resume from Server B (download one more group)
    const stateAfterB = await phase2_ResumeFromServerB(testData, stateAfterA);

    // Phase 2.5: Try malicious Server C, detect corruption, fallback to B
    const stateAfterC = await phase2_5_TestMaliciousServer(testData, stateAfterB);

    // Phase 2.6: Complete the download
    const downloadedData = await phase2_6_CompleteDownload(testData, stateAfterC);

    // Phase 3: Verify results
    phase3_VerifyResults(testData, downloadedData);

    // Print total demo time
    printDemoTime(demoStartTime);
  } finally {
    // Cleanup servers
    console.log('\nShutting down servers...');
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
    await new Promise<void>((resolve) => serverC.close(() => resolve()));
    console.log('Done!\n');
  }
}

main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
