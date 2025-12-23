/**
 * Verification library for Zcash Bao Snapshots.
 *
 * This module provides browser and Node.js compatible verification
 * of Bao-encoded Zcash snapshots using the blake3-bao library.
 *
 * @packageDocumentation
 */

import { baoDecode } from 'blake3-bao';
import { BaoVerifier } from './bao-verifier.js';
import type { VerifyBaoOptions, VerificationProgress } from './types.js';
import { BaoVerifierError } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export { BaoVerifier } from './bao-verifier.js';

export {
  MemoryStorageAdapter,
  LocalStorageAdapter,
  IndexedDBStorageAdapter,
  createStorageAdapter,
} from './storage.js';

export type {
  BaoVerifierConfig,
  BaoVerifierEvents,
  BaoVerifierEventListener,
  VerificationProgress,
  ChunkVerifiedInfo,
  VerifierState,
  VerifierStatus,
  StorageAdapter,
  BaoVerifierErrorCode,
  VerifyBaoOptions,
} from './types.js';

export { BaoVerifierError, VERIFIER_STATE_VERSION } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple one-shot Bao verification.
 *
 * This is a convenience function for verifying a Bao-encoded file without
 * needing to manage the BaoVerifier class directly. It does not support
 * pause/resume.
 *
 * @example
 * ```typescript
 * const data = await verifyBao({
 *   url: 'https://example.com/snapshot.bao',
 *   rootHash: 'abcd1234...',
 *   contentLength: 1000000,
 *   onProgress: (p) => console.log(`${p.percent.toFixed(1)}%`),
 * });
 *
 * console.log('Verified data:', data.length, 'bytes');
 * ```
 *
 * @param options - Verification options
 * @returns The verified content
 */
export async function verifyBao(options: VerifyBaoOptions): Promise<Uint8Array> {
  const config: import('./types.js').BaoVerifierConfig = {
    url: options.url,
    rootHash: options.rootHash,
    contentLength: options.contentLength,
  };

  if (options.outboardUrl !== undefined) {
    Object.assign(config, { outboardUrl: options.outboardUrl });
  }
  if (options.concurrency !== undefined) {
    Object.assign(config, { concurrency: options.concurrency });
  }

  const verifier = new BaoVerifier(config);

  // Set up progress callback
  if (options.onProgress) {
    verifier.on('progress', options.onProgress);
  }

  // Set up abort handling
  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      verifier.abort();
    });
  }

  return verifier.start();
}

/**
 * Verify Bao-encoded data synchronously (for already-downloaded data).
 *
 * This function verifies data that has already been downloaded, without
 * making any network requests. Useful for verifying cached or local data.
 *
 * @example
 * ```typescript
 * const encodedData = await fetch('snapshot.bao').then(r => r.arrayBuffer());
 * const rootHash = 'abcd1234...';
 *
 * const verified = await verifyBaoData(
 *   new Uint8Array(encodedData),
 *   rootHash
 * );
 *
 * console.log('Verified data:', verified.length, 'bytes');
 * ```
 *
 * @param encodedData - The Bao-encoded data
 * @param rootHash - Expected BLAKE3 Bao root hash (hex string)
 * @returns The verified and decoded content
 * @throws {BaoVerifierError} If verification fails
 */
export async function verifyBaoData(
  encodedData: Uint8Array,
  rootHash: string
): Promise<Uint8Array> {
  if (!rootHash || rootHash.length !== 64) {
    throw new BaoVerifierError(
      'Valid root hash (64 hex chars) is required',
      'INVALID_ROOT_HASH'
    );
  }

  try {
    // Convert hex hash to bytes
    const hashBytes = hexToBytes(rootHash);

    // baoDecode takes (encoded, hash) and returns decoded data
    // It throws if verification fails
    const decoded = baoDecode(encodedData, hashBytes);

    return decoded;
  } catch (error) {
    if (error instanceof BaoVerifierError) {
      throw error;
    }

    const cause = error instanceof Error ? error : undefined;
    throw new BaoVerifierError(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
      'VERIFICATION_FAILED',
      cause ? { cause } : undefined
    );
  }
}

