import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { countJsonStringBytes, MAX_JSON_BYTES } from './json-string-bytes.ts';

/** Provisional resource guards; neither is a browser heap benchmark. */
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 4_000_000;

export interface EncodeFrozenJsonOptions {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

/** Encodes a frozen JSON tree; does not validate export schema, coverage or permission. */
export function encodeFrozenJson(value: unknown, options: EncodeFrozenJsonOptions): Uint8Array {
  if (typeof options !== 'object' || options === null) throw new DomainError('CONFIG_INVALID');
  let maxBytes: number;
  let signal: AbortSignal;
  let initiallyAborted: boolean;
  try {
    maxBytes = options.maxBytes;
    signal = options.signal;
    if (
      typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 || Object.is(maxBytes, -0) || maxBytes > MAX_JSON_BYTES
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (
      !signal || typeof signal !== 'object' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'
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

  let totalBytes = 0;
  let nodeCount = 0;
  const ancestors = new WeakSet<object>();

  function pass1(val: unknown, depth: number): void {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (++nodeCount > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new DomainError('SIZE_LIMIT_EXCEEDED');

    if (val === null) {
      if ((totalBytes += 4) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
      return;
    }
    if (typeof val === 'boolean') {
      if ((totalBytes += val ? 4 : 5) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
      return;
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      const numLen = (Object.is(val, -0) ? '0' : String(val)).length;
      if ((totalBytes += numLen) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
      return;
    }
    if (typeof val === 'string') {
      totalBytes += countJsonStringBytes(val, maxBytes - totalBytes, signal);
      return;
    }
    if (typeof val !== 'object') throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    if (!Object.isFrozen(val) || 'toJSON' in val || Object.getOwnPropertySymbols(val).length > 0) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }
    if (ancestors.has(val)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

    if (Array.isArray(val)) {
      if (Object.getPrototypeOf(val) !== Array.prototype) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      const lenDesc = Object.getOwnPropertyDescriptor(val, 'length');
      if (
        !lenDesc || typeof lenDesc.value !== 'number' || !Number.isSafeInteger(lenDesc.value) ||
        lenDesc.value < 0 || Object.is(lenDesc.value, -0)
      ) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }
      const len = lenDesc.value;
      if (len > MAX_JSON_NODES - nodeCount) throw new DomainError('SIZE_LIMIT_EXCEEDED');
      const minBytes = len === 0 ? 2 : 2 * len + 1;
      if (totalBytes + minBytes > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');

      const names = Object.getOwnPropertyNames(val);
      if (names.length !== len + 1) throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      totalBytes += 1;
      ancestors.add(val);
      try {
        for (let i = 0; i < len; i++) {
          const desc = Object.getOwnPropertyDescriptor(val, String(i));
          if (!desc || !desc.enumerable || 'get' in desc || 'set' in desc || !('value' in desc)) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          if (i > 0 && (totalBytes += 1) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
          pass1(desc.value, depth + 1);
        }
      } finally {
        ancestors.delete(val);
      }
      if ((totalBytes += 1) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
      return;
    }

    const proto = Object.getPrototypeOf(val);
    if (proto !== Object.prototype && proto !== null) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    const names = Object.getOwnPropertyNames(val);
    if (names.length > MAX_JSON_NODES - nodeCount) throw new DomainError('SIZE_LIMIT_EXCEEDED');
    const minBytes = names.length === 0 ? 2 : 4 * names.length + 1;
    if (totalBytes + minBytes > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');

    totalBytes += 1;
    ancestors.add(val);
    try {
      for (let i = 0; i < names.length; i++) {
        const key = names[i];
        const desc = Object.getOwnPropertyDescriptor(val, key);
        if (!desc || !desc.enumerable || 'get' in desc || 'set' in desc || !('value' in desc)) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        if (i > 0 && (totalBytes += 1) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
        totalBytes += countJsonStringBytes(key, maxBytes - totalBytes, signal);
        if ((totalBytes += 1) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
        pass1(desc.value, depth + 1);
      }
    } finally {
      ancestors.delete(val);
    }
    if ((totalBytes += 1) > maxBytes) throw new DomainError('BYTE_LIMIT_EXCEEDED');
  }

  let out: Uint8Array;
  let offset = 0;
  let encoder: TextEncoder;

  function pass2(val: unknown): void {
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
    if (val === null) {
      out[offset++] = 110; out[offset++] = 117; out[offset++] = 108; out[offset++] = 108;
      return;
    }
    if (typeof val === 'boolean') {
      if (val) {
        out[offset++] = 116; out[offset++] = 114; out[offset++] = 117; out[offset++] = 101;
      } else {
        out[offset++] = 102; out[offset++] = 97; out[offset++] = 108; out[offset++] = 115; out[offset++] = 101;
      }
      return;
    }
    if (typeof val === 'number') {
      const s = Object.is(val, -0) ? '0' : String(val);
      for (let i = 0; i < s.length; i++) out[offset++] = s.charCodeAt(i);
      return;
    }
    if (typeof val === 'string') {
      const token = JSON.stringify(val);
      const result = encoder.encodeInto(token, out.subarray(offset));
      if (result.read !== token.length) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      offset += result.written;
      return;
    }
    if (Array.isArray(val)) {
      out[offset++] = 91;
      const len = val.length;
      for (let i = 0; i < len; i++) {
        if (i > 0) out[offset++] = 44;
        pass2((val as readonly unknown[])[i]);
      }
      out[offset++] = 93;
      return;
    }
    out[offset++] = 123;
    const names = Object.getOwnPropertyNames(val as object);
    for (let i = 0; i < names.length; i++) {
      if (i > 0) out[offset++] = 44;
      const key = names[i];
      const token = JSON.stringify(key);
      const result = encoder.encodeInto(token, out.subarray(offset));
      if (result.read !== token.length) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      offset += result.written;
      out[offset++] = 58;
      const desc = Object.getOwnPropertyDescriptor(val as object, key)!;
      pass2(desc.value);
    }
    out[offset++] = 125;
  }

  try {
    pass1(value, 1);
    out = new Uint8Array(totalBytes);
    encoder = new TextEncoder();
    pass2(value);
    if (offset !== totalBytes) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
  } catch (err) {
    throw toSafeDomainError(err);
  }

  return out;
}
