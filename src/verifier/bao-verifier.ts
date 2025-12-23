/**
 * BaoVerifier - Browser and Node.js compatible Bao verification with resumable downloads.
 *
 * @packageDocumentation
 */

import { PartialBao } from 'blake3-bao';
import type {
  BaoVerifierConfig,
  BaoVerifierEvents,
  BaoVerifierEventListener,
  VerificationProgress,
  ChunkVerifiedInfo,
  VerifierState,
  VerifierStatus,
  StorageAdapter,
} from './types.js';
import { BaoVerifierError, VERIFIER_STATE_VERSION } from './types.js';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG = {
  concurrency: 4,
  chunkSize: 1024,
  chunksPerRequest: 1,
  requestTimeout: 30000,
  maxRetries: 3,
} as const;

/**
 * Bao verifier with resumable, concurrent chunk downloads.
 *
 * This class wraps the PartialBao class from blake3-bao and provides:
 * - HTTP range request fetching with configurable concurrency
 * - Event-driven progress reporting
 * - Pause/resume with state persistence
 * - Works in both browsers and Node.js
 *
 * @example
 * ```typescript
 * const verifier = new BaoVerifier({
 *   url: 'https://example.com/snapshot.bao',
 *   rootHash: 'abcd1234...',
 *   contentLength: 1000000,
 *   concurrency: 4,
 * });
 *
 * verifier.on('progress', (p) => {
 *   console.log(`${p.percent}% - ${p.speed} bytes/sec - ETA: ${p.eta}s`);
 * });
 *
 * verifier.on('complete', ({ data }) => {
 *   console.log('Verification complete!', data.length, 'bytes');
 * });
 *
 * await verifier.start();
 * ```
 */
export class BaoVerifier {
  private readonly config: Required<Omit<BaoVerifierConfig, 'storage' | 'fetch' | 'outboardUrl' | 'irohCompatible'>> & {
    storage: StorageAdapter | undefined;
    fetch: typeof globalThis.fetch;
    outboardUrl: string | undefined;
    irohCompatible: boolean;
  };

  private readonly listeners: Map<keyof BaoVerifierEvents, Set<BaoVerifierEventListener<keyof BaoVerifierEvents>>>;
  private readonly completedChunks: Set<number>;
  private readonly chunkData: Map<number, Uint8Array>;
  private readonly pendingChunks: Set<number>;

  private partialBao: InstanceType<typeof PartialBao> | null = null;
  private status: VerifierStatus = 'idle';
  private abortController: AbortController | null = null;
  private startTime: number = 0;
  private bytesDownloaded: number = 0;
  private lastProgressTime: number = 0;
  private lastBytesDownloaded: number = 0;
  private totalChunks: number = 0;
  private stateKey: string;

  /**
   * Create a new BaoVerifier.
   *
   * @param config - Verifier configuration
   */
  constructor(config: BaoVerifierConfig) {
    // Validate required fields
    if (!config.url) {
      throw new BaoVerifierError('URL is required', 'INVALID_STATE');
    }
    if (!config.rootHash || config.rootHash.length !== 64) {
      throw new BaoVerifierError('Valid root hash (64 hex chars) is required', 'INVALID_ROOT_HASH');
    }
    if (!config.contentLength || config.contentLength <= 0) {
      throw new BaoVerifierError('Valid content length is required', 'INVALID_STATE');
    }

    this.config = {
      url: config.url,
      rootHash: config.rootHash,
      contentLength: config.contentLength,
      outboardUrl: config.outboardUrl,
      irohCompatible: config.irohCompatible ?? false,
      concurrency: config.concurrency ?? DEFAULT_CONFIG.concurrency,
      chunkSize: config.chunkSize ?? DEFAULT_CONFIG.chunkSize,
      chunksPerRequest: config.chunksPerRequest ?? (config.irohCompatible ? 16 : DEFAULT_CONFIG.chunksPerRequest),
      requestTimeout: config.requestTimeout ?? DEFAULT_CONFIG.requestTimeout,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
      storage: config.storage,
    };

    this.listeners = new Map();
    this.completedChunks = new Set();
    this.chunkData = new Map();
    this.pendingChunks = new Set();
    this.totalChunks = Math.ceil(this.config.contentLength / this.config.chunkSize);
    this.stateKey = this.generateStateKey();
  }