/**
 * Verify Bao-encoded outboard data.
 *
 * This function verifies data using a separate outboard hash tree,
 * without making any network requests.
 *
 * @param data - The original data
 * @param outboard - The Bao outboard hash tree
 * @param rootHash - Expected BLAKE3 Bao root hash (hex string)
 * @returns The verified data (same as input if valid)
 * @throws {BaoVerifierError} If verification fails
 */
export async function verifyBaoOutboard(
  data: Uint8Array,
  outboard: Uint8Array,
  rootHash: string
): Promise<Uint8Array> {
  if (!rootHash || rootHash.length !== 64) {
    throw new BaoVerifierError(
      'Valid root hash (64 hex chars) is required',
      'INVALID_ROOT_HASH'
    );
  }

  try {
    // Convert hex hash to bytes
    const hashBytes = hexToBytes(rootHash);

    // baoDecode with outboard: (outboard, hash, originalData)
    const decoded = baoDecode(outboard, hashBytes, data);

    return decoded;
  } catch (error) {
    if (error instanceof BaoVerifierError) {
      throw error;
    }

    const cause = error instanceof Error ? error : undefined;
    throw new BaoVerifierError(
      `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
      'VERIFICATION_FAILED',
      cause ? { cause } : undefined
    );
  }
}

/**
 * Fetch and verify a snapshot from metadata.
 *
 * This convenience function fetches the metadata.json, then downloads and
 * verifies the snapshot data.
 *
 * @example
 * ```typescript
 * const result = await fetchAndVerifySnapshot(
 *   'https://example.com/snapshots/2000000',
 *   { onProgress: (p) => console.log(`${p.percent}%`) }
 * );
 *
 * console.log('Verified:', result.data.length, 'bytes');
 * console.log('Height:', result.metadata.height);
 * ```
 *
 * @param baseUrl - Base URL for the snapshot (without file extension)
 * @param options - Optional configuration
 * @returns The verified data and metadata
 */
/**
 * Metadata structure returned by fetchAndVerifySnapshot.
 */
interface FetchedMetadata {
  version: number;
  type: string;
  network: string;
  height: number;
  hash: string;
  rootHash: string;
  originalSize: number;
  encodedSize: number;
  outboard: boolean;
}

export async function fetchAndVerifySnapshot(
  baseUrl: string,
  options?: {
    onProgress?: (progress: VerificationProgress) => void;
    signal?: AbortSignal;
    concurrency?: number;
    fetch?: typeof globalThis.fetch;
  }
): Promise<{
  data: Uint8Array;
  metadata: FetchedMetadata;
}> {
  const fetchFn = options?.fetch ?? globalThis.fetch.bind(globalThis);

  // Fetch metadata
  const metadataUrl = `${baseUrl}.metadata.json`;
  const fetchInit: RequestInit = {};
  if (options?.signal) {
    fetchInit.signal = options.signal;
  }
  const metadataResponse = await fetchFn(metadataUrl, fetchInit);

  if (!metadataResponse.ok) {
    throw new BaoVerifierError(
      `Failed to fetch metadata: ${metadataResponse.status}`,
      'FETCH_FAILED'
    );
  }

  const metadata = (await metadataResponse.json()) as FetchedMetadata;

  // Determine URLs
  const baoUrl = `${baseUrl}.bao`;
  const dataUrl = metadata.outboard ? `${baseUrl}.data` : baoUrl;

  // Build verifier config
  const verifierConfig: import('./types.js').BaoVerifierConfig = {
    url: dataUrl,
    rootHash: metadata.rootHash,
    contentLength: metadata.originalSize,
    fetch: fetchFn,
  };

  if (metadata.outboard) {
    Object.assign(verifierConfig, { outboardUrl: baoUrl });
  }
  if (options?.concurrency !== undefined) {
    Object.assign(verifierConfig, { concurrency: options.concurrency });
  }

  const verifier = new BaoVerifier(verifierConfig);

  if (options?.onProgress) {
    verifier.on('progress', options.onProgress);
  }

  if (options?.signal) {
    options.signal.addEventListener('abort', () => {
      verifier.abort();
    });
  }

  const data = await verifier.start();

  return { data, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert hex string to bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
