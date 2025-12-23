/**
 * Performance metrics and telemetry for zcash-bao-snapshots.
 *
 * @packageDocumentation
 */

/**
 * Worker thread usage statistics.
 */
export interface WorkerThreadMetrics {
  /** Number of times worker threads were used */
  readonly count: number;
  /** Total time spent in worker threads (ms) */
  readonly totalTimeMs: number;
  /** Average encoding speed in bytes/sec */
  readonly avgEncodingSpeed: number;
  /** Total bytes encoded by workers */
  readonly totalBytesEncoded: number;
}

/**
 * Adaptive concurrency statistics.
 */
export interface AdaptiveConcurrencyMetrics {
  /** Number of times concurrency was increased */
  readonly increases: number;
  /** Number of times concurrency was decreased */
  readonly decreases: number;
  /** Current concurrency level */
  readonly currentLevel: number;
  /** Peak concurrency level reached */
  readonly peakLevel: number;
}

/**
 * Compression savings statistics.
 */
export interface CompressionMetrics {
  /** Total bytes after compression */
  readonly compressedBytes: number;
  /** Total bytes before compression */
  readonly uncompressedBytes: number;
  /** Compression ratio (compressed/uncompressed) */
  readonly ratio: number;
  /** Number of times compression was used */
  readonly compressionCount: number;
}

/**
 * Download statistics.
 */
export interface DownloadMetrics {
  /** Total number of requests made */
  readonly requestCount: number;
  /** Total bytes downloaded */
  readonly totalBytesDownloaded: number;
  /** Average download speed in bytes/sec */
  readonly averageSpeed: number;
  /** Peak download speed in bytes/sec */
  readonly peakSpeed: number;
  /** Number of failed requests */
  readonly failedRequests: number;
  /** Number of retried requests */
  readonly retriedRequests: number;
}

/**
 * Server metrics for the serve command.
 */
export interface ServerMetrics {
  /** Server uptime in milliseconds */
  readonly uptimeMs: number;
  /** Total requests served */
  readonly requestCount: number;
  /** Total bytes served */
  readonly bytesServed: number;
  /** Number of errors */
  readonly errorCount: number;
}

/**
 * Complete metrics snapshot.
 */
export interface MetricsSnapshot {
  /** Timestamp when metrics were collected */
  readonly timestamp: string;
  /** Download statistics */
  readonly download: DownloadMetrics;
  /** Worker thread usage */
  readonly workerThread: WorkerThreadMetrics;
  /** Adaptive concurrency statistics */
  readonly adaptiveConcurrency: AdaptiveConcurrencyMetrics;
  /** Compression savings */
  readonly compression: CompressionMetrics;
  /** Server metrics (if applicable) */
  readonly server: ServerMetrics;
}

/**
 * Metrics collector for tracking performance statistics.
 *
 * @example
 * ```typescript
 * import { metrics } from './metrics';
 *
 * // Record a download
 * metrics.recordDownload(1024, 500); // 1024 bytes in 500ms
 *
 * // Record worker usage
 * metrics.recordWorkerUsage(1000000, 250); // 1MB in 250ms
 *
 * // Get all metrics
 * const stats = metrics.getMetrics();
 * console.log(stats.download.averageSpeed);
 * ```
 */
export class Metrics {
  // Download tracking
  private _requestCount = 0;
  private _totalBytesDownloaded = 0;
  private _totalDownloadTimeMs = 0;
  private _peakSpeed = 0;
  private _failedRequests = 0;
  private _retriedRequests = 0;

  // Worker thread tracking
  private _workerCount = 0;
  private _workerTotalTimeMs = 0;
  private _workerTotalBytes = 0;

  // Adaptive concurrency tracking
  private _concurrencyIncreases = 0;
  private _concurrencyDecreases = 0;
  private _currentConcurrency = 1;
  private _peakConcurrency = 1;

  // Compression tracking
  private _compressedBytes = 0;
  private _uncompressedBytes = 0;
  private _compressionCount = 0;

  // Server tracking
  private _serverStartTime = 0;
  private _serverRequestCount = 0;
  private _serverBytesServed = 0;
  private _serverErrorCount = 0;

  /**
   * Record a download operation.
   *
   * @param bytes - Number of bytes downloaded
   * @param durationMs - Time taken in milliseconds
   */
  recordDownload(bytes: number, durationMs: number): void {
    this._requestCount++;
    this._totalBytesDownloaded += bytes;
    this._totalDownloadTimeMs += durationMs;

    if (durationMs > 0) {
      const speed = (bytes / durationMs) * 1000;
      if (speed > this._peakSpeed) {
        this._peakSpeed = speed;
      }
    }
  }

  /**
   * Record a failed request.
   */
  recordFailedRequest(): void {
    this._failedRequests++;
  }

  /**
   * Record a retried request.
   */
  recordRetry(): void {
    this._retriedRequests++;
  }

  /**
   * Record worker thread usage.
   *
   * @param bytes - Number of bytes encoded
   * @param durationMs - Time taken in milliseconds
   */
  recordWorkerUsage(bytes: number, durationMs: number): void {
    this._workerCount++;
    this._workerTotalTimeMs += durationMs;
    this._workerTotalBytes += bytes;
  }

