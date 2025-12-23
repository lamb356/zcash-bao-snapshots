/**
 * JSON-RPC types for zcashd communication.
 *
 * @packageDocumentation
 */

import type { BlockHash, HexString, TreeState } from './zcash.js';

/**
 * JSON-RPC 2.0 request object.
 */
export interface JsonRpcRequest<TParams = unknown[]> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params: TParams;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * JSON-RPC 2.0 response object.
 */
export interface JsonRpcResponse<TResult = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: TResult;
  readonly error?: JsonRpcError;
}

/**
 * Standard JSON-RPC error codes.
 */
export const RPC_ERROR_CODES = {
  /** Parse error - Invalid JSON was received */
  PARSE_ERROR: -32700,
  /** Invalid Request - The JSON sent is not a valid Request object */
  INVALID_REQUEST: -32600,
  /** Method not found - The method does not exist / is not available */
  METHOD_NOT_FOUND: -32601,
  /** Invalid params - Invalid method parameter(s) */
  INVALID_PARAMS: -32602,
  /** Internal error - Internal JSON-RPC error */
  INTERNAL_ERROR: -32603,

  // zcashd-specific error codes
  /** Misc error */
  RPC_MISC_ERROR: -1,
  /** Server is in safe mode, and command is not allowed in safe mode */
  RPC_FORBIDDEN_BY_SAFE_MODE: -2,
  /** Unexpected type was passed as parameter */
  RPC_TYPE_ERROR: -3,
  /** Invalid address or key */
  RPC_INVALID_ADDRESS_OR_KEY: -5,
  /** Ran out of memory during operation */
  RPC_OUT_OF_MEMORY: -7,
  /** Invalid, missing or duplicate parameter */
  RPC_INVALID_PARAMETER: -8,
  /** Database error */
  RPC_DATABASE_ERROR: -20,
  /** Error parsing or validating structure in raw format */
  RPC_DESERIALIZATION_ERROR: -22,
  /** General error during transaction or block submission */
  RPC_VERIFY_ERROR: -25,
  /** Transaction or block was rejected by network rules */
  RPC_VERIFY_REJECTED: -26,
  /** Transaction already in chain */
  RPC_VERIFY_ALREADY_IN_CHAIN: -27,
  /** Client still warming up */
  RPC_IN_WARMUP: -28,
  /** RPC method is deprecated */
  RPC_METHOD_DEPRECATED: -32,
} as const;

/**
 * getblockchaininfo RPC response.
 */
export interface BlockchainInfo {
  readonly chain: 'main' | 'test' | 'regtest';
  readonly blocks: number;
  readonly headers: number;
  readonly bestblockhash: BlockHash;
  readonly difficulty: number;
  readonly verificationprogress: number;
  readonly chainwork: HexString;
  readonly size_on_disk: number;
  readonly commitments: number;
  readonly softforks: readonly Softfork[];
  readonly upgrades: Record<string, NetworkUpgrade>;
  readonly consensus: ConsensusInfo;
}

/**
 * Softfork information.
 */
export interface Softfork {
  readonly id: string;
  readonly version: number;
  readonly reject: {
    readonly status: boolean;
  };
}

/**
 * Network upgrade information.
 */
export interface NetworkUpgrade {
  readonly name: string;
  readonly activationheight: number;
  readonly status: 'active' | 'pending' | 'disabled';
  readonly info: string;
}

/**
 * Consensus information.
 */
export interface ConsensusInfo {
  readonly chaintip: HexString;
  readonly nextblock: HexString;
}

/**
 * getblock RPC response (verbosity 1).
 */
export interface BlockInfo {
  readonly hash: BlockHash;
  readonly confirmations: number;
  readonly height: number;
  readonly version: number;
  readonly merkleroot: HexString;
  readonly finalsaplingroot: HexString;
  readonly finalorchardroot?: HexString;
  readonly tx: readonly TxId[];
  readonly time: number;
  readonly nonce: HexString;
  readonly solution: HexString;
  readonly bits: HexString;
  readonly difficulty: number;
  readonly chainwork: HexString;
  readonly anchor: HexString;
  readonly previousblockhash?: BlockHash;
  readonly nextblockhash?: BlockHash;
}

