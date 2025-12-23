/**
 * Snapshot generator module for Zcash Bao Snapshots.
 *
 * This module provides tools for connecting to zcashd and generating
 * Bao-encoded snapshots of tree states and compact blocks.
 *
 * @packageDocumentation
 */

export { ZcashRpcClient } from './rpc-client.js';

export {
  RpcError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  MethodNotFoundError,
  WarmupError,
  MaxRetriesExceededError,
  isRetryable,
} from './errors.js';

export { SnapshotGenerator, SnapshotError } from './snapshot.js';
