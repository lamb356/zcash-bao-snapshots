/**
 * zcashd JSON-RPC client with authentication, retries, and proper error handling.
 *
 * @packageDocumentation
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcClientConfig,
  Logger,
  RpcMethods,
  RpcParams,
  RpcResult,
  BlockchainInfo,
} from '../types/rpc.js';
import type { TreeState, ZcashNetwork } from '../types/zcash.js';
import { parseTreeStateResponse, RPC_ERROR_CODES } from '../types/rpc.js';
import { getNetworkConstants } from '../types/zcash.js';
import {
  RpcError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  MethodNotFoundError,
  WarmupError,
  MaxRetriesExceededError,
  isRetryable,
} from './errors.js';

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  timeout: 30000,
  maxRetries: 3,
  retryDelay: 1000,
  maxRetryDelay: 30000,
  https: false,
} as const;

/**
 * Null logger that discards all messages.
 */
const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * JSON-RPC client for communicating with zcashd.
 *
 * Features:
 * - Basic authentication support
 * - Configurable timeouts
 * - Automatic retries with exponential backoff
 * - Proper error classification and handling
 * - Connection pooling (via Node.js native fetch/undici)
 * - TypeScript strict mode compatible
 *
 * @example
 * ```typescript
 * const client = new ZcashRpcClient({
 *   username: 'user',
 *   password: 'password',
 *   port: 8232,
 * });
 *
 * const treeState = await client.getTreeState(1000000);
 * console.log(treeState.sapling?.finalRoot);
 *
 * // Clean up when done
 * client.destroy();
 * ```
 */
export class ZcashRpcClient {
  private readonly config: Required<Omit<RpcClientConfig, 'logger'>> & {
    logger: Logger;
  };
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private requestId: number = 0;

