#!/usr/bin/env node
/**
 * CLI for Zcash Bao Snapshots.
 *
 * Commands:
 * - generate: Generate a Bao-encoded snapshot from zcashd
 * - verify: Verify a snapshot file
 * - info: Display snapshot metadata
 * - serve: Serve snapshots via HTTP with range request support
 *
 * @packageDocumentation
 */

import { parseArgs } from 'node:util';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve, normalize, sep } from 'node:path';
import { ZcashRpcClient, SnapshotGenerator, SnapshotError } from './generator/index.js';
import { verifyBaoData, verifyBaoOutboard, BaoVerifierError } from './verifier/index.js';
import type { SnapshotMetadata, ZcashNetwork, SnapshotProgress } from './types/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Utilities
// ─────────────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;

const colors = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

function log(message: string): void {
  console.log(message);
}

function logError(message: string): void {
  console.error(`${colors.red}Error:${colors.reset} ${message}`);
}

function logSuccess(message: string): void {
  console.log(`${colors.green}${message}${colors.reset}`);
}

function logInfo(label: string, value: string): void {
  console.log(`${colors.cyan}${label}:${colors.reset} ${value}`);
}

function logWarning(message: string): void {
  console.log(`${colors.yellow}Warning:${colors.reset} ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Bar
// ─────────────────────────────────────────────────────────────────────────────

class ProgressBar {
  private width: number;
  private lastLine = '';

  constructor(width = 40) {
    this.width = width;
  }

  update(percent: number, message: string): void {
    if (!isTTY) {
      return;
    }

    const filled = Math.round((percent / 100) * this.width);
    const empty = this.width - filled;
    const bar = `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
    const line = `\r${bar} ${percent.toFixed(1).padStart(5)}% ${colors.dim}${message}${colors.reset}`;

    if (line !== this.lastLine) {
      process.stdout.write(line);
      this.lastLine = line;
    }
  }

  complete(message: string): void {
    if (isTTY) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
    logSuccess(message);
  }

  error(message: string): void {
    if (isTTY) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }
    logError(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Help Text
// ─────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `
${colors.bold}zcash-bao${colors.reset} - Bao-verified streaming of Zcash tree states

${colors.bold}USAGE${colors.reset}
  zcash-bao <command> [options]

${colors.bold}COMMANDS${colors.reset}
  generate    Generate a Bao-encoded snapshot from zcashd
  verify      Verify a snapshot file
  info        Display snapshot metadata
  serve       Serve snapshots via HTTP with range request support
  help        Show this help message

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Generate a snapshot at height 2000000${colors.reset}
  zcash-bao generate --height 2000000 --output ./snapshots

  ${colors.dim}# Generate with Iroh-compatible outboard mode${colors.reset}
  zcash-bao generate --height 2000000 --outboard --iroh

  ${colors.dim}# Verify a snapshot${colors.reset}
  zcash-bao verify --input snapshot.bao --meta metadata.json

  ${colors.dim}# Show snapshot info${colors.reset}
  zcash-bao info --meta metadata.json

  ${colors.dim}# Serve snapshots on port 8080${colors.reset}
  zcash-bao serve --dir ./snapshots --port 8080

${colors.bold}ENVIRONMENT VARIABLES${colors.reset}
  ZCASH_RPC_URL       RPC endpoint URL (default: http://127.0.0.1:8232)
  ZCASH_RPC_USER      RPC username
  ZCASH_RPC_PASSWORD  RPC password

Run ${colors.cyan}zcash-bao <command> --help${colors.reset} for command-specific help.
`;

const GENERATE_HELP = `
${colors.bold}zcash-bao generate${colors.reset} - Generate a Bao-encoded snapshot

${colors.bold}USAGE${colors.reset}
  zcash-bao generate --height <number> [options]

${colors.bold}OPTIONS${colors.reset}
  --height <number>     Block height for the snapshot (required)
  --output <dir>        Output directory (default: ./snapshots)
  --rpc-url <url>       zcashd RPC URL (default: ZCASH_RPC_URL or http://127.0.0.1:8232)
  --rpc-user <user>     RPC username (default: ZCASH_RPC_USER)
  --rpc-pass <pass>     RPC password (default: ZCASH_RPC_PASSWORD)
  --network <network>   Network: mainnet, testnet, regtest (default: mainnet)
  --outboard            Use outboard mode (separate hash tree)
  --iroh                Use Iroh-compatible 16KB chunk groups
  --description <text>  Optional description for the snapshot
  --help                Show this help message

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Basic generation${colors.reset}
  zcash-bao generate --height 2000000

  ${colors.dim}# With custom RPC settings${colors.reset}
  zcash-bao generate --height 2000000 --rpc-url http://localhost:8232 \\
    --rpc-user myuser --rpc-pass mypass

  ${colors.dim}# Outboard mode with Iroh compatibility${colors.reset}
  zcash-bao generate --height 2000000 --outboard --iroh

  ${colors.dim}# Custom output directory${colors.reset}
  zcash-bao generate --height 2000000 --output /path/to/snapshots
`;

const VERIFY_HELP = `
${colors.bold}zcash-bao verify${colors.reset} - Verify a Bao-encoded snapshot

${colors.bold}USAGE${colors.reset}
  zcash-bao verify --input <path> --meta <path> [options]

${colors.bold}OPTIONS${colors.reset}
  --input <path>    Path to the .bao file (required)
  --meta <path>     Path to metadata.json (required)
  --data <path>     Path to original data file (for outboard mode)
  --help            Show this help message

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Verify a combined mode snapshot${colors.reset}
  zcash-bao verify --input snapshot.bao --meta metadata.json

  ${colors.dim}# Verify an outboard mode snapshot${colors.reset}
  zcash-bao verify --input snapshot.bao --meta metadata.json --data snapshot.data
`;

const INFO_HELP = `
${colors.bold}zcash-bao info${colors.reset} - Display snapshot metadata

${colors.bold}USAGE${colors.reset}
  zcash-bao info --meta <path>

${colors.bold}OPTIONS${colors.reset}
  --meta <path>     Path to metadata.json (required)
  --json            Output as JSON
  --help            Show this help message

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Show human-readable info${colors.reset}
  zcash-bao info --meta metadata.json

  ${colors.dim}# Output as JSON${colors.reset}
  zcash-bao info --meta metadata.json --json
`;

const SERVE_HELP = `
${colors.bold}zcash-bao serve${colors.reset} - Serve snapshots via HTTP

${colors.bold}USAGE${colors.reset}
  zcash-bao serve --dir <path> [options]

${colors.bold}OPTIONS${colors.reset}
  --dir <path>      Directory containing snapshots (required)
  --port <number>   HTTP port (default: 3000)
  --host <host>     Host to bind to (default: 0.0.0.0)
  --no-cors         Disable CORS headers (enabled by default)
  --help            Show this help message

${colors.bold}FEATURES${colors.reset}
  - Auto-discovers all snapshots from .metadata.json files
  - Clean index page with snapshot details at /
  - HTTP Range request support for partial downloads
  - CORS enabled by default for browser access
  - Proper Content-Type headers for .bao, .json, .data files

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Serve on default port 3000${colors.reset}
  zcash-bao serve --dir ./snapshots

  ${colors.dim}# Custom port${colors.reset}
  zcash-bao serve --dir ./snapshots --port 8080
`;

// ─────────────────────────────────────────────────────────────────────────────
// Generate Command
// ─────────────────────────────────────────────────────────────────────────────

interface GenerateOptions {
  height: number;
  output: string;
  rpcHost: string;
  rpcPort: number;
  rpcHttps: boolean;
  rpcUser: string;
  rpcPass: string;
  network: ZcashNetwork;
  outboard: boolean;
  iroh: boolean;
  description?: string;
}

/**
 * Parse a URL into host, port, and https flag.
 */
function parseRpcUrl(urlStr: string): { host: string; port: number; https: boolean } {
  try {
    const url = new URL(urlStr);
    const https = url.protocol === 'https:';
    const defaultPort = https ? 443 : 8232;
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : defaultPort,
      https,
    };
  } catch {
    // If not a valid URL, assume it's just a host:port
    const parts = urlStr.split(':');
    return {
      host: parts[0] ?? '127.0.0.1',
      port: parts[1] ? parseInt(parts[1], 10) : 8232,
      https: false,
    };
  }
}

async function runGenerate(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      height: { type: 'string' },
      output: { type: 'string', default: './snapshots' },
      'rpc-url': { type: 'string' },
      'rpc-user': { type: 'string' },
      'rpc-pass': { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      outboard: { type: 'boolean', default: false },
      iroh: { type: 'boolean', default: false },
      description: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    log(GENERATE_HELP);
    return 0;
  }

  if (!values.height) {
    logError('--height is required');
    log(GENERATE_HELP);
    return 1;
  }

  const height = parseInt(values.height, 10);
  if (isNaN(height) || height < 0) {
    logError('--height must be a non-negative integer');
    return 1;
  }

  if (height > Number.MAX_SAFE_INTEGER) {
    logError('--height exceeds maximum safe integer value');
    return 1;
  }

  // Warn for suspiciously high heights (Zcash mainnet is ~2.5M blocks as of 2024)
  const MAX_REASONABLE_HEIGHT = 10_000_000;
  if (height > MAX_REASONABLE_HEIGHT) {
    logWarning(`Height ${height.toLocaleString()} seems unusually high. Current Zcash mainnet is ~3M blocks.`);
  }

  const network = values.network as ZcashNetwork;
  if (!['mainnet', 'testnet', 'regtest'].includes(network)) {
    logError('--network must be mainnet, testnet, or regtest');
    return 1;
  }

  // Determine RPC settings
  const defaultPort = network === 'mainnet' ? 8232 : network === 'testnet' ? 18232 : 18443;
  const rpcUrlStr = values['rpc-url'] ?? process.env['ZCASH_RPC_URL'] ?? `http://127.0.0.1:${defaultPort}`;
  const rpcUser = values['rpc-user'] ?? process.env['ZCASH_RPC_USER'];
  const rpcPass = values['rpc-pass'] ?? process.env['ZCASH_RPC_PASSWORD'];

  if (!rpcUser || !rpcPass) {
    logError('RPC credentials are required');
    logInfo('Hint', 'Set --rpc-user and --rpc-pass, or ZCASH_RPC_USER and ZCASH_RPC_PASSWORD env vars');
    return 1;
  }

  const { host: rpcHost, port: rpcPort, https: rpcHttps } = parseRpcUrl(rpcUrlStr);

  const options: GenerateOptions = {
    height,
    output: values.output ?? './snapshots',
    rpcHost,
    rpcPort,
    rpcHttps,
    rpcUser,
    rpcPass,
    network,
    outboard: values.outboard ?? false,
    iroh: values.iroh ?? false,
  };

  if (values.description !== undefined) {
    (options as { description?: string }).description = values.description;
  }

  log(`${colors.bold}Generating snapshot at height ${height}${colors.reset}`);
  logInfo('Network', network);
  logInfo('RPC', `${rpcHttps ? 'https' : 'http'}://${rpcHost}:${rpcPort}`);
  logInfo('Output', options.output);
  logInfo('Mode', options.outboard ? 'outboard' : 'combined');
  if (options.iroh) {
    logInfo('Iroh Compatible', 'yes');
  }
  log('');

  const progress = new ProgressBar();

  try {
    // Create RPC client
    const client = new ZcashRpcClient({
      host: options.rpcHost,
      port: options.rpcPort,
      https: options.rpcHttps,
      username: options.rpcUser,
      password: options.rpcPass,
    });

    // Wait for node to be ready
    progress.update(0, 'Connecting to zcashd...');
    try {
      await client.waitForReady(30000, 1000);
    } catch {
      progress.error('Could not connect to zcashd');
      logInfo('Hint', 'Make sure zcashd is running and RPC credentials are correct');
      return 1;
    }

    // Create generator
    const generator = new SnapshotGenerator(client);

    // Build snapshot options, only including description if provided
    const snapshotOpts: import('./types/index.js').SnapshotOptions = {
      height: options.height,
      outputDir: options.output,
      network: options.network,
      mode: options.outboard ? 'outboard' : 'combined',
      irohCompatible: options.iroh,
      onProgress: (p: SnapshotProgress) => {
        const phaseMap: Record<string, string> = {
          fetching: 'Fetching tree state...',
          serializing: 'Serializing data...',
          encoding: 'Bao encoding...',
          writing: 'Writing files...',
          complete: 'Complete',
        };
        progress.update(p.percent ?? 0, phaseMap[p.phase] ?? p.phase);
      },
    };

    if (options.description !== undefined) {
      Object.assign(snapshotOpts, { description: options.description });
    }

    // Generate snapshot
    const result = await generator.createSnapshot(snapshotOpts);

    progress.complete(`Snapshot generated successfully!`);
    log('');
    logInfo('Block Hash', result.metadata.hash);
    logInfo('Root Hash', result.metadata.rootHash);
    logInfo('Original Size', formatBytes(result.metadata.originalSize));
    logInfo('Encoded Size', formatBytes(result.metadata.encodedSize));

    // List output files
    const outputFiles = [result.baoPath, result.metadataPath];
    if (result.dataPath) {
      outputFiles.push(result.dataPath);
    }
    logInfo('Output Files', outputFiles.join(', '));

    return 0;
  } catch (error) {
    progress.error('Snapshot generation failed');

    if (error instanceof SnapshotError) {
      logError(error.message);
      if (error.cause instanceof Error) {
        logInfo('Cause', error.cause.message);
      }
    } else if (error instanceof Error) {
      logError(error.message);
    } else {
      logError(String(error));
    }

    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify Command
// ─────────────────────────────────────────────────────────────────────────────

async function runVerify(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: 'string' },
      meta: { type: 'string' },
      data: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    log(VERIFY_HELP);
    return 0;
  }

  if (!values.input || !values.meta) {
    logError('--input and --meta are required');
    log(VERIFY_HELP);
    return 1;
  }

  const progress = new ProgressBar();

  try {
    // Read metadata
    progress.update(0, 'Reading metadata...');
    const metadataContent = await readFile(values.meta, 'utf-8');
    const metadata = JSON.parse(metadataContent) as SnapshotMetadata;

    // Validate metadata
    if (!metadata.rootHash || metadata.rootHash.length !== 64) {
      throw new BaoVerifierError('Invalid root hash in metadata', 'INVALID_ROOT_HASH');
    }

    const isOutboard = metadata.outboard ?? false;

    if (isOutboard && !values.data) {
      logError('--data is required for outboard mode snapshots');
      logInfo('Hint', 'The metadata indicates this is an outboard snapshot');
      return 1;
    }

    log(`${colors.bold}Verifying snapshot${colors.reset}`);
    logInfo('Type', metadata.type);
    logInfo('Network', metadata.network);
    logInfo('Height', String(metadata.height));
    logInfo('Mode', isOutboard ? 'outboard' : 'combined');
    logInfo('Expected Hash', metadata.rootHash);
    log('');

    // Read files
    progress.update(20, 'Reading files...');
    const baoData = await readFile(values.input);

    let verifiedData: Uint8Array;

    if (isOutboard && values.data) {
      // Outboard mode: bao file is the outboard, data file is the original
      const originalData = await readFile(values.data);
      progress.update(50, 'Verifying with outboard...');
      verifiedData = await verifyBaoOutboard(
        new Uint8Array(originalData),
        new Uint8Array(baoData),
        metadata.rootHash
      );
    } else {
      // Combined mode
      progress.update(50, 'Verifying combined data...');
      verifiedData = await verifyBaoData(new Uint8Array(baoData), metadata.rootHash);
    }

    progress.complete('Verification successful!');
    log('');
    logInfo('Verified Size', formatBytes(verifiedData.length));
    logInfo('Expected Size', formatBytes(metadata.originalSize));

    if (verifiedData.length !== metadata.originalSize) {
      logWarning('Size mismatch - file may be truncated or corrupted');
      return 1;
    }

    logSuccess('All checks passed - snapshot is valid');
    return 0;
  } catch (error) {
    progress.error('Verification failed');

    if (error instanceof BaoVerifierError) {
      logError(error.message);
      logInfo('Error Code', error.code);
    } else if (error instanceof Error) {
      logError(error.message);
    } else {
      logError(String(error));
    }

    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Info Command
// ─────────────────────────────────────────────────────────────────────────────

async function runInfo(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      meta: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    log(INFO_HELP);
    return 0;
  }

  if (!values.meta) {
    logError('--meta is required');
    log(INFO_HELP);
    return 1;
  }

  try {
    const metadataContent = await readFile(values.meta, 'utf-8');
    const metadata = JSON.parse(metadataContent) as SnapshotMetadata;

    if (values.json) {
      console.log(JSON.stringify(metadata, null, 2));
      return 0;
    }

    log(`${colors.bold}Snapshot Metadata${colors.reset}`);
    log('');
    logInfo('Version', String(metadata.version));
    logInfo('Type', metadata.type);
    logInfo('Network', metadata.network);
    logInfo('Height', String(metadata.height));
    logInfo('Block Hash', metadata.hash);
    log('');
    logInfo('Root Hash', metadata.rootHash);
    logInfo('Original Size', formatBytes(metadata.originalSize));
    logInfo('Encoded Size', formatBytes(metadata.encodedSize));
    logInfo('Mode', metadata.outboard ? 'outboard' : 'combined');
    if (metadata.irohCompatible) {
      logInfo('Iroh Compatible', 'yes');
    }
    log('');
    logInfo('Created', metadata.createdAt);
    if (metadata.description) {
      logInfo('Description', metadata.description);
    }

    return 0;
  } catch (error) {
    if (error instanceof Error) {
      logError(error.message);
    } else {
      logError(String(error));
    }
    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serve Command
// ─────────────────────────────────────────────────────────────────────────────

interface ServeOptions {
  dir: string;
  port: number;
  host: string;
  cors: boolean;
  startTime: number;
}

async function runServe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      port: { type: 'string', default: '3000' },
      host: { type: 'string', default: '0.0.0.0' },
      'no-cors': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    log(SERVE_HELP);
    return 0;
  }

  if (!values.dir) {
    logError('--dir is required');
    log(SERVE_HELP);
    return 1;
  }

  const port = parseInt(values.port ?? '3000', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    logError('--port must be a valid port number (1-65535)');
    return 1;
  }

  const options: ServeOptions = {
    dir: values.dir,
    port,
    host: values.host ?? '0.0.0.0',
    cors: !values['no-cors'],
    startTime: Date.now(),
  };

  // Verify directory exists
  try {
    const dirStat = await stat(options.dir);
    if (!dirStat.isDirectory()) {
      logError(`${options.dir} is not a directory`);
      return 1;
    }
  } catch {
    logError(`Directory not found: ${options.dir}`);
    return 1;
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, options).catch((error: unknown) => {
      console.error('Request error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, options.host, () => {
      log(`${colors.bold}Serving snapshots${colors.reset}`);
      logInfo('Directory', options.dir);
      logInfo('URL', `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`);
      logInfo('CORS', options.cors ? 'enabled' : 'disabled');
      log('');
      log(`${colors.dim}Press Ctrl+C to stop${colors.reset}`);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logError(`Port ${port} is already in use`);
      } else {
        logError(error.message);
      }
      resolve(1);
    });

    process.on('SIGINT', () => {
      log('\nShutting down...');
      server.close(() => {
        resolve(0);
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeOptions
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Set CORS headers if enabled
  if (options.cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  }

  // Handle OPTIONS for CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only allow GET and HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Health check endpoint
  const decodedPath = decodeURIComponent(url.pathname);
  if (decodedPath === '/health') {
    const snapshots = await discoverSnapshots(options.dir);
    const uptimeMs = Date.now() - options.startTime;
    const health = {
      status: 'healthy',
      uptime: Math.floor(uptimeMs / 1000),
      uptimeFormatted: formatUptime(uptimeMs),
      snapshotCount: snapshots.length,
    };
    const body = JSON.stringify(health, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return;
  }

  // Secure path validation to prevent directory traversal
  // 1. Normalize the serve directory to absolute path
  const baseDir = resolve(normalize(options.dir));

  // 2. Normalize the requested path (decodedPath already set above)
  const normalizedPath = normalize(decodedPath);

  // 3. Resolve the full path
  const filePath = resolve(baseDir, '.' + normalizedPath);

  // 4. Verify the resolved path is within the serve directory
  // Ensure baseDir ends with separator for accurate prefix matching
  const baseDirWithSep = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (filePath !== baseDir && !filePath.startsWith(baseDirWithSep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      // Serve index page at root, directory listing elsewhere
      if (decodedPath === '/') {
        await serveIndexPage(res, options.dir);
      } else {
        await serveDirectoryListing(res, filePath, decodedPath);
      }
      return;
    }

    // Serve file with range support
    await serveFile(req, res, filePath, fileStat.size);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      throw error;
    }
  }
}

interface SnapshotInfo {
  baseName: string;
  metadata: SnapshotMetadata;
  baoSize: number;
  dataSize?: number;
  metadataSize: number;
}

async function discoverSnapshots(dirPath: string): Promise<SnapshotInfo[]> {
  const files = await readdir(dirPath);
  const metadataFiles = files.filter((f) => f.endsWith('.metadata.json'));

  const snapshots: SnapshotInfo[] = [];

  for (const metaFile of metadataFiles) {
    try {
      const metaPath = join(dirPath, metaFile);
      const content = await readFile(metaPath, 'utf-8');
      const metadata = JSON.parse(content) as SnapshotMetadata;

      const baseName = metaFile.replace('.metadata.json', '');
      const baoPath = join(dirPath, `${baseName}.bao`);

      let baoSize = 0;
      let dataSize: number | undefined;

      try {
        const baoStat = await stat(baoPath);
        baoSize = baoStat.size;
      } catch {
        // BAO file might not exist
      }

      if (metadata.outboard) {
        const dataPath = join(dirPath, `${baseName}.data`);
        try {
          const dataStat = await stat(dataPath);
          dataSize = dataStat.size;
        } catch {
          // Data file might not exist
        }
      }

      const metaStat = await stat(metaPath);

      const info: SnapshotInfo = {
        baseName,
        metadata,
        baoSize,
        metadataSize: metaStat.size,
      };
      if (dataSize !== undefined) {
        info.dataSize = dataSize;
      }
      snapshots.push(info);
    } catch {
      // Skip invalid metadata files
    }
  }

  // Sort by height descending
  snapshots.sort((a, b) => b.metadata.height - a.metadata.height);

  return snapshots;
}

async function serveIndexPage(res: ServerResponse, dirPath: string): Promise<void> {
  const snapshots = await discoverSnapshots(dirPath);

  const rows = snapshots
    .map((s) => {
      const mode = s.metadata.outboard ? 'outboard' : 'combined';
      const iroh = s.metadata.irohCompatible ? ' (Iroh)' : '';
      const totalSize = s.baoSize + (s.dataSize ?? 0);
      const createdDate = new Date(s.metadata.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });

      const files = s.metadata.outboard
        ? `<a href="/${s.baseName}.bao">.bao</a> | <a href="/${s.baseName}.data">.data</a>`
        : `<a href="/${s.baseName}.bao">.bao</a>`;

      return `
      <tr>
        <td class="height">${s.metadata.height.toLocaleString()}</td>
        <td class="network">${s.metadata.network}</td>
        <td class="mode">${mode}${iroh}</td>
        <td class="size">${formatBytes(s.metadata.originalSize)}</td>
        <td class="encoded">${formatBytes(totalSize)}</td>
        <td class="date">${createdDate}</td>
        <td class="files">
          ${files} | <a href="/${s.baseName}.metadata.json">.json</a>
        </td>
      </tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zcash Bao Snapshots</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f23;
      color: #ccc;
      padding: 2rem;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #333;
    }
    h1 {
      color: #f5a623;
      font-size: 1.75rem;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: #666; font-size: 0.9rem; }
    .stats {
      display: flex;
      gap: 2rem;
      margin: 1.5rem 0;
      flex-wrap: wrap;
    }
    .stat {
      background: #1a1a2e;
      padding: 1rem 1.5rem;
      border-radius: 8px;
      border: 1px solid #333;
    }
    .stat-value { font-size: 1.5rem; color: #f5a623; font-weight: bold; }
    .stat-label { font-size: 0.8rem; color: #666; text-transform: uppercase; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      padding: 0.75rem 1rem;
      background: #1a1a2e;
      color: #888;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.5px;
      border-bottom: 2px solid #333;
    }
    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #222;
    }
    tr:hover { background: #1a1a2e; }
    .height { font-family: monospace; font-weight: bold; color: #fff; }
    .network { text-transform: capitalize; }
    .mode { color: #888; }
    .size, .encoded { font-family: monospace; text-align: right; }
    .date { color: #666; }
    .files { font-family: monospace; }
    a { color: #4da6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty {
      text-align: center;
      padding: 3rem;
      color: #666;
    }
    footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #333;
      color: #444;
      font-size: 0.8rem;
    }
    code { background: #1a1a2e; padding: 0.2rem 0.4rem; border-radius: 4px; }
    @media (max-width: 768px) {
      body { padding: 1rem; }
      .stats { gap: 1rem; }
      table { font-size: 0.8rem; }
      th, td { padding: 0.5rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Zcash Bao Snapshots</h1>
      <p class="subtitle">Bao-verified streaming of Zcash tree states</p>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${snapshots.length}</div>
        <div class="stat-label">Snapshots</div>
      </div>
      ${
        snapshots.length > 0
          ? `
      <div class="stat">
        <div class="stat-value">${snapshots[0]?.metadata.height.toLocaleString() ?? 0}</div>
        <div class="stat-label">Latest Height</div>
      </div>
      <div class="stat">
        <div class="stat-value">${formatBytes(snapshots.reduce((sum, s) => sum + s.baoSize + (s.dataSize ?? 0), 0))}</div>
        <div class="stat-label">Total Size</div>
      </div>
      `
          : ''
      }
    </div>

    ${
      snapshots.length > 0
        ? `
    <table>
      <thead>
        <tr>
          <th>Height</th>
          <th>Network</th>
          <th>Mode</th>
          <th>Original</th>
          <th>Encoded</th>
          <th>Created</th>
          <th>Files</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    `
        : `
    <div class="empty">
      <p>No snapshots found.</p>
      <p style="margin-top: 1rem;">Generate snapshots with: <code>zcash-bao generate --height &lt;number&gt;</code></p>
    </div>
    `
    }

    <footer>
      <p>Powered by <a href="https://github.com/lamb356/zcash-bao-snapshots">zcash-bao-snapshots</a></p>
    </footer>
  </div>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

async function serveDirectoryListing(
  res: ServerResponse,
  dirPath: string,
  urlPath: string
): Promise<void> {
  const files = await readdir(dirPath, { withFileTypes: true });

  const items = files
    .filter((f) => !f.name.startsWith('.'))
    .map((f) => {
      const name = f.isDirectory() ? `${f.name}/` : f.name;
      const href = `${urlPath.replace(/\/$/, '')}/${f.name}`;
      return `  <li><a href="${href}">${name}</a></li>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Index of ${urlPath}</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #0f0f23; color: #ccc; }
    h1 { color: #f5a623; }
    ul { list-style: none; padding: 0; }
    li { margin: 5px 0; }
    a { color: #4da6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Index of ${urlPath}</h1>
  <ul>
${urlPath !== '/' ? '    <li><a href="../">..</a></li>\n' : ''}${items}
  </ul>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  fileSize: number
): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const contentType = getContentType(ext);

  // Always indicate range support
  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  };

  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    // Parse range header
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end('Range Not Satisfiable');
      return;
    }

    const start = parseInt(match[1] ?? '0', 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      res.end('Range Not Satisfiable');
      return;
    }

    headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
    headers['Content-Length'] = end - start + 1;

    res.writeHead(206, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(filePath, { start, end });
    stream.pipe(res);
  } else {
    // Full file
    headers['Content-Length'] = fileSize;

    res.writeHead(200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.pipe(res);
  }
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    '.bao': 'application/octet-stream',
    '.data': 'application/octet-stream',
    '.json': 'application/json',
    '.html': 'text/html',
    '.txt': 'text/plain',
  };
  return types[ext] ?? 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);

  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    log(HELP_TEXT);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    log('zcash-bao v0.1.0');
    return 0;
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case 'generate':
      return runGenerate(commandArgs);

    case 'verify':
      return runVerify(commandArgs);

    case 'info':
      return runInfo(commandArgs);

    case 'serve':
      return runServe(commandArgs);

    default:
      logError(`Unknown command: ${command}`);
      log(HELP_TEXT);
      return 1;
  }
}

// Run the CLI
main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
