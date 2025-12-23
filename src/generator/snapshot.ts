/**
 * Snapshot generator for creating Bao-encoded tree state snapshots.
 *
 * @packageDocumentation
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { baoEncode, baoEncodeIroh } from 'blake3-bao';
import type { TreeState } from '../types/zcash.js';
import type {
  SnapshotMetadata,
  SnapshotOptions,
  SnapshotProgress,
  SnapshotProgressCallback,
  SnapshotResult,
  CanonicalTreeState,
  BaoEncodingMode,
} from '../types/snapshot.js';
import { SNAPSHOT_FORMAT_VERSION } from '../types/snapshot.js';
import type { ZcashRpcClient } from './rpc-client.js';

/**
 * Error thrown when snapshot generation fails.
 */
export class SnapshotError extends Error {
  /**
   * The phase where the error occurred.
   */
  readonly phase: SnapshotProgress['phase'];

  /**
   * The original error that caused the failure.
   */
  readonly originalError: Error | undefined;

  constructor(
    message: string,
    phase: SnapshotProgress['phase'],
    options?: { cause?: Error }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'SnapshotError';
    this.phase = phase;
    this.originalError = options?.cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Result of Bao encoding operation.
 */
interface BaoEncodeResult {
  /**
   * The encoded data (combined mode) or outboard hash tree (outboard mode).
   */
  readonly encoded: Uint8Array;

  /**
   * The BLAKE3 Bao root hash.
   */
  readonly hash: Uint8Array;

  /**
   * Original data (only present in outboard mode).
   */
  readonly data?: Uint8Array;
}

/**
 * Generator for creating Bao-encoded Zcash tree state snapshots.
 *
 * This class fetches tree states from zcashd, serializes them to a canonical
 * format, and encodes them using Bao verified streaming for efficient and
 * secure distribution.
 *
 * @example
 * ```typescript
 * const client = new ZcashRpcClient({ username: 'user', password: 'pass' });
 * const generator = new SnapshotGenerator(client);
 *
 * const result = await generator.createSnapshot({
 *   height: 2000000,
 *   outputDir: './snapshots',
 *   mode: 'outboard',
 *   irohCompatible: true,
 *   onProgress: (p) => console.log(p.message),
 * });
 *
 * console.log(`Snapshot created: ${result.baoPath}`);
 * console.log(`Root hash: ${result.metadata.rootHash}`);
 * ```
 */
export class SnapshotGenerator {
  private readonly client: ZcashRpcClient;

  /**
   * Create a new snapshot generator.
   *
   * @param client - The RPC client to use for fetching tree states
   */
  constructor(client: ZcashRpcClient) {
    this.client = client;
  }

  /**
   * Create a Bao-encoded snapshot of the tree state at a specific height.
   *
   * @param options - Snapshot creation options
   * @returns Result containing file paths and metadata
   * @throws {SnapshotError} If snapshot creation fails
   */
  async createSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
    const startTime = Date.now();
    const network = options.network ?? 'mainnet';
    const mode = options.mode ?? 'combined';
    const irohCompatible = options.irohCompatible ?? false;
    const onProgress = options.onProgress ?? (() => {});

    // Phase 1: Fetch tree state
    this.reportProgress(onProgress, {
      phase: 'fetching',
      message: `Fetching tree state at height ${options.height}...`,
    });

    let treeState: TreeState;
    try {
      treeState = await this.client.getTreeState(options.height);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new SnapshotError(
        `Failed to fetch tree state at height ${options.height}`,
        'fetching',
        cause ? { cause } : undefined
      );
    }

    // Phase 2: Serialize to canonical format
    this.reportProgress(onProgress, {
      phase: 'serializing',
      message: 'Serializing tree state to canonical format...',
    });

    let serializedData: Uint8Array;
    let canonicalState: CanonicalTreeState;
    try {
      canonicalState = this.toCanonicalFormat(treeState);
      serializedData = this.serializeCanonical(canonicalState);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new SnapshotError(
        'Failed to serialize tree state',
        'serializing',
        cause ? { cause } : undefined
      );
    }

    const originalSize = serializedData.length;

    this.reportProgress(onProgress, {
      phase: 'serializing',
      message: `Serialized ${originalSize} bytes`,
      bytesProcessed: originalSize,
      totalBytes: originalSize,
      percent: 100,
    });

    // Phase 3: Bao encode
    this.reportProgress(onProgress, {
      phase: 'encoding',
      message: `Bao encoding (${mode}${irohCompatible ? ', Iroh-compatible' : ''})...`,
    });

    let encodeResult: BaoEncodeResult;
    try {
      encodeResult = await this.baoEncodeData(serializedData, mode, irohCompatible);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new SnapshotError(
        `Failed to Bao encode data: ${error instanceof Error ? error.message : String(error)}`,
        'encoding',
        cause ? { cause } : undefined
      );
    }

    const rootHash = this.bytesToHex(encodeResult.hash);
    const encodedSize = encodeResult.encoded.length;

    this.reportProgress(onProgress, {
      phase: 'encoding',
      message: `Encoded to ${encodedSize} bytes (root: ${rootHash.slice(0, 16)}...)`,
      bytesProcessed: encodedSize,
      totalBytes: encodedSize,
      percent: 100,
    });

    // Phase 4: Write output files
    this.reportProgress(onProgress, {
      phase: 'writing',
      message: 'Writing output files...',
    });

    const baseName = `${options.height}`;
    const baoPath = join(options.outputDir, `${baseName}.bao`);
    const metadataPath = join(options.outputDir, `${baseName}.metadata.json`);

    try {
      // Ensure output directory exists
      await mkdir(dirname(baoPath), { recursive: true });

      // Build metadata with conditional properties
      const metadata = this.buildMetadata(
        network,
        options.height,
        treeState.hash,
        rootHash,
        originalSize,
        encodedSize,
        mode,
        irohCompatible,
        options.description,
        canonicalState.sapling?.finalRoot,
        canonicalState.orchard?.finalRoot
      );

      // Write files
      const writePromises: Promise<void>[] = [
        writeFile(baoPath, encodeResult.encoded),
        writeFile(metadataPath, JSON.stringify(metadata, null, 2)),
      ];

      // In outboard mode, also write the original data
      let dataPath: string | undefined;
      if (mode === 'outboard') {
        dataPath = join(options.outputDir, `${baseName}.data`);
        writePromises.push(writeFile(dataPath, serializedData));
      }

      await Promise.all(writePromises);

      this.reportProgress(onProgress, {
        phase: 'writing',
        message: `Wrote ${mode === 'outboard' ? 3 : 2} files`,
        percent: 100,
      });

      // Phase 5: Complete
      const elapsedMs = Date.now() - startTime;

      this.reportProgress(onProgress, {
        phase: 'complete',
        message: `Snapshot complete in ${elapsedMs}ms`,
        percent: 100,
      });

      // Build result with conditional dataPath
      return this.buildResult(baoPath, metadataPath, dataPath, metadata, elapsedMs);
    } catch (error) {
      if (error instanceof SnapshotError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new SnapshotError(
        `Failed to write output files: ${error instanceof Error ? error.message : String(error)}`,
        'writing',
        cause ? { cause } : undefined
      );
    }
  }

  /**
   * Build metadata object with proper optional properties.
   */
  private buildMetadata(
    network: 'mainnet' | 'testnet' | 'regtest',
    height: number,
    hash: string,
    rootHash: string,
    originalSize: number,
    encodedSize: number,
    mode: BaoEncodingMode,
    irohCompatible: boolean,
    description: string | undefined,
    saplingRoot: string | undefined,
    orchardRoot: string | undefined
  ): SnapshotMetadata {
    const base: SnapshotMetadata = {
      version: SNAPSHOT_FORMAT_VERSION,
      type: 'tree-state',
      network,
      height,
      hash,
      rootHash,
      originalSize,
      encodedSize,
      outboard: mode === 'outboard',
      createdAt: new Date().toISOString(),
    };

    // Add optional properties only if they have values
    if (mode === 'outboard') {
      Object.assign(base, { irohCompatible });
    }
    if (description !== undefined) {
      Object.assign(base, { description });
    }
    if (saplingRoot !== undefined) {
      Object.assign(base, { saplingRoot });
    }
    if (orchardRoot !== undefined) {
      Object.assign(base, { orchardRoot });
    }

    return base;
  }

  /**
   * Build result object with proper optional properties.
   */
  private buildResult(
    baoPath: string,
    metadataPath: string,
    dataPath: string | undefined,
    metadata: SnapshotMetadata,
    elapsedMs: number
  ): SnapshotResult {
    const base: SnapshotResult = {
      baoPath,
      metadataPath,
      metadata,
      elapsedMs,
    };

    if (dataPath !== undefined) {
      Object.assign(base, { dataPath });
    }

    return base;
  }

  /**
   * Create snapshots for a range of heights.
   *
   * @param startHeight - Start height (inclusive)
   * @param endHeight - End height (inclusive)
   * @param options - Base snapshot options (height will be overridden)
   * @returns Array of snapshot results
   */
  async createSnapshotRange(
    startHeight: number,
    endHeight: number,
    options: Omit<SnapshotOptions, 'height'>
  ): Promise<SnapshotResult[]> {
    if (startHeight > endHeight) {
      throw new SnapshotError(
        `Invalid range: startHeight (${startHeight}) > endHeight (${endHeight})`,
        'fetching'
      );
    }

    const results: SnapshotResult[] = [];
    const total = endHeight - startHeight + 1;

    for (let height = startHeight; height <= endHeight; height++) {
      const current = height - startHeight + 1;

      // Wrap progress callback to include range info
      const wrappedProgress: SnapshotProgressCallback = (progress) => {
        if (options.onProgress) {
          options.onProgress({
            ...progress,
            message: `[${current}/${total}] ${progress.message}`,
          });
        }
      };

      const result = await this.createSnapshot({
        ...options,
        height,
        onProgress: wrappedProgress,
      });

      results.push(result);
    }

    return results;
  }

  /**
   * Convert tree state to canonical format for consistent serialization.
   */
  private toCanonicalFormat(treeState: TreeState): CanonicalTreeState {
    const result: CanonicalTreeState = {
      version: SNAPSHOT_FORMAT_VERSION,
      hash: treeState.hash,
      height: treeState.height,
      time: treeState.time,
    };

    // Only include trees that are present
    if (treeState.sapling) {
      return {
        ...result,
        sapling: {
          finalRoot: treeState.sapling.finalRoot,
          tree: treeState.sapling.tree,
        },
        ...(treeState.orchard
          ? {
              orchard: {
                finalRoot: treeState.orchard.finalRoot,
                tree: treeState.orchard.tree,
              },
            }
          : {}),
      };
    }

    if (treeState.orchard) {
      return {
        ...result,
        orchard: {
          finalRoot: treeState.orchard.finalRoot,
          tree: treeState.orchard.tree,
        },
      };
    }

    return result;
  }

  /**
   * Serialize canonical tree state to bytes.
   * Uses JSON with sorted keys for deterministic output.
   */
  private serializeCanonical(state: CanonicalTreeState): Uint8Array {
    // JSON.stringify with sorted keys for canonical output
    const json = JSON.stringify(state, Object.keys(state).sort(), 0);
    return new TextEncoder().encode(json);
  }

  /**
   * Bao encode data using the appropriate method.
   */
  private async baoEncodeData(
    data: Uint8Array,
    mode: BaoEncodingMode,
    irohCompatible: boolean
  ): Promise<BaoEncodeResult> {
    if (mode === 'outboard' && irohCompatible) {
      // Use Iroh-compatible encoding (16KB chunk groups)
      const result = await baoEncodeIroh(data);
      return {
        encoded: result.outboard,
        hash: result.hash,
        data,
      };
    } else if (mode === 'outboard') {
      // Standard outboard encoding
      const result = await baoEncode(data, { outboard: true });
      return {
        encoded: result.outboard,
        hash: result.hash,
        data,
      };
    } else {
      // Combined mode (default)
      const result = await baoEncode(data);
      return {
        encoded: result.encoded,
        hash: result.hash,
      };
    }
  }

  /**
   * Convert bytes to hex string.
   */
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Report progress to callback.
   * Logs errors instead of silently swallowing them.
   */
  private reportProgress(
    callback: SnapshotProgressCallback,
    progress: SnapshotProgress
  ): void {
    try {
      callback(progress);
    } catch (error) {
      // Log the error but don't let it interrupt snapshot generation
      console.error(
        `[SnapshotGenerator] Progress callback error during ${progress.phase}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
