/**
 * T36b5 Safe Worker Staged Artifacts Snapshot Parser
 *
 * Bounded parser for staged export artifacts across the worker postMessage boundary.
 * Captures metadata snapshots and validates genuine binary payloads (Uint8Array or Blob)
 * under a strict local transport profile.
 *
 * CRITICAL INVARIANTS:
 * 1. Pure parser: no side-effects, timers, network, or publication authority.
 * 2. Invalid inputs, options, or throwing traps return null safely; no raw exceptions or diagnostics.
 * 3. Options captured once: maxArtifacts (1..4096 safe integer, no -0), maxBytes (0..64MiB safe integer, no -0).
 * 4. Input must be a dense Array with length 1..maxArtifacts (bounded before artifact descriptor reads).
 * 5. Array must have exact index slots 0..n-1, no sparse slots, no inherited indices, no accessors, no symbols, no extra keys.
 * 6. Artifact records must be plain (Object.prototype or null) with EXACT 5 own enumerable data keys:
 *    filename, mimeType, data, byteLength, safeSummary.
 * 7. One own-keys snapshot and one descriptor capture per key; accessors and getters rejected without invocation.
 * 8. Forbidden auth/credential fields on records, wrappers, or prototypes rejected.
 * 9. Binary data verified via native intrinsic getters to defeat own/subclass getter overrides and Proxy spoofs:
 *    - Standard Uint8Array prototype and ArrayBuffer.isView.
 *    - Backed by genuine fixed non-shared ArrayBuffer, full view (offset 0, length == buffer.byteLength).
 *    - Rejects SharedArrayBuffer, resizable ArrayBuffer, detached buffers, subviews.
 *    - Standard Blob verified via native Blob.prototype.size getter.
 * 10. byteLength must match actual intrinsic byte count. Aggregate bytes <= maxBytes without overflow.
 * 11. Zero payload copy/alloc, zero binary freezing. Retains data identity. Fresh frozen wrapper returned.
 */

import type { Artifact } from '../contracts/domain.ts';

const MAX_ALLOWED_ARTIFACTS = 4096;
const MAX_BYTES_CEILING = 64 * 1024 * 1024; // 64 MiB = 67,108,864

const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const nativeTypedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayProto, 'byteLength')?.get;
const nativeTypedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayProto, 'byteOffset')?.get;
const nativeTypedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayProto, 'buffer')?.get;

const arrayBufferProto = ArrayBuffer.prototype;
const nativeArrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(arrayBufferProto, 'byteLength')?.get;
const nativeArrayBufferResizableGetter = Object.getOwnPropertyDescriptor(arrayBufferProto, 'resizable')?.get;
const nativeArrayBufferMaxByteLengthGetter = Object.getOwnPropertyDescriptor(arrayBufferProto, 'maxByteLength')?.get;
const nativeArrayBufferDetachedGetter = Object.getOwnPropertyDescriptor(arrayBufferProto, 'detached')?.get;

const nativeBlobSizeGetter = typeof Blob !== 'undefined'
  ? Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get
  : undefined;

const FORBIDDEN_AUTH_FIELDS: readonly string[] = Object.freeze([
  'principalKey',
  'displayEmail',
  'email',
  'principal',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'headers',
  'account',
  'auth',
  'exportRequest',
]);

