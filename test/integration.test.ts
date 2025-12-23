/**
 * Integration tests that use the actual blake3-bao library (not mocked).
 *
 * These tests verify that our code correctly integrates with blake3-bao
 * for encoding, decoding, and partial verification.
 */

import {
  baoEncode,
  baoDecode,
  baoEncodeIroh,
  PartialBao,
  BaoEncoder,
  countChunkGroups,
} from 'blake3-bao';

describe('blake3-bao integration', () => {
  describe('baoEncode and baoDecode', () => {
    it('should encode and decode small data', () => {
      const data = new TextEncoder().encode('Hello, Zcash!');

      const encoded = baoEncode(data);
      expect(encoded.encoded.length).toBeGreaterThan(data.length);
      expect(encoded.hash).toHaveLength(32);

      const decoded = baoDecode(encoded.encoded, encoded.hash);
      expect(decoded).toEqual(data);
    });

    it('should encode and decode larger data (64KB)', () => {
      // Create 64KB of random-ish data
      const data = new Uint8Array(64 * 1024);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 17 + 42) % 256;
      }

      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should encode and decode 1MB data', () => {
      const data = new Uint8Array(1024 * 1024);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 31 + 7) % 256;
      }

      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should produce deterministic output', () => {
      const data = new TextEncoder().encode('Deterministic test data');

      const encoded1 = baoEncode(data);
      const encoded2 = baoEncode(data);

      expect(encoded1.hash).toEqual(encoded2.hash);
      expect(encoded1.encoded).toEqual(encoded2.encoded);
    });
  });

  describe('outboard encoding', () => {
    it('should encode with outboard mode', () => {
      const data = new Uint8Array(8192);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      // Outboard mode: second parameter is true
      const encoded = baoEncode(data, true);

      // In outboard mode, encoded contains just the tree
      expect(encoded.encoded.length).toBeLessThan(data.length);
      expect(encoded.hash).toHaveLength(32);

      // Decode with outboard: pass original data as third parameter
      const decoded = baoDecode(encoded.encoded, encoded.hash, data);
      expect(decoded).toEqual(data);
    });

    it('should work with Iroh-compatible encoding', () => {
      const data = new Uint8Array(32 * 1024); // 32KB
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 23) % 256;
      }

      // Iroh encoding uses 16KB chunk groups
      const encoded = baoEncodeIroh(data, true); // outboard mode

      expect(encoded.hash).toHaveLength(32);

      // Iroh outboard should be smaller than standard outboard
      const standardEncoded = baoEncode(data, true);
      expect(encoded.encoded.length).toBeLessThan(standardEncoded.encoded.length);
    });
  });

  describe('streaming encoder', () => {
    it('should encode data incrementally', () => {
      const data = new Uint8Array(4096);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      // Use streaming encoder
      const encoder = new BaoEncoder();
      encoder.write(data.slice(0, 1024));
      encoder.write(data.slice(1024, 2048));
      encoder.write(data.slice(2048, 3072));
      encoder.write(data.slice(3072));

      const result = encoder.finalize();

      // Compare with one-shot encoding
      const oneShot = baoEncode(data);
      expect(result.hash).toEqual(oneShot.hash);
      expect(result.encoded).toEqual(oneShot.encoded);
    });

    it('should produce same hash regardless of chunk sizes', () => {
      const data = new Uint8Array(8192);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 7) % 256;
      }

      // Encode with different chunk sizes
      const encoder1 = new BaoEncoder();
      encoder1.write(data);
      const result1 = encoder1.finalize();

      const encoder2 = new BaoEncoder();
      for (let i = 0; i < data.length; i += 100) {
        encoder2.write(data.slice(i, Math.min(i + 100, data.length)));
      }
      const result2 = encoder2.finalize();

      expect(result1.hash).toEqual(result2.hash);
    });
  });

  describe('one-shot decode', () => {
    it('should decode encoded data correctly', () => {
      const data = new Uint8Array(4096);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncode(data);

      // One-shot decode verifies and returns data
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should detect corrupted data', () => {
      // Use larger data to ensure we have chunks to verify
      const data = new Uint8Array(4096);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      const encoded = baoEncode(data);

      // Corrupt the encoded data in the middle (where actual data is)
      const corrupted = new Uint8Array(encoded.encoded);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;

      expect(() => {
        baoDecode(corrupted, encoded.hash);
      }).toThrow();
    });
  });

  describe('PartialBao for resumable downloads', () => {
    it('should track chunk groups', () => {
      const data = new Uint8Array(64 * 1024); // 64KB = 4 chunk groups
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncodeIroh(data, true);
      const numGroups = countChunkGroups(data.length);

      expect(numGroups).toBe(4);

      const partial = new PartialBao(encoded.hash, data.length);
      expect(partial.numGroups).toBe(4);
      expect(partial.receivedGroups).toBe(0);
      expect(partial.isComplete()).toBe(false);
      expect(partial.getProgress()).toBe(0);
    });

    it('should add chunk groups with trusted mode', () => {
      // Use smaller data for simpler testing
      const data = new Uint8Array(16 * 1024); // 16KB = 1 chunk group
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncodeIroh(data, true);
      const partial = new PartialBao(encoded.hash, data.length);

      expect(partial.numGroups).toBe(1);

      // Add the chunk group in trusted mode
      partial.addChunkGroupTrusted(0, data);

      expect(partial.receivedGroups).toBe(1);
      expect(partial.isComplete()).toBe(true);
      expect(partial.getProgress()).toBe(100);

      // Finalize and verify
      const result = partial.finalize();
      expect(result).toEqual(data);
    });

    it('should export and import state', () => {
      const data = new Uint8Array(32 * 1024); // 32KB = 2 chunk groups
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 3) % 256;
      }

      const encoded = baoEncodeIroh(data, true);
      const partial = new PartialBao(encoded.hash, data.length);

      // Add first chunk group
      partial.addChunkGroupTrusted(0, data.slice(0, 16 * 1024));

      expect(partial.receivedGroups).toBe(1);
      expect(partial.hasGroup(0)).toBe(true);
      expect(partial.hasGroup(1)).toBe(false);

      // Export state
      const state = partial.exportState();

      // Import state into new instance
      const restored = PartialBao.importState(state);

      expect(restored.receivedGroups).toBe(1);
      expect(restored.hasGroup(0)).toBe(true);
      expect(restored.hasGroup(1)).toBe(false);

      // Complete the download
      restored.addChunkGroupTrusted(1, data.slice(16 * 1024));

      expect(restored.isComplete()).toBe(true);
      const result = restored.finalize();
      expect(result).toEqual(data);
    });

    it('should report missing ranges', () => {
      const data = new Uint8Array(64 * 1024); // 64KB = 4 chunk groups
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncodeIroh(data, true);
      const partial = new PartialBao(encoded.hash, data.length);

      // Add groups 0 and 2, leaving 1 and 3 missing
      partial.addChunkGroupTrusted(0, data.slice(0, 16 * 1024));
      partial.addChunkGroupTrusted(2, data.slice(32 * 1024, 48 * 1024));

      const missing = partial.getMissingGroups();
      expect(missing).toContain(1);
      expect(missing).toContain(3);
      expect(missing).not.toContain(0);
      expect(missing).not.toContain(2);

      const present = partial.getPresentGroups();
      expect(present).toContain(0);
      expect(present).toContain(2);
    });
  });

  describe('hash consistency', () => {
    it('should produce consistent hashes across encode methods', () => {
      const data = new Uint8Array(32768);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 13 + 5) % 256;
      }

      const combined = baoEncode(data);
      const outboard = baoEncode(data, true);

      // Same data should produce same hash regardless of encoding mode
      expect(combined.hash).toEqual(outboard.hash);
    });

    it('should produce different hashes for different data', () => {
      const data1 = new Uint8Array(1024).fill(1);
      const data2 = new Uint8Array(1024).fill(2);

      const encoded1 = baoEncode(data1);
      const encoded2 = baoEncode(data2);

      expect(encoded1.hash).not.toEqual(encoded2.hash);
    });

    it('should match streaming and one-shot encoding', () => {
      const data = new Uint8Array(8192);
      for (let i = 0; i < data.length; i++) {
        data[i] = (i * 11) % 256;
      }

      const oneShot = baoEncode(data);

      const encoder = new BaoEncoder();
      encoder.write(data);
      const streaming = encoder.finalize();

      expect(streaming.hash).toEqual(oneShot.hash);
    });
  });

  describe('edge cases', () => {
    it('should handle empty data', () => {
      const data = new Uint8Array(0);
      const encoded = baoEncode(data);

      expect(encoded.hash).toHaveLength(32);

      const decoded = baoDecode(encoded.encoded, encoded.hash);
      expect(decoded).toEqual(data);
    });

    it('should handle single byte', () => {
      const data = new Uint8Array([42]);
      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should handle data exactly one chunk (1024 bytes)', () => {
      const data = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should handle data at chunk boundary (2048 bytes)', () => {
      const data = new Uint8Array(2048);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });

    it('should handle data at chunk group boundary (16KB)', () => {
      const data = new Uint8Array(16 * 1024);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncode(data);
      const decoded = baoDecode(encoded.encoded, encoded.hash);

      expect(decoded).toEqual(data);
    });
  });

  describe('error handling', () => {
    it('should throw on hash mismatch', () => {
      const data = new TextEncoder().encode('Test data');
      const encoded = baoEncode(data);

      const wrongHash = new Uint8Array(32).fill(0);

      expect(() => {
        baoDecode(encoded.encoded, wrongHash);
      }).toThrow();
    });

    it('should throw on corrupted encoded data', () => {
      const data = new TextEncoder().encode('Test data for corruption');
      const encoded = baoEncode(data);

      const corrupted = new Uint8Array(encoded.encoded);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;

      expect(() => {
        baoDecode(corrupted, encoded.hash);
      }).toThrow();
    });

    it('should throw on truncated data', () => {
      const data = new Uint8Array(4096);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const encoded = baoEncode(data);
      const truncated = encoded.encoded.slice(0, encoded.encoded.length - 100);

      expect(() => {
        baoDecode(truncated, encoded.hash);
      }).toThrow();
    });
  });
});

// Helper function
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
