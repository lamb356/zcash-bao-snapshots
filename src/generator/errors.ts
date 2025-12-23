/**
 * Custom error classes for the RPC client.
 *
 * @packageDocumentation
 */

import type { JsonRpcError } from '../types/rpc.js';

/**
 * Base error class for all RPC-related errors.
 */
export class RpcError extends Error {
  /**
   * Error code from the RPC response or a custom code.
   */
  readonly code: number;

  /**
   * Additional error data if provided.
   */
  readonly data?: unknown;

  /**
   * Whether this error is retryable.
   */
  readonly retryable: boolean;

  constructor(
    message: string,
    code: number,
    options?: { data?: unknown; retryable?: boolean; cause?: Error }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'RpcError';
    this.code = code;
    this.data = options?.data;
    this.retryable = options?.retryable ?? false;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Create an RpcError from a JSON-RPC error response.
   */
  static fromJsonRpcError(error: JsonRpcError): RpcError {
    const retryable = isRetryableErrorCode(error.code);
    return new RpcError(error.message, error.code, {
      data: error.data,
      retryable,
    });
  }

  /**
   * Returns a string representation of the error suitable for logging.
   */
  toLogString(): string {
    const parts = [`RpcError[${this.code}]: ${this.message}`];
    if (this.data !== undefined) {
      parts.push(`Data: ${JSON.stringify(this.data)}`);
    }
    if (this.cause) {
      parts.push(`Cause: ${String(this.cause)}`);
    }
    return parts.join(' | ');
  }
}

/**
 * Error thrown when a network request fails.
 */
export class NetworkError extends RpcError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, -1000, options?.cause
      ? { retryable: true, cause: options.cause }
      : { retryable: true });
    this.name = 'NetworkError';
  }
}

/**
 * Error thrown when a request times out.
 */
export class TimeoutError extends RpcError {
  /**
   * Timeout duration in milliseconds.
   */
  readonly timeout: number;

  constructor(message: string, timeout: number, options?: { cause?: Error }) {
    super(message, -1001, options?.cause
      ? { retryable: true, cause: options.cause }
      : { retryable: true });
    this.name = 'TimeoutError';
    this.timeout = timeout;
  }
}

/**
 * Error thrown when authentication fails.
 */
export class AuthenticationError extends RpcError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, -1002, options?.cause
      ? { retryable: false, cause: options.cause }
      : { retryable: false });
    this.name = 'AuthenticationError';
  }
}

/**
 * Error thrown when the RPC method is not found.
 */
export class MethodNotFoundError extends RpcError {
  /**
   * The method that was not found.
   */
  readonly method: string;

  constructor(method: string, options?: { cause?: Error }) {
    super(`Method '${method}' not found`, -32601, options?.cause
      ? { retryable: false, cause: options.cause }
      : { retryable: false });
    this.name = 'MethodNotFoundError';
    this.method = method;
  }
}

/**
 * Error thrown when the node is still warming up.
 */
export class WarmupError extends RpcError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, -28, options?.cause
      ? { retryable: true, cause: options.cause }
      : { retryable: true });
    this.name = 'WarmupError';
  }
}

/**
 * Error thrown when all retry attempts are exhausted.
 */
export class MaxRetriesExceededError extends RpcError {
  /**
   * Number of attempts made.
   */
  readonly attempts: number;

  /**
   * The original error that caused the retries.
   */
  readonly originalError: Error;

  constructor(attempts: number, originalError: Error) {
    super(
      `Max retries (${attempts}) exceeded: ${originalError.message}`,
      -1003,
      { retryable: false, cause: originalError }
    );
    this.name = 'MaxRetriesExceededError';
    this.attempts = attempts;
    this.originalError = originalError;
  }
}

/**
 * Check if an error code indicates a retryable error.
 */
function isRetryableErrorCode(code: number): boolean {
  // Warmup, internal errors, and some misc errors are retryable
  return code === -28 || code === -32603 || code === -1;
}

/**
 * Check if an error is retryable.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof RpcError) {
    return error.retryable;
  }

  // Network-level errors are generally retryable
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }

  // Node.js system errors
  if (error instanceof Error) {
    const syscallErrors = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
    const errorWithCode = error as Error & { code?: string };
    if (errorWithCode.code && syscallErrors.includes(errorWithCode.code)) {
      return true;
    }
  }

  return false;
}