  /**
   * Record a concurrency increase.
   *
   * @param newLevel - The new concurrency level
   */
  recordConcurrencyIncrease(newLevel: number): void {
    this._concurrencyIncreases++;
    this._currentConcurrency = newLevel;
    if (newLevel > this._peakConcurrency) {
      this._peakConcurrency = newLevel;
    }
  }

  /**
   * Record a concurrency decrease.
   *
   * @param newLevel - The new concurrency level
   */
  recordConcurrencyDecrease(newLevel: number): void {
    this._concurrencyDecreases++;
    this._currentConcurrency = newLevel;
  }

  /**
   * Record compression savings.
   *
   * @param uncompressedSize - Size before compression
   * @param compressedSize - Size after compression
   */
  recordCompression(uncompressedSize: number, compressedSize: number): void {
    this._compressionCount++;
    this._uncompressedBytes += uncompressedSize;
    this._compressedBytes += compressedSize;
  }

  /**
   * Start server metrics tracking.
   */
  startServer(): void {
    this._serverStartTime = Date.now();
    this._serverRequestCount = 0;
    this._serverBytesServed = 0;
    this._serverErrorCount = 0;
  }

  /**
   * Record a server request.
   *
   * @param bytesServed - Number of bytes served
   */
  recordServerRequest(bytesServed: number): void {
    this._serverRequestCount++;
    this._serverBytesServed += bytesServed;
  }

  /**
   * Record a server error.
   */
  recordServerError(): void {
    this._serverErrorCount++;
  }

  /**
   * Get current download metrics.
   */
  getDownloadMetrics(): DownloadMetrics {
    const averageSpeed =
      this._totalDownloadTimeMs > 0
        ? (this._totalBytesDownloaded / this._totalDownloadTimeMs) * 1000
        : 0;

    return {
      requestCount: this._requestCount,
      totalBytesDownloaded: this._totalBytesDownloaded,
      averageSpeed,
      peakSpeed: this._peakSpeed,
      failedRequests: this._failedRequests,
      retriedRequests: this._retriedRequests,
    };
  }

  /**
   * Get current worker thread metrics.
   */
  getWorkerThreadMetrics(): WorkerThreadMetrics {
    const avgEncodingSpeed =
      this._workerTotalTimeMs > 0
        ? (this._workerTotalBytes / this._workerTotalTimeMs) * 1000
        : 0;

    return {
      count: this._workerCount,
      totalTimeMs: this._workerTotalTimeMs,
      avgEncodingSpeed,
      totalBytesEncoded: this._workerTotalBytes,
    };
  }

  /**
   * Get current adaptive concurrency metrics.
   */
  getAdaptiveConcurrencyMetrics(): AdaptiveConcurrencyMetrics {
    return {
      increases: this._concurrencyIncreases,
      decreases: this._concurrencyDecreases,
      currentLevel: this._currentConcurrency,
      peakLevel: this._peakConcurrency,
    };
  }

  /**
   * Get current compression metrics.
   */
  getCompressionMetrics(): CompressionMetrics {
    const ratio =
      this._uncompressedBytes > 0
        ? this._compressedBytes / this._uncompressedBytes
        : 0;

    return {
      compressedBytes: this._compressedBytes,
      uncompressedBytes: this._uncompressedBytes,
      ratio,
      compressionCount: this._compressionCount,
    };
  }

  /**
   * Get current server metrics.
   */
  getServerMetrics(): ServerMetrics {
    const uptimeMs =
      this._serverStartTime > 0 ? Date.now() - this._serverStartTime : 0;

    return {
      uptimeMs,
      requestCount: this._serverRequestCount,
      bytesServed: this._serverBytesServed,
      errorCount: this._serverErrorCount,
    };
  }

  /**
   * Get all metrics as a snapshot.
   */
  getMetrics(): MetricsSnapshot {
    return {
      timestamp: new Date().toISOString(),
      download: this.getDownloadMetrics(),
      workerThread: this.getWorkerThreadMetrics(),
      adaptiveConcurrency: this.getAdaptiveConcurrencyMetrics(),
      compression: this.getCompressionMetrics(),
      server: this.getServerMetrics(),
    };
  }

  /**
   * Reset all metrics to initial values.
   */
  reset(): void {
    // Download tracking
    this._requestCount = 0;
    this._totalBytesDownloaded = 0;
    this._totalDownloadTimeMs = 0;
    this._peakSpeed = 0;
    this._failedRequests = 0;
    this._retriedRequests = 0;

    // Worker thread tracking
    this._workerCount = 0;
    this._workerTotalTimeMs = 0;
    this._workerTotalBytes = 0;

    // Adaptive concurrency tracking
    this._concurrencyIncreases = 0;
    this._concurrencyDecreases = 0;
    this._currentConcurrency = 1;
    this._peakConcurrency = 1;

    // Compression tracking
    this._compressedBytes = 0;
    this._uncompressedBytes = 0;
    this._compressionCount = 0;

    // Server tracking (don't reset start time if server is running)
    this._serverRequestCount = 0;
    this._serverBytesServed = 0;
    this._serverErrorCount = 0;
  }
}

/**
 * Singleton metrics instance for global access.
 */
export const metrics = new Metrics();
