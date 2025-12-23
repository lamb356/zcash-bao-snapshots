/**
 * Types for the Bao verifier module.
 *
 * @packageDocumentation
 */

/**
 * Configuration for creating a BaoVerifier.
 */
export interface BaoVerifierConfig {
  /**
   * URL to fetch the Bao-encoded content from.
   * Can be a .bao file (combined mode) or the data URL (outboard mode).
   */
  readonly url: string;

  /**
   * BLAKE3 Bao root hash for verification (hex string).
   */
  readonly rootHash: string;

  /**
   * Total size of the content in bytes.
   */
  readonly contentLength: number;

  /**
   * URL to fetch the outboard hash tree from (outboard mode only).
   */
  readonly outboardUrl?: string;

  /**
   * Whether this is Iroh-compatible encoding (16KB chunk groups).
   */
  readonly irohCompatible?: boolean;

  /**
   * Number of concurrent chunk fetches (default: 4).
   */
  readonly concurrency?: number;

  /**
   * Size of each chunk in bytes (default: 1024 for Bao).
   */
  readonly chunkSize?: number;

  /**
   * Number of chunks per request (default: 16 for Iroh, 1 for standard).
   */
  readonly chunksPerRequest?: number;

  /**
   * Timeout for HTTP requests in milliseconds (default: 30000).
   */
  readonly requestTimeout?: number;

  /**
   * Maximum number of retries per chunk (default: 3).
   */
  readonly maxRetries?: number;

  /**
   * Custom fetch function (useful for testing or custom transports).
   */
  readonly fetch?: typeof globalThis.fetch;

  /**
   * Storage adapter for persisting download state.
   */
  readonly storage?: StorageAdapter;
}

/**
 * Progress information during verification.
 */
export interface VerificationProgress {
  /**
   * Bytes downloaded so far.
   */
  readonly bytesDownloaded: number;

  /**
   * Total bytes to download.
   */
  readonly totalBytes: number;

  /**
   * Number of chunks verified so far.
   */
  readonly chunksVerified: number;

  /**
   * Total number of chunks.
   */
  readonly totalChunks: number;

  /**
   * Download progress as percentage (0-100).
   */
  readonly percent: number;

  /**
   * Current download speed in bytes per second.
   */
  readonly speed: number;

  /**
   * Estimated time remaining in seconds.
   */
  readonly eta: number;

  /**
   * Time elapsed since start in milliseconds.
   */
  readonly elapsedMs: number;
}

/**
 * Information about a verified chunk.
 */
export interface ChunkVerifiedInfo {
  /**
   * Index of the verified chunk.
   */
  readonly chunkIndex: number;

  /**
   * Offset of the chunk in the content.
   */
  readonly offset: number;

  /**
   * Size of the chunk in bytes.
   */
  readonly size: number;

  /**
   * The verified chunk data.
   */
  readonly data: Uint8Array;
}

/**
 * Events emitted by the BaoVerifier.
 */
export interface BaoVerifierEvents {
  /**
   * Emitted periodically with download/verification progress.
   */
  progress: VerificationProgress;

  /**
   * Emitted when a chunk is successfully verified.
   */
  'chunk-verified': ChunkVerifiedInfo;

  /**
   * Emitted when verification completes successfully.
   */
  complete: {
    /**
     * The complete verified content.
     */
    readonly data: Uint8Array;

    /**
     * Total time in milliseconds.
     */
    readonly elapsedMs: number;

    /**
     * Average download speed in bytes per second.
     */
    readonly averageSpeed: number;
  };

  /**
   * Emitted when an error occurs.
   */
  error: BaoVerifierError;
}

/**
 * Type for event listener functions.
 */
export type BaoVerifierEventListener<K extends keyof BaoVerifierEvents> = (
  event: BaoVerifierEvents[K]
) => void;

/**
 * State of the verifier that can be persisted.
 */
export interface VerifierState {
  /**
   * Version for state format compatibility.
   */
  readonly version: number;

  /**
   * The root hash being verified.
   */
  readonly rootHash: string;

  /**
   * Total content length.
   */
  readonly contentLength: number;

  /**
   * Source URL.
   */
  readonly url: string;

  /**
   * Outboard URL if applicable.
   */
  readonly outboardUrl?: string;

  /**
   * Indices of chunks that have been downloaded and verified.
   */
  readonly completedChunks: readonly number[];

  /**
   * The verified chunk data (stored as base64 or reference).
   */
  readonly chunkData: Record<number, string>;

  /**
   * Timestamp when this state was saved.
   */
  readonly savedAt: string;

  /**
   * Bytes downloaded so far.
   */
  readonly bytesDownloaded: number;
}

/**
 * Current version of the state format.
 */
export const VERIFIER_STATE_VERSION = 1;

/**
 * Storage adapter interface for persisting verifier state.
 */
export interface StorageAdapter {
  /**
   * Save state to storage.
   */
  save(key: string, state: VerifierState): Promise<void>;

  /**
   * Load state from storage.
   */
  load(key: string): Promise<VerifierState | null>;

  /**
   * Delete state from storage.
   */
  delete(key: string): Promise<void>;

  /**
   * Check if state exists.
   */
  exists(key: string): Promise<boolean>;
}

/**
 * Error thrown by the BaoVerifier.
 */
export class BaoVerifierError extends Error {
  /**
   * Error code for programmatic handling.
   */
  readonly code: BaoVerifierErrorCode;

  /**
   * The chunk index where the error occurred (if applicable).
   */
  readonly chunkIndex: number | undefined;

  /**
   * Whether the error is recoverable (can retry).
   */
  readonly recoverable: boolean;

  /**
   * Original error that caused this error.
   */
  readonly originalError: Error | undefined;

  constructor(
    message: string,
    code: BaoVerifierErrorCode,
    options?: {
      chunkIndex?: number;
      recoverable?: boolean;
      cause?: Error;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'BaoVerifierError';
    this.code = code;
    this.chunkIndex = options?.chunkIndex;
    this.recoverable = options?.recoverable ?? false;
    this.originalError = options?.cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error codes for BaoVerifier errors.
 */
export type BaoVerifierErrorCode =
  | 'FETCH_FAILED'
  | 'VERIFICATION_FAILED'
  | 'INVALID_ROOT_HASH'
  | 'INVALID_STATE'
  | 'STORAGE_ERROR'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE';

/**
 * Status of the verifier.
 */
export type VerifierStatus =
  | 'idle'
  | 'downloading'
  | 'paused'
  | 'complete'
  | 'error';

/**
 * Options for the verifyBao convenience function.
 */
export interface VerifyBaoOptions {
  /**
   * URL to fetch the Bao-encoded content from.
   */
  readonly url: string;

  /**
   * BLAKE3 Bao root hash for verification (hex string).
   */
  readonly rootHash: string;

  /**
   * Total size of the content in bytes.
   */
  readonly contentLength: number;

  /**
   * URL to fetch the outboard hash tree from (outboard mode only).
   */
  readonly outboardUrl?: string;

  /**
   * Progress callback.
   */
  readonly onProgress?: (progress: VerificationProgress) => void;

  /**
   * Abort signal for cancellation.
   */
  readonly signal?: AbortSignal;

  /**
   * Number of concurrent chunk fetches (default: 4).
   */
  readonly concurrency?: number;
}
