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
  /** The data to encode as a base64 string */
  dataBase64: string;
  /** Encoding mode: 'combined' or 'outboard' */
  mode: 'combined' | 'outboard';
  /** Whether to use Iroh-compatible encoding */
  irohCompatible: boolean;
}

interface WorkerOutput {
  /** Whether the operation succeeded */
  success: boolean;
  /** The encoded data (combined mode) or outboard hash tree (outboard mode) as base64 */
  encodedBase64?: string;
  /** The BLAKE3 Bao root hash as base64 */
  hashBase64?: string;
  /** The original data as base64 (only in outboard mode) */
  dataBase64?: string;
  /** Error message if failed */
  error?: string;
}

async function runWorker(): Promise<void> {
  if (!parentPort) {
    throw new Error('This file must be run as a worker thread');
  }

  const input = workerData as WorkerInput;

  try {
    // Decode input data from base64
    const data = Buffer.from(input.dataBase64, 'base64');

    let result: WorkerOutput;

    if (input.mode === 'outboard' && input.irohCompatible) {
      // Use Iroh-compatible encoding (16KB chunk groups)
      const encoded = await baoEncodeIroh(data);
      result = {
        success: true,
        encodedBase64: Buffer.from(encoded.outboard).toString('base64'),
        hashBase64: Buffer.from(encoded.hash).toString('base64'),
        dataBase64: input.dataBase64,
      };
    } else if (input.mode === 'outboard') {
      // Standard outboard encoding
      const encoded = await baoEncode(data, { outboard: true });
      result = {
        success: true,
        encodedBase64: Buffer.from(encoded.outboard).toString('base64'),
        hashBase64: Buffer.from(encoded.hash).toString('base64'),
        dataBase64: input.dataBase64,
      };
    } else {
      // Combined mode (default)
      const encoded = await baoEncode(data);
      result = {
        success: true,
        encodedBase64: Buffer.from(encoded.encoded).toString('base64'),
        hashBase64: Buffer.from(encoded.hash).toString('base64'),
      };
    }

    parentPort.postMessage(result);
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
