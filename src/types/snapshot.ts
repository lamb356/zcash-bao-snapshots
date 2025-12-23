/**
 * Snapshot types and metadata definitions.
 *
 * @packageDocumentation
 */

import type { ZcashNetwork } from './zcash.js';

/**
 * Current version of the snapshot format.
 * Increment when making breaking changes to the format.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/**
 * Type of data contained in the snapshot.
 */
export type SnapshotType = 'tree-state' | 'compact-blocks';

/**
 * Encoding mode for Bao snapshots.
 */
export type BaoEncodingMode = 'combined' | 'outboard';

/**
 * Metadata stored alongside a Bao-encoded snapshot.
 * This file is written as metadata.json next to the .bao file.
 */
export interface SnapshotMetadata {
  /**
   * Format version for backwards compatibility.
   */
  readonly version: number;

  /**
   * Type of data in this snapshot.
   */
  readonly type: SnapshotType;

  /**
   * Zcash network this snapshot is from.
   */
  readonly network: ZcashNetwork;

  /**
   * Block height this snapshot represents.
   */
  readonly height: number;

  /**
   * Block hash this snapshot represents.
   */
  readonly hash: string;

  /**
   * BLAKE3 Bao root hash of the encoded data (hex).
   * This is used to verify the integrity of streamed data.
   */
  readonly rootHash: string;

  /**
   * Size of the original (unencoded) data in bytes.
   */
  readonly originalSize: number;

  /**
   * Size of the Bao-encoded data in bytes.
   * For combined mode: includes data + tree
   * For outboard mode: just the tree (data is separate)
   */
  readonly encodedSize: number;

  /**
   * Whether this snapshot uses outboard encoding.
   * If true, the .bao file contains only the hash tree.
   * If false, the .bao file contains data + hash tree interleaved.
   */
  readonly outboard: boolean;

  /**
   * If outboard mode with Iroh encoding, the chunk group size.
   * Iroh uses 16KB chunk groups (4 chunks of 1024 bytes each).
   */
  readonly irohCompatible?: boolean;

  /**
   * ISO 8601 timestamp when this snapshot was created.
   */
  readonly createdAt: string;

  /**
   * Optional description or notes about this snapshot.
   */
  readonly description?: string;

  /**
   * Sapling tree root hash if present (hex).
   */
  readonly saplingRoot?: string;

  /**
   * Orchard tree root hash if present (hex).
   */
  readonly orchardRoot?: string;
}

/**
 * Options for creating a snapshot.
 */
export interface SnapshotOptions {
  /**
   * Block height to snapshot.
   */
  readonly height: number;

  /**
   * Output directory for snapshot files.
   * Files will be named: {height}.bao and {height}.metadata.json
   */
  readonly outputDir: string;

  /**
   * Zcash network (default: mainnet).
   */
  readonly network?: ZcashNetwork;

  /**
   * Encoding mode (default: combined).
   * - combined: data and hash tree interleaved in single file
   * - outboard: hash tree only, data referenced separately
   */
  readonly mode?: BaoEncodingMode;

  /**
   * Use Iroh-compatible encoding for outboard mode.
   * This uses 16KB chunk groups for 16x smaller outboard files.
   * Only applies when mode is 'outboard'.
   */
  readonly irohCompatible?: boolean;

  /**
   * Optional description to include in metadata.
   */
  readonly description?: string;

  /**
   * Progress callback called during encoding.
   */
  readonly onProgress?: SnapshotProgressCallback;

  /**
   * Threshold in bytes for using worker thread encoding.
   * Files larger than this will be encoded in a worker thread to avoid blocking.
   * Default: 10MB (10_000_000 bytes).
   */
  readonly workerThreshold?: number;
}

/**
 * Progress information during snapshot creation.
 */
export interface SnapshotProgress {
  /**
   * Current phase of the snapshot process.
   */
  readonly phase: 'fetching' | 'serializing' | 'encoding' | 'writing' | 'complete';

  /**
   * Human-readable description of current activity.
   */
  readonly message: string;

  /**
   * Progress percentage (0-100) if available.
   */
  readonly percent?: number;

  /**
   * Bytes processed so far.
   */
  readonly bytesProcessed?: number;

  /**
   * Total bytes to process.
   */
  readonly totalBytes?: number;
}

/**
 * Callback for progress updates during snapshot creation.
 */
export type SnapshotProgressCallback = (progress: SnapshotProgress) => void;

/**
 * Result of creating a snapshot.
 */
export interface SnapshotResult {
  /**
   * Path to the Bao-encoded file.
   */
  readonly baoPath: string;

  /**
   * Path to the metadata JSON file.
   */
  readonly metadataPath: string;

  /**
   * Path to the original data file (only in outboard mode).
   */
  readonly dataPath?: string;

  /**
   * The snapshot metadata.
   */
  readonly metadata: SnapshotMetadata;

  /**
   * Time taken to create the snapshot in milliseconds.
   */
  readonly elapsedMs: number;
}

/**
 * Canonical format for serializing tree state data.
 * This ensures consistent encoding across different runs.
 */
export interface CanonicalTreeState {
  /**
   * Format version.
   */
  readonly version: number;

  /**
   * Block hash.
   */
  readonly hash: string;

  /**
   * Block height.
   */
  readonly height: number;

  /**
   * Block timestamp.
   */
  readonly time: number;

  /**
   * Sapling tree data if present.
   */
  readonly sapling?: {
    readonly finalRoot: string;
    readonly tree: string;
  };

  /**
   * Orchard tree data if present.
   */
  readonly orchard?: {
    readonly finalRoot: string;
    readonly tree: string;
  };
}