/**
 * Transaction ID type (matches what's in zcash.ts but avoiding circular import).
 */
type TxId = string;

/**
 * getinfo RPC response (deprecated but still useful).
 */
export interface NodeInfo {
  readonly version: number;
  readonly protocolversion: number;
  readonly walletversion?: number;
  readonly balance?: number;
  readonly blocks: number;
  readonly timeoffset: number;
  readonly connections: number;
  readonly proxy: string;
  readonly difficulty: number;
  readonly testnet: boolean;
  readonly keypoololdest?: number;
  readonly keypoolsize?: number;
  readonly paytxfee: number;
  readonly relayfee: number;
  readonly errors: string;
}

/**
 * z_gettreestate RPC response.
 * This is the raw format returned by zcashd.
 */
export interface TreeStateRpcResponse {
  readonly hash: BlockHash;
  readonly height: number;
  readonly time: number;
  readonly sapling?: {
    readonly skipHash: BlockHash;
    readonly commitments: {
      readonly finalRoot: HexString;
      readonly finalState: HexString;
    };
  };
  readonly orchard?: {
    readonly skipHash: BlockHash;
    readonly commitments: {
      readonly finalRoot: HexString;
      readonly finalState: HexString;
    };
  };
}

/**
 * Convert raw RPC tree state response to our TreeState type.
 */
export function parseTreeStateResponse(response: TreeStateRpcResponse): TreeState {
  const result: TreeState = {
    hash: response.hash,
    height: response.height,
    time: response.time,
  };

  if (response.sapling) {
    return {
      ...result,
      sapling: {
        finalRoot: response.sapling.commitments.finalRoot,
        tree: response.sapling.commitments.finalState,
      },
      ...(response.orchard
        ? {
            orchard: {
              finalRoot: response.orchard.commitments.finalRoot,
              tree: response.orchard.commitments.finalState,
            },
          }
        : {}),
    };
  }

  if (response.orchard) {
    return {
      ...result,
      orchard: {
        finalRoot: response.orchard.commitments.finalRoot,
        tree: response.orchard.commitments.finalState,
      },
    };
  }

  return result;
}

/**
 * Configuration options for the RPC client.
 */
export interface RpcClientConfig {
  /**
   * zcashd RPC host (default: 127.0.0.1).
   */
  readonly host?: string;

  /**
   * zcashd RPC port (default: 8232 for mainnet).
   */
  readonly port?: number;

  /**
   * RPC username for authentication.
   */
  readonly username: string;

  /**
   * RPC password for authentication.
   */
  readonly password: string;

  /**
   * Request timeout in milliseconds (default: 30000).
   */
  readonly timeout?: number;

  /**
   * Maximum number of retry attempts (default: 3).
   */
  readonly maxRetries?: number;

  /**
   * Base delay between retries in milliseconds (default: 1000).
   * Uses exponential backoff: delay * 2^attempt.
   */
  readonly retryDelay?: number;

  /**
   * Maximum delay between retries in milliseconds (default: 30000).
   */
  readonly maxRetryDelay?: number;

  /**
   * Whether to use HTTPS (default: false).
   */
  readonly https?: boolean;

  /**
   * Custom logger function. If not provided, logs are suppressed.
   */
  readonly logger?: Logger;
}

/**
 * Logger interface for RPC client.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * RPC method definitions with their parameter and return types.
 */
export interface RpcMethods {
  getblockchaininfo: {
    params: [];
    result: BlockchainInfo;
  };
  getblock: {
    params: [blockhash: BlockHash, verbosity?: 0 | 1 | 2];
    result: BlockInfo | HexString;
  };
  getblockhash: {
    params: [height: number];
    result: BlockHash;
  };
  getblockcount: {
    params: [];
    result: number;
  };
  getinfo: {
    params: [];
    result: NodeInfo;
  };
  z_gettreestate: {
    params: [hashOrHeight: BlockHash | string];
    result: TreeStateRpcResponse;
  };
}

/**
 * Extract parameter types for an RPC method.
 */
export type RpcParams<M extends keyof RpcMethods> = RpcMethods[M]['params'];

/**
 * Extract result type for an RPC method.
 */
export type RpcResult<M extends keyof RpcMethods> = RpcMethods[M]['result'];
