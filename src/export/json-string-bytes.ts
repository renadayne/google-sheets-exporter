import { DomainError, toSafeDomainError } from '../contracts/errors.ts';

/** Provisional output budget; browser memory calibration remains pending. */
export const MAX_JSON_BYTES = 64 * 1024 * 1024;

export function countJsonStringBytes(value: string, maxBytes: number, signal: AbortSignal): number {
  if (typeof value !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    Object.is(maxBytes, -0) ||
    maxBytes > MAX_JSON_BYTES
  ) {
    throw new DomainError('CONFIG_INVALID');
  }
  let initiallyAborted: boolean;
  try {
    if (
      !signal ||
      typeof signal !== 'object' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    const aborted = signal.aborted;
    if (typeof aborted !== 'boolean') throw new DomainError('CONFIG_INVALID');
    initiallyAborted = aborted;
  } catch {
    throw new DomainError('CONFIG_INVALID');
  }
  if (initiallyAborted) throw new DomainError('OPERATION_ABORTED');

  let count = 2;
  try {
    if (count > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
    const len = value.length;
    let nextPoll = 0;
    for (let i = 0; i < len; i++) {
      if (i >= nextPoll) {
        nextPoll = i + 1024;
        if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      }
      const code = value.charCodeAt(i);
      if (code < 0x20) {
        count += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
      } else if (code === 0x22 || code === 0x5c) {
        count += 2;
      } else if (code <= 0x7f) {
        count += 1;
      } else if (code <= 0x7ff) {
        count += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 < len && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
          i++;
          count += 4;
        } else {
          count += 6;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        count += 6;
      } else {
        count += 3;
      }
      if (count > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
    }
  } catch (err) {
    throw toSafeDomainError(err);
  }
  return count;
}
