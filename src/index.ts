/**
 * Zcash Bao Snapshots
 *
 * Bao-verified streaming of Zcash tree states for faster wallet recovery.
 *
 * This library provides tools for:
 * - Generating Bao-encoded snapshots of Zcash tree states
 * - Verifying and streaming snapshot data in browsers and Node.js
 * - Resumable downloads with verified chunk-by-chunk streaming
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // Zcash data structures
  HexString,
  BlockHash,
  TxId,
  SaplingTreeState,
  OrchardTreeState,
  TreeState,
  CompactSaplingOutput,
  CompactOrchardAction,
  CompactTransaction,
  CompactBlock,
  ChainMetadata,
  BlockRange,
  ZcashNetwork,
  NetworkConstants,

  // RPC types
  JsonRpcRequest,
  JsonRpcError,
  JsonRpcResponse,
  BlockchainInfo,
  Softfork,
  NetworkUpgrade,
  ConsensusInfo,
  BlockInfo,
  NodeInfo,
  TreeStateRpcResponse,
  RpcClientConfig,
  Logger,
  RpcMethods,
  RpcParams,
  RpcResult,

  // Snapshot types
  SnapshotType,
  BaoEncodingMode,
  SnapshotMetadata,
  SnapshotOptions,
  SnapshotProgress,
  SnapshotProgressCallback,
  SnapshotResult,
  CanonicalTreeState,
} from './types/index.js';

export {
  // Network constants
  MAINNET,
  TESTNET,
  REGTEST,
  getNetworkConstants,

  // RPC utilities
  RPC_ERROR_CODES,
  parseTreeStateResponse,

  // Snapshot constants
  SNAPSHOT_FORMAT_VERSION,
} from './types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Generator (Node.js only)
// ─────────────────────────────────────────────────────────────────────────────

export {
  ZcashRpcClient,
  RpcError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  MethodNotFoundError,
  WarmupError,
  MaxRetriesExceededError,
  isRetryable,
  SnapshotGenerator,
  SnapshotError,
} from './generator/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Verifier (Browser + Node.js)
// ─────────────────────────────────────────────────────────────────────────────

export {
  BaoVerifier,
  BaoVerifierError,
  VERIFIER_STATE_VERSION,
  MemoryStorageAdapter,
  LocalStorageAdapter,
  IndexedDBStorageAdapter,
  createStorageAdapter,
  verifyBao,
  verifyBaoData,
  verifyBaoOutboard,
  fetchAndVerifySnapshot,
} from './verifier/index.js';

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
} from './verifier/index.js';
