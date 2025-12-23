/**
 * Worker thread for Bao encoding large files.
 *
 * This worker is spawned when encoding data larger than 10MB to
 * offload the CPU-intensive work from the main thread.
 *
 * @packageDocumentation
 */

import { parentPort, workerData } from 'node:worker_threads';
import { baoEncode, baoEncodeIroh } from 'blake3-bao';

interface WorkerInput {
  /** The data to encode as ArrayBuffer (transferred, not copied) */
  dataBuffer: ArrayBuffer;
  /** Encoding mode: 'combined' or 'outboard' */
  mode: 'combined' | 'outboard';
  /** Whether to use Iroh-compatible encoding */
  irohCompatible: boolean;
}

interface WorkerOutput {
  /** Whether the operation succeeded */
  success: boolean;
  /** The encoded data as ArrayBuffer (transferred, not copied) */
  encodedBuffer?: ArrayBuffer;
  /** The BLAKE3 Bao root hash as ArrayBuffer (transferred, not copied) */
  hashBuffer?: ArrayBuffer;
  /** Error message if failed */
  error?: string;
}

async function runWorker(): Promise<void> {
  if (!parentPort) {
    throw new Error('This file must be run as a worker thread');
  }

  const input = workerData as WorkerInput;

  try {
    // Use the transferred ArrayBuffer directly
    const data = new Uint8Array(input.dataBuffer);

    let encodedBuffer: ArrayBuffer;
    let hashBuffer: ArrayBuffer;

    if (input.mode === 'outboard' && input.irohCompatible) {
      // Use Iroh-compatible encoding (16KB chunk groups)
      const encoded = await baoEncodeIroh(data);
      encodedBuffer = encoded.outboard.buffer.slice(
        encoded.outboard.byteOffset,
        encoded.outboard.byteOffset + encoded.outboard.byteLength
      );
      hashBuffer = encoded.hash.buffer.slice(
        encoded.hash.byteOffset,
        encoded.hash.byteOffset + encoded.hash.byteLength
      );
    } else if (input.mode === 'outboard') {
      // Standard outboard encoding
      const encoded = await baoEncode(data, { outboard: true });
      encodedBuffer = encoded.outboard.buffer.slice(
        encoded.outboard.byteOffset,
        encoded.outboard.byteOffset + encoded.outboard.byteLength
      );
      hashBuffer = encoded.hash.buffer.slice(
        encoded.hash.byteOffset,
        encoded.hash.byteOffset + encoded.hash.byteLength
      );
    } else {
      // Combined mode (default)
      const encoded = await baoEncode(data);
      encodedBuffer = encoded.encoded.buffer.slice(
        encoded.encoded.byteOffset,
        encoded.encoded.byteOffset + encoded.encoded.byteLength
      );
      hashBuffer = encoded.hash.buffer.slice(
        encoded.hash.byteOffset,
        encoded.hash.byteOffset + encoded.hash.byteLength
      );
    }

    const result: WorkerOutput = {
      success: true,
      encodedBuffer,
      hashBuffer,
    };

    // Transfer ownership of the buffers back to main thread
    parentPort.postMessage(result, [encodedBuffer, hashBuffer]);
  } catch (error) {
    const result: WorkerOutput = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort.postMessage(result);
  }
}

runWorker().catch((err) => {
  if (parentPort) {
    parentPort.postMessage({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