const REQUIRED_ARTIFACT_KEYS: ReadonlySet<string> = new Set([
  'filename',
  'mimeType',
  'data',
  'byteLength',
  'safeSummary',
]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

/**
 * Validates and captures a staged artifacts snapshot across the worker boundary.
 *
 * @param input Raw artifacts array from STAGED_ARTIFACTS envelope.
 * @param options Bounds for maxArtifacts and maxBytes.
 * @returns Frozen array of frozen Artifact wrappers preserving data identity, or null if invalid.
 */
export function parseWorkerArtifacts(
  input: unknown,
  options: { readonly maxArtifacts: number; readonly maxBytes: number }
): readonly Artifact[] | null {
  try {
    // 1. Validate options
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      return null;
    }

    const rawMaxArtifacts = options.maxArtifacts;
    const rawMaxBytes = options.maxBytes;

    if (
      !isSafeNonNegativeInteger(rawMaxArtifacts) ||
      rawMaxArtifacts < 1 ||
      rawMaxArtifacts > MAX_ALLOWED_ARTIFACTS
    ) {
      return null;
    }
    const maxArtifacts = rawMaxArtifacts;

    if (
      !isSafeNonNegativeInteger(rawMaxBytes) ||
      rawMaxBytes > MAX_BYTES_CEILING
    ) {
      return null;
    }
    const maxBytes = rawMaxBytes;

    // 2. Validate input array
    if (typeof input !== 'object' || input === null || !Array.isArray(input)) {
      return null;
    }
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return null;
    }

    // Check forbidden auth fields on input or prototype chain
    for (let i = 0; i < FORBIDDEN_AUTH_FIELDS.length; i++) {
      if (FORBIDDEN_AUTH_FIELDS[i]! in input) {
        return null;
      }
    }

    // Capture length descriptor once
    const lengthDesc = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDesc || lengthDesc.enumerable) {
      return null;
    }
    if (typeof lengthDesc.get !== 'undefined' || typeof lengthDesc.set !== 'undefined') {
      return null;
    }
    if (!('value' in lengthDesc)) {
      return null;
    }
    const rawLen = lengthDesc.value;
    if (
      !isSafeNonNegativeInteger(rawLen) ||
      rawLen < 1 ||
      rawLen > maxArtifacts
    ) {
      return null;
    }
    const inputLength = rawLen;

    // Check own keys snapshot excluding required non-enum length
    const inputOwnKeys = Reflect.ownKeys(input);
    if (inputOwnKeys.length !== inputLength + 1) {
      return null;
    }
    for (const key of inputOwnKeys) {
      if (key === 'length') continue;
      if (typeof key !== 'string') return null;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= inputLength || String(index) !== key) return null;
    }

    // Parse each artifact
    const result: Artifact[] = [];
    let cumulativeBytes = 0;

    for (let i = 0; i < inputLength; i++) {
      // Use descriptor indices instead direct reads
      const elemDesc = Object.getOwnPropertyDescriptor(input, String(i));
      if (!elemDesc || !elemDesc.enumerable) {
        return null;
      }
      if (typeof elemDesc.get !== 'undefined' || typeof elemDesc.set !== 'undefined') {
        return null;
      }
      if (!('value' in elemDesc)) {
        return null;
      }
      const rawArtifact = elemDesc.value;

      // 3. Validate artifact record
      if (typeof rawArtifact !== 'object' || rawArtifact === null || Array.isArray(rawArtifact)) {
        return null;
      }
      const artProto = Object.getPrototypeOf(rawArtifact);
      if (artProto !== Object.prototype && artProto !== null) {
        return null;
      }

      // Check forbidden auth fields on artifact or prototype chain
      for (let j = 0; j < FORBIDDEN_AUTH_FIELDS.length; j++) {
        if (FORBIDDEN_AUTH_FIELDS[j]! in rawArtifact) {
          return null;
        }
      }

      // Own keys snapshot: EXACTLY 5 own enumerable data keys
      const artOwnKeys = Reflect.ownKeys(rawArtifact);
      if (artOwnKeys.length !== 5) {
        return null;
      }
      for (let j = 0; j < 5; j++) {
        const k = artOwnKeys[j];
        if (typeof k !== 'string' || !REQUIRED_ARTIFACT_KEYS.has(k)) {
          return null;
        }
      }

      // One descriptor capture per key
      const captured: Record<string, unknown> = Object.create(null);
      for (let j = 0; j < 5; j++) {
        const k = artOwnKeys[j] as string;
        const desc = Object.getOwnPropertyDescriptor(rawArtifact, k);
        if (!desc || !desc.enumerable) {
          return null;
        }
        if (typeof desc.get !== 'undefined' || typeof desc.set !== 'undefined') {
          return null;
        }
        if (!('value' in desc)) {
          return null;
        }
        captured[k] = desc.value;
      }

      // Validate metadata primitives
      const filename = captured['filename'];
      if (typeof filename !== 'string' || filename.length === 0) {
        return null;
      }

      const mimeType = captured['mimeType'];
      if (typeof mimeType !== 'string' || mimeType.length === 0) {
        return null;
      }

      const safeSummary = captured['safeSummary'];
      if (typeof safeSummary !== 'string') {
        return null;
      }

      const byteLength = captured['byteLength'];
      if (!isSafeNonNegativeInteger(byteLength)) {
        return null;
      }

      // Capture and validate data once
      const rawData = captured['data'];
      if (typeof rawData !== 'object' || rawData === null) {
        return null;
      }

      let actualBytes: number;

      // Check Uint8Array
      if (Object.getPrototypeOf(rawData) === Uint8Array.prototype) {
        if (!ArrayBuffer.isView(rawData)) {
          return null;
        }
        if (
          !nativeTypedArrayByteLengthGetter ||
          !nativeTypedArrayByteOffsetGetter ||
          !nativeTypedArrayBufferGetter ||
          !nativeArrayBufferByteLengthGetter
        ) {
          return null;
        }

        const viewByteLength = nativeTypedArrayByteLengthGetter.call(rawData);
        const viewByteOffset = nativeTypedArrayByteOffsetGetter.call(rawData);
        const rawBuffer = nativeTypedArrayBufferGetter.call(rawData);

        if (!isSafeNonNegativeInteger(viewByteLength)) {
          return null;
        }
        if (viewByteOffset !== 0) {
          return null;
        }
        if (typeof rawBuffer !== 'object' || rawBuffer === null) {
          return null;
        }

        // Backing ArrayBuffer checks
        if (Object.getPrototypeOf(rawBuffer) !== ArrayBuffer.prototype) {
          return null;
        }
        if (typeof SharedArrayBuffer !== 'undefined' && rawBuffer instanceof SharedArrayBuffer) {
          return null;
        }

        // Intrinsic ArrayBuffer byteLength check
        const bufferByteLength = nativeArrayBufferByteLengthGetter.call(rawBuffer);
        if (
          !isSafeNonNegativeInteger(bufferByteLength) ||
          bufferByteLength !== viewByteLength
        ) {
          return null;
        }

        // Check detached buffer
        if (nativeArrayBufferDetachedGetter && nativeArrayBufferDetachedGetter.call(rawBuffer) === true) {
          return null;
        }
        // A zero-length native view also rejects detached buffers on engines
        // without ArrayBuffer.prototype.detached; it allocates no payload bytes.
        new Uint8Array(rawBuffer, 0, 0);

        // Check resizable ArrayBuffer
        if (nativeArrayBufferResizableGetter && nativeArrayBufferResizableGetter.call(rawBuffer) === true) {
          return null;
        }
        if (
          nativeArrayBufferMaxByteLengthGetter &&
          nativeArrayBufferMaxByteLengthGetter.call(rawBuffer) !== bufferByteLength
        ) {
          return null;
        }

        if (byteLength !== viewByteLength) {
          return null;
        }
        actualBytes = viewByteLength;
      } else if (
        typeof Blob !== 'undefined' &&
        Object.getPrototypeOf(rawData) === Blob.prototype
      ) {
        // Native Blob
        if (!nativeBlobSizeGetter) {
          return null;
        }
        const blobSize = nativeBlobSizeGetter.call(rawData);
        if (!isSafeNonNegativeInteger(blobSize)) {
          return null;
        }
        if (byteLength !== blobSize) {
          return null;
        }
        actualBytes = blobSize;
      } else {
        return null;
      }

      // Check cumulative bytes without overflow
      if (actualBytes > maxBytes - cumulativeBytes) {
        return null;
      }
      cumulativeBytes += actualBytes;

      // Fresh frozen artifact wrapper, preserving data identity
      result.push(
        Object.freeze({
          filename,
          mimeType,
          data: rawData as Uint8Array | Blob,
          byteLength,
          safeSummary,
        })
      );
    }

    return Object.freeze(result);
  } catch {
    return null;
  }
}