  /**
   * Generate a unique key for persisting state.
   */
  private generateStateKey(): string {
    return `${this.config.rootHash.slice(0, 16)}-${this.config.contentLength}`;
  }

  /**
   * Get the current verifier status.
   */
  getStatus(): VerifierStatus {
    return this.status;
  }

  /**
   * Get the current progress.
   */
  getProgress(): VerificationProgress {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const speed = this.calculateSpeed();
    const remaining = this.config.contentLength - this.bytesDownloaded;
    const eta = speed > 0 ? remaining / speed : 0;

    return {
      bytesDownloaded: this.bytesDownloaded,
      totalBytes: this.config.contentLength,
      chunksVerified: this.completedChunks.size,
      totalChunks: this.totalChunks,
      percent: (this.bytesDownloaded / this.config.contentLength) * 100,
      speed,
      eta,
      elapsedMs: elapsed,
    };
  }

  /**
   * Calculate current download speed in bytes/sec.
   */
  private calculateSpeed(): number {
    const now = Date.now();
    const timeDiff = now - this.lastProgressTime;

    if (timeDiff < 100) {
      // Not enough time has passed, return cached speed
      return this.lastBytesDownloaded > 0
        ? ((this.bytesDownloaded - this.lastBytesDownloaded) / timeDiff) * 1000
        : 0;
    }

    const bytesDiff = this.bytesDownloaded - this.lastBytesDownloaded;
    const speed = (bytesDiff / timeDiff) * 1000;

    this.lastProgressTime = now;
    this.lastBytesDownloaded = this.bytesDownloaded;

    return speed;
  }

