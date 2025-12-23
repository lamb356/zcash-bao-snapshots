# Zcash Bao Snapshots

[![CI](https://github.com/lamb356/zcash-bao-snapshots/actions/workflows/ci.yml/badge.svg)](https://github.com/lamb356/zcash-bao-snapshots/actions/workflows/ci.yml)

Bao-verified streaming of Zcash tree states for faster wallet recovery.

This library enables light wallets to securely download and verify Zcash commitment tree snapshots using [Bao](https://github.com/oconnor663/bao) verified streaming. Instead of syncing from genesis, wallets can start from a verified snapshot and only sync recent blocks.

## Features

- **Verified Streaming**: Download snapshots with chunk-by-chunk cryptographic verification using BLAKE3 Bao
- **Resumable Downloads**: Pause and resume downloads without re-downloading verified chunks
- **Browser Compatible**: Verifier works in browsers and Node.js
- **Iroh Compatible**: Optional 16KB chunk groups for 16x smaller outboard files
- **HTTP Range Requests**: Efficient partial downloads with standard HTTP infrastructure
- **TypeScript**: Full type definitions with strict mode support

Built on [blake3-bao](https://github.com/lamb356/blake3-optimized) - a pure JavaScript BLAKE3 and Bao implementation with WASM SIMD acceleration (~1500 MB/s hashing, ~185 MB/s Bao streaming).

## Installation

```bash
npm install zcash-bao-snapshots
```

## CLI Usage

### Generate a Snapshot

Connect to a running zcashd node and generate a Bao-encoded snapshot:

```bash
# Basic usage
zcash-bao generate --height 2000000 --rpc-user myuser --rpc-pass mypass

# With environment variables
export ZCASH_RPC_USER=myuser
export ZCASH_RPC_PASSWORD=mypass
zcash-bao generate --height 2000000

# Outboard mode with Iroh compatibility (16x smaller hash tree)
zcash-bao generate --height 2000000 --outboard --iroh

# Custom output directory and network
zcash-bao generate --height 2000000 --output ./my-snapshots --network testnet
```

**Options:**
- `--height <number>` - Block height for the snapshot (required)
- `--output <dir>` - Output directory (default: ./snapshots)
- `--rpc-url <url>` - zcashd RPC URL (default: http://127.0.0.1:8232)
- `--rpc-user <user>` - RPC username
- `--rpc-pass <pass>` - RPC password
- `--network <network>` - mainnet, testnet, or regtest (default: mainnet)
- `--outboard` - Use outboard mode (separate hash tree file)
- `--iroh` - Use Iroh-compatible 16KB chunk groups
- `--description <text>` - Optional description

### Verify a Snapshot

```bash
# Combined mode snapshot
zcash-bao verify --input snapshot.bao --meta metadata.json

# Outboard mode snapshot
zcash-bao verify --input snapshot.bao --meta metadata.json --data snapshot.data
```

### Show Snapshot Info

```bash
# Human-readable output
zcash-bao info --meta metadata.json

# JSON output
zcash-bao info --meta metadata.json --json
```

### Serve Snapshots

Serve snapshots over HTTP with range request support for efficient partial downloads:

```bash
# Basic server on port 3000
zcash-bao serve --dir ./snapshots

# Custom port with CORS enabled (for browser clients)
zcash-bao serve --dir ./snapshots --port 8080 --cors
```

## Library API

### Generator (Node.js)

```typescript
import { ZcashRpcClient, SnapshotGenerator } from 'zcash-bao-snapshots';

// Create RPC client
const client = new ZcashRpcClient({
  host: '127.0.0.1',
  port: 8232,
  username: 'myuser',
  password: 'mypass',
});

// Wait for node to be ready
await client.waitForReady();

// Create generator
const generator = new SnapshotGenerator(client);

// Generate a snapshot
const result = await generator.createSnapshot({
  height: 2000000,
  outputDir: './snapshots',
  network: 'mainnet',
  mode: 'outboard',        // or 'combined'
  irohCompatible: true,    // 16KB chunk groups
  description: 'Mainnet snapshot at 2M',
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.percent}%`);
  },
});

console.log('Snapshot created:', result.metadata.rootHash);
console.log('Files:', result.baoPath, result.metadataPath);
```

### Verifier (Browser & Node.js)

#### Simple One-Shot Verification

```typescript
import { verifyBao } from 'zcash-bao-snapshots/verifier';

const data = await verifyBao({
  url: 'https://example.com/snapshot.bao',
  rootHash: 'abcd1234...',  // 64-char hex string
  contentLength: 1000000,
  onProgress: (p) => console.log(`${p.percent.toFixed(1)}%`),
});

console.log('Verified data:', data.length, 'bytes');
```

#### Full Control with BaoVerifier

```typescript
import { BaoVerifier, createStorageAdapter } from 'zcash-bao-snapshots/verifier';

const verifier = new BaoVerifier({
  url: 'https://example.com/snapshot.bao',
  rootHash: 'abcd1234...',
  contentLength: 1000000,
  concurrency: 4,           // parallel chunk fetches
  storage: createStorageAdapter(),  // auto-detect best storage
});

// Event listeners
verifier.on('progress', (p) => {
  console.log(`${p.percent}% - ${p.speed} bytes/sec - ETA: ${p.eta}s`);
});

verifier.on('chunk-verified', (info) => {
  console.log(`Chunk ${info.chunkIndex} verified`);
});

verifier.on('complete', ({ data, elapsedMs, averageSpeed }) => {
  console.log(`Complete! ${data.length} bytes in ${elapsedMs}ms`);
});

verifier.on('error', (error) => {
  console.error('Verification failed:', error.message);
});

// Start download
const data = await verifier.start();

// Or pause/resume
await verifier.pause();
const state = verifier.exportState();
localStorage.setItem('download-state', JSON.stringify(state));

// Later...
verifier.importState(JSON.parse(localStorage.getItem('download-state')));
const data = await verifier.resume();
```

#### Verify Local Data

```typescript
import { verifyBaoData, verifyBaoOutboard } from 'zcash-bao-snapshots/verifier';

// Combined mode (data + tree interleaved)
const verified = await verifyBaoData(encodedData, rootHash);

// Outboard mode (separate tree)
const verified = await verifyBaoOutboard(originalData, outboardTree, rootHash);
```

#### Fetch and Verify from Metadata

```typescript
import { fetchAndVerifySnapshot } from 'zcash-bao-snapshots/verifier';

const { data, metadata } = await fetchAndVerifySnapshot(
  'https://example.com/snapshots/2000000',  // base URL without extension
  {
    onProgress: (p) => console.log(`${p.percent}%`),
    concurrency: 4,
  }
);

console.log('Network:', metadata.network);
console.log('Height:', metadata.height);
console.log('Data size:', data.length);
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ZCASH_RPC_URL` | Full RPC URL | `http://127.0.0.1:8232` |
| `ZCASH_RPC_HOST` | RPC host | `127.0.0.1` |
| `ZCASH_RPC_PORT` | RPC port | `8232` (mainnet) |
| `ZCASH_RPC_USER` | RPC username | (required) |
| `ZCASH_RPC_PASSWORD` | RPC password | (required) |

### RPC Client Options

```typescript
interface RpcClientConfig {
  host?: string;           // default: '127.0.0.1'
  port?: number;           // default: 8232
  username: string;        // required
  password: string;        // required
  timeout?: number;        // default: 30000ms
  maxRetries?: number;     // default: 3
  retryDelay?: number;     // default: 1000ms
  maxRetryDelay?: number;  // default: 30000ms
  https?: boolean;         // default: false
  logger?: Logger;         // optional logging
}
```

### Verifier Options

```typescript
interface BaoVerifierConfig {
  url: string;              // URL to fetch from
  rootHash: string;         // expected BLAKE3 Bao root hash (hex)
  contentLength: number;    // total content size
  outboardUrl?: string;     // URL for outboard tree (if separate)
  concurrency?: number;     // parallel fetches (default: 4)
  chunkSize?: number;       // bytes per chunk (default: 1024)
  requestTimeout?: number;  // HTTP timeout (default: 30000ms)
  maxRetries?: number;      // retries per chunk (default: 3)
  storage?: StorageAdapter; // for pause/resume state
  fetch?: typeof fetch;     // custom fetch implementation
}
```

## Output Files

When generating a snapshot, the following files are created:

**Combined Mode:**
- `{height}.bao` - Bao-encoded data (content + hash tree interleaved)
- `{height}.metadata.json` - Snapshot metadata

**Outboard Mode:**
- `{height}.bao` - Bao outboard hash tree only
- `{height}.data` - Original unencoded data
- `{height}.metadata.json` - Snapshot metadata

### Metadata Format

```json
{
  "version": 1,
  "type": "tree-state",
  "network": "mainnet",
  "height": 2000000,
  "hash": "0000000000abc123...",
  "rootHash": "def456...",
  "originalSize": 12345,
  "encodedSize": 14000,
  "outboard": false,
  "irohCompatible": false,
  "createdAt": "2024-01-15T12:00:00.000Z",
  "saplingRoot": "abc123...",
  "orchardRoot": "def456..."
}
```

## Browser Usage

The verifier module is browser-compatible. For bundlers like webpack or vite:

```typescript
import { BaoVerifier, verifyBao } from 'zcash-bao-snapshots/verifier';
```

Or use the pre-built browser bundle from blake3-bao:

```html
<script src="https://unpkg.com/blake3-bao/dist/blake3-bao.min.js"></script>
<script type="module">
  import { verifyBao } from 'zcash-bao-snapshots/verifier';

  const data = await verifyBao({
    url: '/snapshots/2000000.bao',
    rootHash: '...',
    contentLength: 12345,
  });
</script>
```

## Error Handling

All errors extend standard Error with additional context:

```typescript
import { BaoVerifierError, SnapshotError, RpcError } from 'zcash-bao-snapshots';

try {
  await verifier.start();
} catch (error) {
  if (error instanceof BaoVerifierError) {
    console.error('Code:', error.code);  // e.g., 'VERIFICATION_FAILED'
    console.error('Chunk:', error.chunkIndex);
    console.error('Recoverable:', error.recoverable);
  }
}
```

**Error Codes:**
- `FETCH_FAILED` - HTTP request failed
- `VERIFICATION_FAILED` - Hash mismatch
- `INVALID_ROOT_HASH` - Invalid root hash format
- `INVALID_STATE` - Invalid verifier state
- `STORAGE_ERROR` - State persistence failed
- `ABORTED` - Download was aborted
- `TIMEOUT` - Request timed out
- `NETWORK_ERROR` - Network unavailable

## Related Projects

- [blake3-bao](https://github.com/lamb356/blake3-optimized) - BLAKE3 and Bao implementation this library uses
- [Zcash](https://z.cash/) - The privacy-focused cryptocurrency
- [Bao](https://github.com/oconnor663/bao) - BLAKE3 verified streaming specification
- [Iroh](https://iroh.computer/) - Content-addressed data distribution

## License

MIT
