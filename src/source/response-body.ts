import { DomainError, isDomainError, toSafeDomainError } from '../contracts/errors.ts';
import type { GridTransportPayload } from '../contracts/ports.ts';

export const MAX_DECODED_BYTES_CAP = 64 * 1024 * 1024; // 64MiB
const BLOCK_SIZE = 64 * 1024; // 64KiB

export interface ReadBoundedJsonOptions {
  readonly maxDecodedBytes: number;
  readonly signal: AbortSignal;
}

function sanitizeDomainError(err: unknown): DomainError {
  try {
    if (isDomainError(err)) {
      return toSafeDomainError(err);
    }
  } catch {
    return new DomainError('INTERNAL_ERROR');
  }
  return new DomainError('NETWORK_OFFLINE');
}

/**
 * Reads a bounded JSON body from a Fetch Response stream.
 * Validates byte bounds against actual decoded stream chunks, not Content-Length headers.
 */
export async function readBoundedJson(
  response: Response,
  options: ReadBoundedJsonOptions
): Promise<GridTransportPayload> {
  if (typeof options !== 'object' || options === null || typeof response !== 'object' || response === null) {
    throw new DomainError('CONFIG_INVALID');
  }

  let maxDecodedBytes: number;
  let signal: AbortSignal;
  let isAborted: boolean;
  let addListener: unknown;
  let removeListener: unknown;

  try {
    maxDecodedBytes = options.maxDecodedBytes;
    signal = options.signal;
    if (typeof signal !== 'object' || signal === null) throw new DomainError('CONFIG_INVALID');
    isAborted = signal.aborted;
    addListener = signal.addEventListener;
    removeListener = signal.removeEventListener;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }

  if (
    typeof maxDecodedBytes !== 'number' || !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes <= 0 || maxDecodedBytes > MAX_DECODED_BYTES_CAP ||
    typeof isAborted !== 'boolean' || typeof addListener !== 'function' || typeof removeListener !== 'function'
  ) {
    throw new DomainError('CONFIG_INVALID');
  }
  if (isAborted) throw new DomainError('OPERATION_ABORTED');

  let body: unknown;
  let getReader: unknown;
  try {
    body = response.body;
    if (!body || typeof body !== 'object') throw new DomainError('SOURCE_UNSUPPORTED');
    getReader = (body as any).getReader;
  } catch {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (typeof getReader !== 'function') throw new DomainError('SOURCE_UNSUPPORTED');

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = (getReader as () => ReadableStreamDefaultReader<Uint8Array>).call(body);
  } catch {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  let pendingAbortReject: ((err: DomainError) => void) | null = null;
  const onAbort = () => {
    if (pendingAbortReject) {
      const reject = pendingAbortReject;
      pendingAbortReject = null;
      reject(new DomainError('OPERATION_ABORTED'));
    }
  };

  const blocks: Uint8Array[] = [];
  let currentBlock: Uint8Array | null = null;
  let blockOffset = 0;
  let allocatedBytes = 0;
  let totalBytes = 0;
  let streamDone = false;

  try {
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

    while (!streamDone) {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          let settled = false;
          const fail = (error: DomainError) => {
            if (settled) return;
            settled = true;
            pendingAbortReject = null;
            reject(error);
          };
          pendingAbortReject = fail;
          Promise.resolve().then(() => {
            if (settled) return;
            if (signal.aborted) { fail(new DomainError('OPERATION_ABORTED')); return; }
            return reader.read();
          }).then(
            (res) => {
              if (settled) return;
              if (!res || typeof res !== 'object') { fail(new DomainError('SOURCE_UNSUPPORTED')); return; }
              settled = true;
              pendingAbortReject = null;
              resolve(res);
            },
            () => {
              if (settled) return;
              fail(new DomainError(signal.aborted ? 'OPERATION_ABORTED' : 'NETWORK_OFFLINE'));
            }
          ).catch(() => fail(new DomainError('CONFIG_INVALID')));
        });
      } finally {
        pendingAbortReject = null;
      }

      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      if (result.done) { streamDone = true; break; }

      const value = result.value;
      if (!(value instanceof Uint8Array)) throw new DomainError('SOURCE_UNSUPPORTED');

      if (value.byteLength > 0) {
        if (totalBytes + value.byteLength > maxDecodedBytes) {
          blocks.length = 0;
          currentBlock = null;
          throw new DomainError('BYTE_LIMIT_EXCEEDED');
        }

        totalBytes += value.byteLength;
        let valueOffset = 0;
        while (valueOffset < value.byteLength) {
          if (!currentBlock || blockOffset === currentBlock.byteLength) {
            const nextSize = Math.min(maxDecodedBytes - allocatedBytes, BLOCK_SIZE);
            currentBlock = new Uint8Array(nextSize);
            allocatedBytes += nextSize;
            blocks.push(currentBlock);
            blockOffset = 0;
          }
          const toCopy = Math.min(value.byteLength - valueOffset, currentBlock.byteLength - blockOffset);
          currentBlock.set(value.subarray(valueOffset, valueOffset + toCopy), blockOffset);
          blockOffset += toCopy;
          valueOffset += toCopy;
        }
      }
    }

    if (totalBytes === 0 || signal.aborted) {
      throw new DomainError(signal.aborted ? 'OPERATION_ABORTED' : 'SOURCE_UNSUPPORTED');
    }

    let combined: Uint8Array;
    if (blocks.length === 1 && totalBytes === blocks[0].byteLength) {
      combined = blocks[0];
    } else {
      combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const block of blocks) {
        const count = Math.min(block.byteLength, totalBytes - offset);
        if (count > 0) { combined.set(block.subarray(0, count), offset); offset += count; }
      }
    }
    blocks.length = 0;
    currentBlock = null;

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(combined);
    } catch {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }

    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    return { payload, byteCount: totalBytes };
  } catch (err) {
    blocks.length = 0;
    currentBlock = null;
    let isAbortedNow = false;
    try { isAbortedNow = Boolean(signal.aborted); } catch {}
    if (isAbortedNow) throw new DomainError('OPERATION_ABORTED');
    throw sanitizeDomainError(err);
  } finally {
    try { signal.removeEventListener('abort', onAbort); } catch {}
    if (!streamDone) {
      try { reader.cancel().catch(() => {}); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}
