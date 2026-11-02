/**
 * T24b3b Metadata Report Snapshot and Validation Guard
 * Creates an immutable, deep-frozen plain JSON metadata copy of an ExportReport.
 * Guards against getter-mutation, non-native JSON primitives, cycles, prototype pollution,
 * and exceeds on depth/nodes.
 * Validates with isExportReport before returning.
 */

import type { ExportReport } from '../contracts/domain.ts';
import { DomainError, toSafeDomainError } from '../contracts/errors.ts';
import { isExportReport } from '../contracts/validation.ts';
import { MAX_JSON_NODES, MAX_JSON_DEPTH } from './json-encoding.ts';

export { MAX_JSON_NODES, MAX_JSON_DEPTH } from './json-encoding.ts';

export interface SnapshotExportReportOptions {
  readonly signal: AbortSignal;
  readonly maxNodes: number;
}

export function snapshotExportReport(
  input: unknown,
  options: { readonly signal: AbortSignal; readonly maxNodes: number }
): ExportReport {
  let signal: AbortSignal;
  let maxNodes: number;
  let initiallyAborted: boolean;

  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new DomainError('CONFIG_INVALID');
    }
    const { signal: rawSignal, maxNodes: rawMaxNodes } = options;
    const aborted = rawSignal?.aborted;
    if (
      typeof rawMaxNodes !== 'number' ||
      !Number.isSafeInteger(rawMaxNodes) ||
      rawMaxNodes < 1 ||
      rawMaxNodes > MAX_JSON_NODES ||
      Object.is(rawMaxNodes, -0)
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    if (
      !rawSignal ||
      typeof rawSignal !== 'object' ||
      typeof aborted !== 'boolean' ||
      typeof (rawSignal as any).addEventListener !== 'function' ||
      typeof (rawSignal as any).removeEventListener !== 'function'
    ) {
      throw new DomainError('CONFIG_INVALID');
    }
    signal = rawSignal;
    maxNodes = rawMaxNodes;
    initiallyAborted = aborted;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('CONFIG_INVALID');
  }

  // Pre-abort check
  if (initiallyAborted) {
    throw new DomainError('OPERATION_ABORTED');
  }

  try {
    let nodeCount = 0;
    const ancestors = new WeakSet<object>();

    function capture(val: unknown, depth: number): unknown {
      if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
      if (++nodeCount > maxNodes || depth > MAX_JSON_DEPTH) {
        throw new DomainError('SIZE_LIMIT_EXCEEDED');
      }

      if (val === null) return null;
      if (typeof val === 'boolean') return val;
      if (typeof val === 'number') {
        if (!Number.isFinite(val)) throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        return val;
      }
      if (typeof val === 'string') return val;
      if (typeof val !== 'object') throw new DomainError('FORMAT_SERIALIZATION_FAILED');

      if ('toJSON' in Object.prototype || 'toJSON' in Array.prototype) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (ancestors.has(val)) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      if (Array.isArray(val)) {
        if (Object.getPrototypeOf(val) !== Array.prototype) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        const ownKeys = Reflect.ownKeys(val);
        const lenDesc = Object.getOwnPropertyDescriptor(val, 'length');
        if (
          !lenDesc ||
          lenDesc.enumerable ||
          'get' in lenDesc ||
          'set' in lenDesc ||
          !('value' in lenDesc) ||
          typeof lenDesc.value !== 'number' ||
          !Number.isSafeInteger(lenDesc.value) ||
          lenDesc.value < 0 ||
          Object.is(lenDesc.value, -0)
        ) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }

        const len = lenDesc.value;
        if (len > maxNodes - nodeCount) {
          throw new DomainError('SIZE_LIMIT_EXCEEDED');
        }
        if (ownKeys.length !== len + 1) {
          throw new DomainError('FORMAT_SERIALIZATION_FAILED');
        }
        for (const key of ownKeys) {
          if (key === 'length') continue;
          if (typeof key !== 'string') throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= len || String(index) !== key) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
        }

        const copy: unknown[] = new Array(len);
        ancestors.add(val);
        try {
          for (let i = 0; i < len; i++) {
            if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
            const desc = Object.getOwnPropertyDescriptor(val, String(i));
            if (
              !desc ||
              !desc.enumerable ||
              'get' in desc ||
              'set' in desc ||
              !('value' in desc)
            ) {
              throw new DomainError('FORMAT_SERIALIZATION_FAILED');
            }
            copy[i] = capture(desc.value, depth + 1);
          }
        } finally {
          ancestors.delete(val);
        }
        return Object.freeze(copy);
      }

      const proto = Object.getPrototypeOf(val);
      if (proto !== Object.prototype && proto !== null) {
        throw new DomainError('FORMAT_SERIALIZATION_FAILED');
      }

      const ownKeys = Reflect.ownKeys(val);
      if (ownKeys.length > maxNodes - nodeCount) {
        throw new DomainError('SIZE_LIMIT_EXCEEDED');
      }

      const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
      ancestors.add(val);
      try {
        for (let i = 0; i < ownKeys.length; i++) {
          if (signal.aborted) throw new DomainError('OPERATION_ABORTED');
          const key = ownKeys[i];
          if (typeof key !== 'string') {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          const desc = Object.getOwnPropertyDescriptor(val, key);
          if (!desc) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          if ('get' in desc || 'set' in desc) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          // Non-enumerable properties on plain objects are not serialized into JSON metadata
          if (!desc.enumerable) {
            continue;
          }
          if (key === 'toJSON') {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          if (!('value' in desc)) {
            throw new DomainError('FORMAT_SERIALIZATION_FAILED');
          }
          const childVal = capture(desc.value, depth + 1);
          Object.defineProperty(copy, key, {
            value: childVal,
            enumerable: true,
            writable: true,
            configurable: true
          });
        }
      } finally {
        ancestors.delete(val);
      }
      return Object.freeze(copy);
    }

    const captured = capture(input, 0);

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    if (!isExportReport(captured)) {
      throw new DomainError('FORMAT_SERIALIZATION_FAILED');
    }

    if (signal.aborted) {
      throw new DomainError('OPERATION_ABORTED');
    }

    return captured;
  } catch (err) {
    if (err instanceof DomainError) throw toSafeDomainError(err);
    throw new DomainError('FORMAT_SERIALIZATION_FAILED');
  }
}