  /**
   * Register an event listener.
   */
  on<K extends keyof BaoVerifierEvents>(
    event: K,
    listener: BaoVerifierEventListener<K>
  ): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as BaoVerifierEventListener<keyof BaoVerifierEvents>);
    return this;
  }

  /**
   * Remove an event listener.
   */
  off<K extends keyof BaoVerifierEvents>(
    event: K,
    listener: BaoVerifierEventListener<K>
  ): this {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener as BaoVerifierEventListener<keyof BaoVerifierEvents>);
    }
    return this;
  }

  /**
   * Emit an event to all listeners.
   */
  private emit<K extends keyof BaoVerifierEvents>(
    event: K,
    data: BaoVerifierEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        try {
          (listener as BaoVerifierEventListener<K>)(data);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  /**
   * Start or resume verification.
   */
  async start(): Promise<Uint8Array> {
    if (this.status === 'downloading') {
      throw new BaoVerifierError('Verification already in progress', 'INVALID_STATE');
    }

    if (this.status === 'complete') {
      return this.assembleData();
    }

    // Try to restore from saved state
    if (this.config.storage && this.status === 'idle') {
      await this.restoreState();
    }

    this.status = 'downloading';
    this.abortController = new AbortController();
    this.startTime = Date.now();
    this.lastProgressTime = this.startTime;
    this.lastBytesDownloaded = this.bytesDownloaded;

    // Initialize PartialBao
    const rootHashBytes = this.hexToBytes(this.config.rootHash);
    this.partialBao = new PartialBao(rootHashBytes, this.config.contentLength);

    try {
      // Build list of chunks to download
      const chunksToDownload: number[] = [];
      for (let i = 0; i < this.totalChunks; i++) {
        if (!this.completedChunks.has(i)) {
          chunksToDownload.push(i);
        }
      }

      // Download chunks with concurrency
      await this.downloadChunks(chunksToDownload);

      // Verify we got everything
      if (this.completedChunks.size !== this.totalChunks) {
        throw new BaoVerifierError(
          `Missing chunks: expected ${this.totalChunks}, got ${this.completedChunks.size}`,
          'VERIFICATION_FAILED'
        );
      }

      // Assemble final data
      const data = this.assembleData();

      // Clean up saved state
      if (this.config.storage) {
        await this.config.storage.delete(this.stateKey);
      }

      this.status = 'complete';

      const elapsed = Date.now() - this.startTime;
      const averageSpeed = this.config.contentLength / (elapsed / 1000);

      this.emit('complete', {
        data,
        elapsedMs: elapsed,
        averageSpeed,
      });

      return data;
    } catch (error) {
      // Status could be 'paused' if pause() was called concurrently
      const currentStatus = this.status as VerifierStatus;
      if (currentStatus !== 'paused') {
        this.status = 'error';

        const cause = error instanceof Error ? error : undefined;
        const verifierError = error instanceof BaoVerifierError
          ? error
          : new BaoVerifierError(
              error instanceof Error ? error.message : String(error),
              'NETWORK_ERROR',
              cause ? { cause, recoverable: true } : { recoverable: true }
            );

        this.emit('error', verifierError);
      }
      throw error;
    }
  }

  /**
   * Download chunks with concurrency control.
   */
  private async downloadChunks(chunkIndices: number[]): Promise<void> {
    const queue = [...chunkIndices];
    const inFlight: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      while (queue.length > 0 && this.status === 'downloading') {
        const chunkIndex = queue.shift();
        if (chunkIndex === undefined) break;

        if (this.pendingChunks.has(chunkIndex) || this.completedChunks.has(chunkIndex)) {
          continue;
        }

        this.pendingChunks.add(chunkIndex);

        try {
          await this.downloadAndVerifyChunk(chunkIndex);
        } finally {
          this.pendingChunks.delete(chunkIndex);
        }
      }
    };

    // Start concurrent downloaders
    for (let i = 0; i < this.config.concurrency; i++) {
      inFlight.push(processNext());
    }

    await Promise.all(inFlight);
  }

  /**
   * Download and verify a single chunk (or chunk group).
   */
  private async downloadAndVerifyChunk(startChunkIndex: number): Promise<void> {
    const chunkSize = this.config.chunkSize;
    const chunksPerRequest = this.config.chunksPerRequest;

    // Calculate byte range
    const startOffset = startChunkIndex * chunkSize;
    const endChunk = Math.min(startChunkIndex + chunksPerRequest, this.totalChunks);
    const endOffset = Math.min(endChunk * chunkSize, this.config.contentLength);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      if (this.status !== 'downloading') {
        return;
      }

      try {
        const data = await this.fetchRange(startOffset, endOffset - 1);

        // Verify each chunk in the response
        for (let i = startChunkIndex; i < endChunk; i++) {
          const chunkStart = (i - startChunkIndex) * chunkSize;
          const chunkEnd = Math.min(chunkStart + chunkSize, data.length);
          const chunkData = data.slice(chunkStart, chunkEnd);

          // Verify with PartialBao
          if (this.partialBao) {
            const isValid = await this.partialBao.verifyChunk(i, chunkData);
            if (!isValid) {
              throw new BaoVerifierError(
                `Chunk ${i} verification failed`,
                'VERIFICATION_FAILED',
                { chunkIndex: i, recoverable: true }
              );
            }
          }

          // Store verified chunk
          this.chunkData.set(i, chunkData);
          this.completedChunks.add(i);
          this.bytesDownloaded += chunkData.length;

          // Emit chunk verified event
          const info: ChunkVerifiedInfo = {
            chunkIndex: i,
            offset: i * chunkSize,
            size: chunkData.length,
            data: chunkData,
          };
          this.emit('chunk-verified', info);
        }

        // Emit progress
        this.emit('progress', this.getProgress());

        // Save state periodically
        if (this.config.storage && this.completedChunks.size % 10 === 0) {
          await this.saveState();
        }

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof BaoVerifierError && !error.recoverable) {
          throw error;
        }

        // Wait before retry with exponential backoff
        if (attempt < this.config.maxRetries - 1) {
          await this.sleep(Math.min(1000 * Math.pow(2, attempt), 10000));
        }
      }
    }

    throw new BaoVerifierError(
      `Failed to download chunk ${startChunkIndex} after ${this.config.maxRetries} attempts`,
      'FETCH_FAILED',
      lastError
        ? { chunkIndex: startChunkIndex, recoverable: true, cause: lastError }
        : { chunkIndex: startChunkIndex, recoverable: true }
    );
  }

  /**
   * Fetch a byte range from the URL.
   */
  private async fetchRange(start: number, end: number): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);

    // Combine with main abort controller
    const signal = this.abortController
      ? combineAbortSignals(this.abortController.signal, controller.signal)
      : controller.signal;

    try {
      const response = await this.config.fetch(this.config.url, {
        headers: {
          Range: `bytes=${start}-${end}`,
        },
        signal,
      });

      if (!response.ok && response.status !== 206) {
        throw new BaoVerifierError(
          `HTTP error: ${response.status} ${response.statusText}`,
          'FETCH_FAILED',
          { recoverable: response.status >= 500 }
        );
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Pause the verification.
   */
  async pause(): Promise<void> {
    if (this.status !== 'downloading') {
      return;
    }

    this.status = 'paused';

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Save state for resume
    if (this.config.storage) {
      await this.saveState();
    }
  }

  /**
   * Resume verification after pause.
   */
  async resume(): Promise<Uint8Array> {
    if (this.status !== 'paused') {
      throw new BaoVerifierError('Cannot resume: not paused', 'INVALID_STATE');
    }

    return this.start();
  }

  /**
   * Abort the verification.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.status = 'idle';
    this.completedChunks.clear();
    this.chunkData.clear();
    this.pendingChunks.clear();
    this.bytesDownloaded = 0;
  }

  /**
   * Export current state for persistence.
   */
  exportState(): VerifierState {
    const chunkDataEncoded: Record<number, string> = {};

    for (const [index, data] of this.chunkData.entries()) {
      chunkDataEncoded[index] = this.bytesToBase64(data);
    }

    const state: VerifierState = {
      version: VERIFIER_STATE_VERSION,
      rootHash: this.config.rootHash,
      contentLength: this.config.contentLength,
      url: this.config.url,
      completedChunks: Array.from(this.completedChunks),
      chunkData: chunkDataEncoded,
      savedAt: new Date().toISOString(),
      bytesDownloaded: this.bytesDownloaded,
    };

    if (this.config.outboardUrl) {
      return { ...state, outboardUrl: this.config.outboardUrl };
    }

    return state;
  }

  /**
   * Import state from persistence.
   */
  importState(state: VerifierState): void {
    if (state.version !== VERIFIER_STATE_VERSION) {
      throw new BaoVerifierError(
        `Incompatible state version: ${state.version}`,
        'INVALID_STATE'
      );
    }

    if (state.rootHash !== this.config.rootHash) {
      throw new BaoVerifierError(
        'State root hash does not match',
        'INVALID_STATE'
      );
    }

    if (state.contentLength !== this.config.contentLength) {
      throw new BaoVerifierError(
        'State content length does not match',
        'INVALID_STATE'
      );
    }

    this.completedChunks.clear();
    this.chunkData.clear();

    for (const index of state.completedChunks) {
      this.completedChunks.add(index);
    }

    for (const [indexStr, base64Data] of Object.entries(state.chunkData)) {
      const index = parseInt(indexStr, 10);
      const data = this.base64ToBytes(base64Data);
      this.chunkData.set(index, data);
    }

    this.bytesDownloaded = state.bytesDownloaded;
  }

  /**
   * Save state to storage adapter.
   */
  private async saveState(): Promise<void> {
    if (!this.config.storage) {
      return;
    }

    try {
      const state = this.exportState();
      await this.config.storage.save(this.stateKey, state);
    } catch (error) {
      // Log but don't fail
      console.warn('Failed to save verifier state:', error);
    }
  }

  /**
   * Restore state from storage adapter.
   */
  private async restoreState(): Promise<void> {
    if (!this.config.storage) {
      return;
    }

    try {
      const state = await this.config.storage.load(this.stateKey);
      if (state) {
        this.importState(state);
      }
    } catch (error) {
      // Log but don't fail - start fresh
      console.warn('Failed to restore verifier state:', error);
    }
  }

  /**
   * Assemble all chunks into final data.
   */
  private assembleData(): Uint8Array {
    const result = new Uint8Array(this.config.contentLength);

    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = this.chunkData.get(i);
      if (!chunk) {
        throw new BaoVerifierError(`Missing chunk ${i}`, 'VERIFICATION_FAILED');
      }

      const offset = i * this.config.chunkSize;
      result.set(chunk, offset);
    }

    return result;
  }

  /**
   * Convert hex string to bytes.
   */
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /**
   * Convert bytes to base64.
   */
  private bytesToBase64(bytes: Uint8Array): string {
    if (typeof btoa !== 'undefined') {
      // Browser
      const binary = Array.from(bytes)
        .map((b) => String.fromCharCode(b))
        .join('');
      return btoa(binary);
    } else {
      // Node.js
      return Buffer.from(bytes).toString('base64');
    }
  }

  /**
   * Convert base64 to bytes.
   */
  private base64ToBytes(base64: string): Uint8Array {
    if (typeof atob !== 'undefined') {
      // Browser
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } else {
      // Node.js
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }
  }

  /**
   * Sleep for a duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Combine multiple AbortSignals into one.
 */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  return controller.signal;
}
