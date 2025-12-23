/**
 * Type definitions for Zcash Bao Snapshots.
 *
 * @packageDocumentation
 */

export type {
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
} from './zcash.js';

export {
  MAINNET,
  TESTNET,
  REGTEST,
  getNetworkConstants,
} from './zcash.js';

export type {
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
} from './rpc.js';

export {
  RPC_ERROR_CODES,
  parseTreeStateResponse,
} from './rpc.js';

export type {
  SnapshotType,
  BaoEncodingMode,
  SnapshotMetadata,
  SnapshotOptions,
  SnapshotProgress,
  SnapshotProgressCallback,
  SnapshotResult,
  CanonicalTreeState,
} from './snapshot.js';

export {
  SNAPSHOT_FORMAT_VERSION,
} from './snapshot.js';
