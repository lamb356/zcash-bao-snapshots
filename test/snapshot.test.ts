/**
 * Unit tests for the SnapshotGenerator.
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import { rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TreeState } from '../src/types/zcash.js';
import type { SnapshotProgress, SnapshotMetadata } from '../src/types/snapshot.js';
import { SNAPSHOT_FORMAT_VERSION } from '../src/types/snapshot.js';

// We need to mock blake3-bao before importing SnapshotGenerator
const mockBaoEncode = jest.fn();
const mockBaoEncodeIroh = jest.fn();

jest.unstable_mockModule('blake3-bao', () => ({
  baoEncode: mockBaoEncode,
  baoEncodeIroh: mockBaoEncodeIroh,
}));

// Import after mocking
const { SnapshotGenerator, SnapshotError } = await import('../src/generator/snapshot.js');
type ZcashRpcClient = import('../src/generator/rpc-client.js').ZcashRpcClient;

// Mock tree state response
const mockTreeState: TreeState = {
  hash: '0000000000000000000abc123def456',
  height: 2000000,
  time: 1700000000,
  sapling: {
    finalRoot: 'aabbccdd11223344',
    tree: '00112233445566778899',
  },
  orchard: {
    finalRoot: 'eeff001122334455',
    tree: 'aabbccddeeff0011',
  },
};

// Mock RPC client
function createMockClient(treeState: TreeState = mockTreeState): ZcashRpcClient {
  return {
    getTreeState: jest.fn(async () => treeState),
    getBlockCount: jest.fn(async () => 2000000),
    getBlockHash: jest.fn(async () => '0000000000000000000abc123def456'),
    getBlockchainInfo: jest.fn(async () => ({ blocks: 2000000 })),
  } as unknown as ZcashRpcClient;
}

describe('SnapshotGenerator', () => {
  let outputDir: string;

  beforeAll(() => {
    // Setup default mock implementations
    mockBaoEncode.mockImplementation(async (data: Uint8Array, options?: { outboard?: boolean }) => {
      const hash = new Uint8Array(32).fill(0xab);
      if (options?.outboard) {
        return {
          outboard: new Uint8Array([0x01, 0x02, 0x03]),
          hash,
        };
      }
      return {
        encoded: new Uint8Array([...data, 0xff, 0xfe]),
        hash,
      };
    });

    mockBaoEncodeIroh.mockImplementation(async () => ({
      outboard: new Uint8Array([0x04, 0x05, 0x06]),
      hash: new Uint8Array(32).fill(0xcd),
    }));
  });

  beforeEach(async () => {
    outputDir = join(tmpdir(), `zcash-bao-test-${Date.now()}`);
    jest.clearAllMocks();

    // Re-setup mocks after clearing
    mockBaoEncode.mockImplementation(async (data: Uint8Array, options?: { outboard?: boolean }) => {
      const hash = new Uint8Array(32).fill(0xab);
      if (options?.outboard) {
        return {
          outboard: new Uint8Array([0x01, 0x02, 0x03]),
          hash,
        };
      }
      return {
        encoded: new Uint8Array([...data, 0xff, 0xfe]),
        hash,
      };
    });

    mockBaoEncodeIroh.mockImplementation(async () => ({
      outboard: new Uint8Array([0x04, 0x05, 0x06]),
      hash: new Uint8Array(32).fill(0xcd),
    }));
  });

  afterEach(async () => {
    // Clean up test output directory
    try {
      await rm(outputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createSnapshot', () => {
    it('should create a combined mode snapshot', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
        network: 'mainnet',
        mode: 'combined',
      });

      // Check result structure
      expect(result.baoPath).toBe(join(outputDir, '2000000.bao'));
      expect(result.metadataPath).toBe(join(outputDir, '2000000.metadata.json'));
      expect(result.dataPath).toBeUndefined();
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

      // Check metadata
      expect(result.metadata.version).toBe(SNAPSHOT_FORMAT_VERSION);
      expect(result.metadata.type).toBe('tree-state');
      expect(result.metadata.network).toBe('mainnet');
      expect(result.metadata.height).toBe(2000000);
      expect(result.metadata.outboard).toBe(false);
      expect(result.metadata.rootHash).toHaveLength(64); // 32 bytes hex

      // Verify files exist
      await expect(access(result.baoPath)).resolves.toBeUndefined();
      await expect(access(result.metadataPath)).resolves.toBeUndefined();
    });

    it('should create an outboard mode snapshot', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
        network: 'mainnet',
        mode: 'outboard',
      });

      // Check result structure
      expect(result.baoPath).toBe(join(outputDir, '2000000.bao'));
      expect(result.metadataPath).toBe(join(outputDir, '2000000.metadata.json'));
      expect(result.dataPath).toBe(join(outputDir, '2000000.data'));

      // Check metadata
      expect(result.metadata.outboard).toBe(true);
      expect(result.metadata.irohCompatible).toBe(false);

      // Verify files exist
      await expect(access(result.baoPath)).resolves.toBeUndefined();
      await expect(access(result.metadataPath)).resolves.toBeUndefined();
      await expect(access(result.dataPath!)).resolves.toBeUndefined();
    });

    it('should create an Iroh-compatible outboard snapshot', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
        network: 'mainnet',
        mode: 'outboard',
        irohCompatible: true,
      });

      // Check metadata
      expect(result.metadata.outboard).toBe(true);
      expect(result.metadata.irohCompatible).toBe(true);

      // Verify Iroh encoding was used
      expect(mockBaoEncodeIroh).toHaveBeenCalled();
    });

    it('should include description in metadata when provided', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
        description: 'Test snapshot for mainnet',
      });

      expect(result.metadata.description).toBe('Test snapshot for mainnet');
    });

    it('should include tree roots in metadata', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
      });

      expect(result.metadata.saplingRoot).toBe('aabbccdd11223344');
      expect(result.metadata.orchardRoot).toBe('eeff001122334455');
    });

    it('should handle tree state without orchard', async () => {
      const saplingOnlyState: TreeState = {
        hash: '0000000000000000000abc123',
        height: 1000000,
        time: 1600000000,
        sapling: {
          finalRoot: 'aabbccdd',
          tree: '00112233',
        },
      };

      const client = createMockClient(saplingOnlyState);
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 1000000,
        outputDir,
      });

      expect(result.metadata.saplingRoot).toBe('aabbccdd');
      expect(result.metadata.orchardRoot).toBeUndefined();
    });

    it('should report progress during snapshot creation', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const progressEvents: SnapshotProgress[] = [];

      await generator.createSnapshot({
        height: 2000000,
        outputDir,
        onProgress: (progress) => progressEvents.push({ ...progress }),
      });

      // Check that all phases were reported
      const phases = progressEvents.map((p) => p.phase);
      expect(phases).toContain('fetching');
      expect(phases).toContain('serializing');
      expect(phases).toContain('encoding');
      expect(phases).toContain('writing');
      expect(phases).toContain('complete');
    });

    it('should write valid JSON metadata', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
      });

      const metadataContent = await readFile(result.metadataPath, 'utf-8');
      const metadata: SnapshotMetadata = JSON.parse(metadataContent);

      expect(metadata.version).toBe(SNAPSHOT_FORMAT_VERSION);
      expect(metadata.height).toBe(2000000);
      expect(typeof metadata.createdAt).toBe('string');
      expect(new Date(metadata.createdAt).getTime()).toBeGreaterThan(0);
    });

    it('should use default network mainnet', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
      });

      expect(result.metadata.network).toBe('mainnet');
    });

    it('should use default mode combined', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
      });

      expect(result.metadata.outboard).toBe(false);
    });
  });

  describe('createSnapshotRange', () => {
    it('should create multiple snapshots', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const results = await generator.createSnapshotRange(100, 102, {
        outputDir,
      });

      expect(results).toHaveLength(3);
      expect(results[0]?.metadata.height).toBe(100);
      expect(results[1]?.metadata.height).toBe(101);
      expect(results[2]?.metadata.height).toBe(102);
    });

    it('should include range info in progress messages', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      const progressMessages: string[] = [];

      await generator.createSnapshotRange(100, 101, {
        outputDir,
        onProgress: (p) => progressMessages.push(p.message),
      });

      // Check that range info is included
      expect(progressMessages.some((m) => m.includes('[1/2]'))).toBe(true);
      expect(progressMessages.some((m) => m.includes('[2/2]'))).toBe(true);
    });

    it('should throw on invalid range', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      await expect(
        generator.createSnapshotRange(200, 100, { outputDir })
      ).rejects.toThrow(SnapshotError);
    });
  });

  describe('error handling', () => {
    it('should throw SnapshotError when RPC fails', async () => {
      const client = {
        getTreeState: jest.fn(async () => {
          throw new Error('RPC connection failed');
        }),
      } as unknown as ZcashRpcClient;

      const generator = new SnapshotGenerator(client);

      try {
        await generator.createSnapshot({
          height: 2000000,
          outputDir,
        });
        fail('Expected SnapshotError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SnapshotError);
        const snapshotError = error as InstanceType<typeof SnapshotError>;
        expect(snapshotError.phase).toBe('fetching');
        expect(snapshotError.message).toContain('Failed to fetch tree state');
      }
    });

    it('should include original error in SnapshotError', async () => {
      const originalError = new Error('Network timeout');
      const client = {
        getTreeState: jest.fn(async () => {
          throw originalError;
        }),
      } as unknown as ZcashRpcClient;

      const generator = new SnapshotGenerator(client);

      try {
        await generator.createSnapshot({
          height: 2000000,
          outputDir,
        });
        fail('Expected SnapshotError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SnapshotError);
        const snapshotError = error as InstanceType<typeof SnapshotError>;
        expect(snapshotError.originalError).toBe(originalError);
      }
    });

    it('should handle progress callback errors gracefully', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      // This should not throw even though the callback throws
      const result = await generator.createSnapshot({
        height: 2000000,
        outputDir,
        onProgress: () => {
          throw new Error('Callback error');
        },
      });

      expect(result.metadata.height).toBe(2000000);
    });
  });

  describe('canonical serialization', () => {
    it('should produce deterministic output', async () => {
      const client = createMockClient();
      const generator = new SnapshotGenerator(client);

      // Create two snapshots and compare data files
      const outputDir1 = join(outputDir, 'run1');
      const outputDir2 = join(outputDir, 'run2');

      await generator.createSnapshot({
        height: 2000000,
        outputDir: outputDir1,
        mode: 'outboard',
      });

      await generator.createSnapshot({
        height: 2000000,
        outputDir: outputDir2,
        mode: 'outboard',
      });

      const data1 = await readFile(join(outputDir1, '2000000.data'));
      const data2 = await readFile(join(outputDir2, '2000000.data'));

      expect(data1).toEqual(data2);
    });
  });
});

describe('SnapshotError', () => {
  it('should have correct name', () => {
    const error = new SnapshotError('Test error', 'fetching');
    expect(error.name).toBe('SnapshotError');
  });

  it('should have phase property', () => {
    const error = new SnapshotError('Test error', 'encoding');
    expect(error.phase).toBe('encoding');
  });

  it('should include cause when provided', () => {
    const cause = new Error('Original error');
    const error = new SnapshotError('Test error', 'writing', { cause });
    expect(error.originalError).toBe(cause);
    expect(error.cause).toBe(cause);
  });
});