  /**
   * Create a new RPC client instance.
   *
   * @param config - Client configuration options
   * @throws {Error} If username or password is not provided
   */
  constructor(config: RpcClientConfig) {
    if (!config.username || !config.password) {
      throw new Error('RPC username and password are required');
    }

    this.config = {
      host: config.host ?? DEFAULT_CONFIG.host,
      port: config.port ?? 8232,
      username: config.username,
      password: config.password,
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      retryDelay: config.retryDelay ?? DEFAULT_CONFIG.retryDelay,
      maxRetryDelay: config.maxRetryDelay ?? DEFAULT_CONFIG.maxRetryDelay,
      https: config.https ?? DEFAULT_CONFIG.https,
      logger: config.logger ?? nullLogger,
    };

    const protocol = this.config.https ? 'https' : 'http';
    this.baseUrl = `${protocol}://${this.config.host}:${this.config.port}`;

    // Create Base64 auth header
    const credentials = `${this.config.username}:${this.config.password}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;

    this.config.logger.debug('RPC client initialized', {
      host: this.config.host,
      port: this.config.port,
    });
  }

  /**
   * Destroy the client and clean up resources.
   * Note: With native fetch, connection pooling is handled automatically by undici.
   * This method is provided for API consistency and future extensibility.
   */
  destroy(): void {
    this.config.logger.debug('RPC client destroyed');
  }

  /**
   * Create a client configured for a specific network using environment variables.
   *
   * Environment variables used:
   * - ZCASH_RPC_HOST (default: 127.0.0.1)
   * - ZCASH_RPC_PORT (default: network-specific)
   * - ZCASH_RPC_USER (required)
   * - ZCASH_RPC_PASSWORD (required)
   *
   * @param network - The Zcash network to connect to
   * @param logger - Optional logger instance
   * @returns Configured RPC client
   * @throws {Error} If required environment variables are not set
   */
  static fromEnvironment(network: ZcashNetwork, logger?: Logger): ZcashRpcClient {
    const constants = getNetworkConstants(network);
    const username = process.env['ZCASH_RPC_USER'];
    const password = process.env['ZCASH_RPC_PASSWORD'];

    if (!username || !password) {
      throw new Error(
        'ZCASH_RPC_USER and ZCASH_RPC_PASSWORD environment variables are required'
      );
    }

    const portEnv = process.env['ZCASH_RPC_PORT'];

    return new ZcashRpcClient(
      logger
        ? {
            host: process.env['ZCASH_RPC_HOST'] ?? '127.0.0.1',
            port: portEnv ? parseInt(portEnv, 10) : constants.defaultRpcPort,
            username,
            password,
            logger,
          }
        : {
            host: process.env['ZCASH_RPC_HOST'] ?? '127.0.0.1',
            port: portEnv ? parseInt(portEnv, 10) : constants.defaultRpcPort,
            username,
            password,
          }
    );
  }

  /**
   * Make a raw RPC call with full type safety.
   *
   * @param method - The RPC method to call
   * @param params - Parameters for the method
   * @returns The result of the RPC call
   * @throws {RpcError} If the RPC call fails
   */
  async call<M extends keyof RpcMethods>(
    method: M,
    ...params: RpcParams<M>
  ): Promise<RpcResult<M>> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params: params as unknown[],
    };

    this.config.logger.debug(`RPC call: ${method}`, { params });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const result = await this.executeRequest<RpcResult<M>>(request);
        this.config.logger.debug(`RPC call successful: ${method}`);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Non-retryable errors are thrown immediately
        if (!isRetryable(error)) {
          throw error;
        }

        // If we have more attempts, log and retry
        if (attempt < this.config.maxRetries - 1) {
          const delay = this.calculateBackoff(attempt);
          this.config.logger.warn(
            `RPC call failed, retrying in ${delay}ms (attempt ${attempt + 1}/${this.config.maxRetries})`,
            { method, error: lastError.message }
          );
          await this.sleep(delay);
        }
      }
    }

    // All retry attempts exhausted
    throw new MaxRetriesExceededError(
      this.config.maxRetries,
      lastError ?? new Error('Unknown error')
    );
  }

  /**
   * Execute a single RPC request without retries.
   * Uses native fetch with keepalive for connection pooling.
   */
  private async executeRequest<T>(request: JsonRpcRequest): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      let response: Response;

      try {
        response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.authHeader,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
          // Enable keep-alive for connection reuse (Node.js 18+)
          keepalive: true,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new TimeoutError(
            `Request timed out after ${this.config.timeout}ms`,
            this.config.timeout
          );
        }
        const cause = error instanceof Error ? error : undefined;
        throw new NetworkError(
          `Network request failed: ${cause?.message ?? String(error)}`,
          cause ? { cause } : undefined
        );
      }

      // Handle HTTP-level errors
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(
            `Authentication failed: ${response.status} ${response.statusText}`
          );
        }

        throw new NetworkError(
          `HTTP error: ${response.status} ${response.statusText}`
        );
      }

      // Parse JSON response
      let jsonResponse: JsonRpcResponse<T>;
      try {
        jsonResponse = (await response.json()) as JsonRpcResponse<T>;
      } catch (error) {
        const cause = error instanceof Error ? error : undefined;
        throw new RpcError(
          'Failed to parse JSON response',
          -32700,
          cause ? { cause } : undefined
        );
      }

      // Handle JSON-RPC errors
      if (jsonResponse.error) {
        const { code, message } = jsonResponse.error;

        if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
          throw new MethodNotFoundError(request.method);
        }

        if (code === RPC_ERROR_CODES.RPC_IN_WARMUP) {
          throw new WarmupError(message);
        }

        throw RpcError.fromJsonRpcError(jsonResponse.error);
      }

      if (jsonResponse.result === undefined) {
        throw new RpcError('RPC response missing result', -32603);
      }

      return jsonResponse.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Calculate exponential backoff delay.
   */
  private calculateBackoff(attempt: number): number {
    const delay = this.config.retryDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * delay; // Add 10% jitter
    return Math.min(delay + jitter, this.config.maxRetryDelay);
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // High-level API methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the current blockchain information.
   *
   * @returns Blockchain info including height, best block hash, and network upgrades
   */
  async getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call('getblockchaininfo');
  }

  /**
   * Get the current block count (chain height).
   *
   * @returns The current block height
   */
  async getBlockCount(): Promise<number> {
    return this.call('getblockcount');
  }

  /**
   * Get the block hash for a given height.
   *
   * @param height - The block height
   * @returns The block hash
   */
  async getBlockHash(height: number): Promise<string> {
    return this.call('getblockhash', height);
  }

  /**
   * Get the tree state at a specific block.
   *
   * The tree state contains the Sapling and Orchard note commitment trees
   * which are needed for wallet synchronization and spending.
   *
   * @param heightOrHash - Block height (as number or string) or block hash
   * @returns The parsed tree state
   *
   * @example
   * ```typescript
   * // Get tree state by height
   * const state = await client.getTreeState(1000000);
   *
   * // Get tree state by hash
   * const state = await client.getTreeState('00000000...');
   * ```
   */
  async getTreeState(heightOrHash: number | string): Promise<TreeState> {
    const param = typeof heightOrHash === 'number'
      ? heightOrHash.toString()
      : heightOrHash;

    const response = await this.call('z_gettreestate', param);
    return parseTreeStateResponse(response);
  }

  /**
   * Get tree states for a range of blocks.
   *
   * Fetches tree states sequentially to avoid overwhelming the RPC server.
   * For parallel fetching, use getTreeState directly with appropriate concurrency control.
   *
   * @param startHeight - Start height (inclusive)
   * @param endHeight - End height (inclusive)
   * @param onProgress - Optional progress callback
   * @returns Array of tree states
   */
  async getTreeStateRange(
    startHeight: number,
    endHeight: number,
    onProgress?: (current: number, total: number) => void
  ): Promise<TreeState[]> {
    if (startHeight > endHeight) {
      throw new Error(
        `Invalid range: startHeight (${startHeight}) > endHeight (${endHeight})`
      );
    }

    const total = endHeight - startHeight + 1;
    const results: TreeState[] = [];

    for (let height = startHeight; height <= endHeight; height++) {
      const treeState = await this.getTreeState(height);
      results.push(treeState);

      if (onProgress) {
        onProgress(results.length, total);
      }
    }

    return results;
  }

  /**
   * Check if the node is ready to accept requests.
   *
   * @returns true if the node is ready, false if warming up
   */
  async isReady(): Promise<boolean> {
    try {
      await this.getBlockCount();
      return true;
    } catch (error) {
      // Direct WarmupError
      if (error instanceof WarmupError) {
        return false;
      }
      // WarmupError wrapped in MaxRetriesExceededError after retries
      if (
        error instanceof MaxRetriesExceededError &&
        error.originalError instanceof WarmupError
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Wait for the node to be ready, with timeout.
   *
   * @param timeout - Maximum time to wait in milliseconds (default: 60000)
   * @param pollInterval - How often to check in milliseconds (default: 1000)
   * @throws {TimeoutError} If the node doesn't become ready within the timeout
   */
  async waitForReady(timeout = 60000, pollInterval = 1000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.isReady()) {
        return;
      }

      this.config.logger.info('Node is warming up, waiting...');
      await this.sleep(pollInterval);
    }

    throw new TimeoutError(
      'Timed out waiting for node to be ready',
      timeout
    );
  }
}

// Re-export error classes for convenience
export {
  RpcError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  MethodNotFoundError,
  WarmupError,
  MaxRetriesExceededError,
} from './errors.js';
