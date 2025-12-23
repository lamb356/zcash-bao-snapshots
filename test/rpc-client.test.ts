/**
 * Unit tests for the ZcashRpcClient.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ZcashRpcClient,
  RpcError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  MethodNotFoundError,
  WarmupError,
  MaxRetriesExceededError,
} from '../src/generator/rpc-client.js';
import type { Logger } from '../src/types/rpc.js';

// Mock fetch globally
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

// Test logger that captures messages
function createTestLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    debug: (msg: string) => messages.push(`DEBUG: ${msg}`),
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
  };
}

// Helper to create mock Response
function createMockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

// Helper to create JSON-RPC success response
function rpcSuccess<T>(result: T, id: number = 1): unknown {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

// Helper to create JSON-RPC error response
function rpcError(code: number, message: string, id: number | null = 1): unknown {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

describe('ZcashRpcClient', () => {
  let client: ZcashRpcClient;
  let logger: Logger & { messages: string[] };

  beforeEach(() => {
    mockFetch.mockClear();
    logger = createTestLogger();
    client = new ZcashRpcClient({
      username: 'testuser',
      password: 'testpass',
      host: '127.0.0.1',
      port: 8232,
      timeout: 5000,
      maxRetries: 3,
      retryDelay: 100,
      logger,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should throw if username is missing', () => {
      expect(() => {
        new ZcashRpcClient({ username: '', password: 'pass' });
      }).toThrow('RPC username and password are required');
    });

    it('should throw if password is missing', () => {
      expect(() => {
        new ZcashRpcClient({ username: 'user', password: '' });
      }).toThrow('RPC username and password are required');
    });

    it('should use default values for optional config', () => {
      const minimalClient = new ZcashRpcClient({
        username: 'user',
        password: 'pass',
      });
      // Client should be created without errors
      expect(minimalClient).toBeInstanceOf(ZcashRpcClient);
    });
  });

  describe('fromEnvironment', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should create client from environment variables', () => {
      process.env['ZCASH_RPC_USER'] = 'envuser';
      process.env['ZCASH_RPC_PASSWORD'] = 'envpass';
      process.env['ZCASH_RPC_HOST'] = '192.168.1.1';
      process.env['ZCASH_RPC_PORT'] = '18232';

      const envClient = ZcashRpcClient.fromEnvironment('testnet');
      expect(envClient).toBeInstanceOf(ZcashRpcClient);
    });

    it('should throw if RPC credentials not in environment', () => {
      delete process.env['ZCASH_RPC_USER'];
      delete process.env['ZCASH_RPC_PASSWORD'];

      expect(() => {
        ZcashRpcClient.fromEnvironment('mainnet');
      }).toThrow('ZCASH_RPC_USER and ZCASH_RPC_PASSWORD environment variables are required');
    });

    it('should use network-specific default port', () => {
      process.env['ZCASH_RPC_USER'] = 'user';
      process.env['ZCASH_RPC_PASSWORD'] = 'pass';

      // This should work without specifying port
      const mainnetClient = ZcashRpcClient.fromEnvironment('mainnet');
      expect(mainnetClient).toBeInstanceOf(ZcashRpcClient);
    });
  });

  describe('call', () => {
    it('should make successful RPC calls', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(12345))
      );

      const result = await client.call('getblockcount');
      expect(result).toBe(12345);
    });

    it('should include correct headers', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(12345))
      );

      await client.call('getblockcount');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8232',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: expect.stringMatching(/^Basic /),
          },
        })
      );
    });

    it('should send correct JSON-RPC request body', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess('somehash'))
      );

      await client.call('getblockhash', 1000);

      const [, options] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((options as RequestInit).body as string);

      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'getblockhash',
        params: [1000],
      });
      expect(typeof body.id).toBe('number');
    });

    it('should increment request IDs', async () => {
      mockFetch.mockResolvedValue(createMockResponse(rpcSuccess(1)));

      await client.call('getblockcount');
      await client.call('getblockcount');

      const body1 = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string
      );
      const body2 = JSON.parse(
        (mockFetch.mock.calls[1]![1] as RequestInit).body as string
      );

      expect(body2.id).toBe(body1.id + 1);
    });
  });

  describe('error handling', () => {
    it('should throw AuthenticationError on 401', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, 401)
      );

      await expect(client.call('getblockcount')).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError on 403', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({}, 403)
      );

      await expect(client.call('getblockcount')).rejects.toThrow(AuthenticationError);
    });

    it('should throw MaxRetriesExceededError with NetworkError cause on HTTP errors', async () => {
      // NetworkError is retryable, so after all retries it throws MaxRetriesExceededError
      mockFetch.mockResolvedValue(
        createMockResponse({}, 500)
      );

      try {
        await client.call('getblockcount');
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MaxRetriesExceededError);
        const maxRetriesError = error as MaxRetriesExceededError;
        expect(maxRetriesError.originalError).toBeInstanceOf(NetworkError);
      }
    });

    it('should throw MethodNotFoundError for unknown methods', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcError(-32601, 'Method not found'))
      );

      await expect(client.call('getblockcount')).rejects.toThrow(MethodNotFoundError);
    });

    it('should throw MaxRetriesExceededError with WarmupError cause when node is warming up', async () => {
      // WarmupError is retryable, so after all retries it throws MaxRetriesExceededError
      mockFetch.mockResolvedValue(
        createMockResponse(rpcError(-28, 'Verifying blocks...'))
      );

      try {
        await client.call('getblockcount');
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MaxRetriesExceededError);
        const maxRetriesError = error as MaxRetriesExceededError;
        expect(maxRetriesError.originalError).toBeInstanceOf(WarmupError);
      }
    });

    it('should throw RpcError for other RPC errors', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcError(-8, 'Invalid parameter'))
      );

      await expect(client.call('getblockcount')).rejects.toThrow(RpcError);
    });

    it('should throw on JSON parse errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as Response);

      await expect(client.call('getblockcount')).rejects.toThrow('Failed to parse JSON response');
    });

    it('should throw on missing result', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ jsonrpc: '2.0', id: 1 })
      );

      await expect(client.call('getblockcount')).rejects.toThrow('RPC response missing result');
    });
  });

  describe('retry behavior', () => {
    it('should retry on network errors', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(createMockResponse(rpcSuccess(12345)));

      const result = await client.call('getblockcount');
      expect(result).toBe(12345);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should retry on warmup errors', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(rpcError(-28, 'Warming up')))
        .mockResolvedValueOnce(createMockResponse(rpcSuccess(12345)));

      const result = await client.call('getblockcount');
      expect(result).toBe(12345);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on authentication errors', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 401));

      await expect(client.call('getblockcount')).rejects.toThrow(AuthenticationError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on method not found', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse(rpcError(-32601, 'Method not found'))
      );

      await expect(client.call('getblockcount')).rejects.toThrow(MethodNotFoundError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should throw MaxRetriesExceededError after all retries fail', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(client.call('getblockcount')).rejects.toThrow(MaxRetriesExceededError);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should log retry attempts', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(createMockResponse(rpcSuccess(12345)));

      await client.call('getblockcount');

      expect(logger.messages.some((m) => m.includes('retrying'))).toBe(true);
    });
  });

  describe('getBlockchainInfo', () => {
    it('should return blockchain info', async () => {
      const mockInfo = {
        chain: 'main',
        blocks: 1234567,
        headers: 1234567,
        bestblockhash: '0000000000000000000...',
        difficulty: 123456789,
        verificationprogress: 1.0,
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(mockInfo))
      );

      const result = await client.getBlockchainInfo();
      expect(result.blocks).toBe(1234567);
      expect(result.chain).toBe('main');
    });
  });

  describe('getBlockCount', () => {
    it('should return current block height', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(1234567))
      );

      const result = await client.getBlockCount();
      expect(result).toBe(1234567);
    });
  });

  describe('getBlockHash', () => {
    it('should return block hash for height', async () => {
      const expectedHash = '0000000000000000000abc123...';
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(expectedHash))
      );

      const result = await client.getBlockHash(1000000);
      expect(result).toBe(expectedHash);
    });
  });

  describe('getTreeState', () => {
    const mockTreeStateResponse = {
      hash: '0000000000000000000abc123',
      height: 1000000,
      time: 1609459200,
      sapling: {
        skipHash: '0000000000000000000def456',
        commitments: {
          finalRoot: 'aabbccdd...',
          finalState: '00112233...',
        },
      },
      orchard: {
        skipHash: '0000000000000000000ghi789',
        commitments: {
          finalRoot: 'eeff0011...',
          finalState: '44556677...',
        },
      },
    };

    it('should get tree state by height number', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(mockTreeStateResponse))
      );

      const result = await client.getTreeState(1000000);

      expect(result.height).toBe(1000000);
      expect(result.sapling?.finalRoot).toBe('aabbccdd...');
      expect(result.orchard?.finalRoot).toBe('eeff0011...');

      // Verify the height was passed as a string
      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string
      );
      expect(body.params[0]).toBe('1000000');
    });

    it('should get tree state by hash string', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(mockTreeStateResponse))
      );

      const result = await client.getTreeState('0000000000000000000abc123');

      expect(result.hash).toBe('0000000000000000000abc123');
    });

    it('should handle tree state without orchard', async () => {
      const saplingOnlyResponse = {
        ...mockTreeStateResponse,
        orchard: undefined,
      };

      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(saplingOnlyResponse))
      );

      const result = await client.getTreeState(419200);

      expect(result.sapling).toBeDefined();
      expect(result.orchard).toBeUndefined();
    });
  });

  describe('getTreeStateRange', () => {
    it('should fetch multiple tree states', async () => {
      // Mock responses for heights 100, 101, 102
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(
          createMockResponse(
            rpcSuccess({
              hash: `hash${100 + i}`,
              height: 100 + i,
              time: 1609459200 + i,
              sapling: {
                skipHash: 'skip',
                commitments: { finalRoot: 'root', finalState: 'state' },
              },
            })
          )
        );
      }

      const results = await client.getTreeStateRange(100, 102);

      expect(results).toHaveLength(3);
      expect(results[0]?.height).toBe(100);
      expect(results[1]?.height).toBe(101);
      expect(results[2]?.height).toBe(102);
    });

    it('should call progress callback', async () => {
      const progressCalls: [number, number][] = [];

      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce(
          createMockResponse(
            rpcSuccess({
              hash: `hash${i}`,
              height: i,
              time: 1609459200,
              sapling: {
                skipHash: 'skip',
                commitments: { finalRoot: 'root', finalState: 'state' },
              },
            })
          )
        );
      }

      await client.getTreeStateRange(0, 2, (current, total) => {
        progressCalls.push([current, total]);
      });

      expect(progressCalls).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
    });

    it('should throw on invalid range', async () => {
      await expect(client.getTreeStateRange(100, 50)).rejects.toThrow(
        'Invalid range: startHeight (100) > endHeight (50)'
      );
    });
  });

  describe('isReady', () => {
    it('should return true when node is ready', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(rpcSuccess(12345))
      );

      const ready = await client.isReady();
      expect(ready).toBe(true);
    });

    it('should return false when node is warming up', async () => {
      // Use mockResolvedValue because WarmupError is retryable
      mockFetch.mockResolvedValue(
        createMockResponse(rpcError(-28, 'Warming up'))
      );

      const ready = await client.isReady();
      expect(ready).toBe(false);
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 401));

      await expect(client.isReady()).rejects.toThrow(AuthenticationError);
    });
  });

  describe('waitForReady', () => {
    it('should resolve immediately if node is ready', async () => {
      mockFetch.mockResolvedValue(createMockResponse(rpcSuccess(12345)));

      await expect(client.waitForReady()).resolves.toBeUndefined();
    });

    it('should wait and retry if node is warming up', async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse(rpcError(-28, 'Warming up')))
        .mockResolvedValueOnce(createMockResponse(rpcError(-28, 'Warming up')))
        .mockResolvedValueOnce(createMockResponse(rpcSuccess(12345)));

      // Use short intervals for testing
      await expect(client.waitForReady(5000, 50)).resolves.toBeUndefined();
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('should throw TimeoutError if node never becomes ready', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse(rpcError(-28, 'Warming up'))
      );

      await expect(client.waitForReady(200, 50)).rejects.toThrow(TimeoutError);
    });
  });
});

describe('RpcError', () => {
  it('should create error from JSON-RPC error', () => {
    const error = RpcError.fromJsonRpcError({
      code: -8,
      message: 'Invalid parameter',
      data: { param: 'height' },
    });

    expect(error.code).toBe(-8);
    expect(error.message).toBe('Invalid parameter');
    expect(error.data).toEqual({ param: 'height' });
  });

  it('should format log string correctly', () => {
    const error = new RpcError('Test error', -100, { data: { foo: 'bar' } });
    const logString = error.toLogString();

    expect(logString).toContain('RpcError[-100]');
    expect(logString).toContain('Test error');
    expect(logString).toContain('foo');
  });
});
