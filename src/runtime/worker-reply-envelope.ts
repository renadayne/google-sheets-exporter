/**
 * T36b3 Safe Worker Reply Envelope Parser
 *
 * Bounded prerequisite for dedicated export worker: parses and validates the outer
 * reply envelope across the postMessage worker boundary.
 *
 * CRITICAL INVARIANTS:
 * 1. Validates ONLY the outer reply envelope structure (protocolVersion, jobId, generation, type, and variant fields).
 * 2. STAGED_ARTIFACTS.artifacts stays UNKNOWN and is NOT traversed, cloned, frozen, or asserted. Reference identity is preserved.
 * 3. Does NOT authorize acceptance, storage, or publication. Caller must:
 *    - Validate ownership, byte caps, and artifact schema before accepting staged artifacts.
 *    - Match active jobId and monotonic generation before accepting replies.
 * 4. This parser is NOT a WorkerResponse type guard; compile-time checks are erased at runtime.
 * 5. Hostile proxies, descriptor traps, or throwing reads fail null, never raw exceptions.
 */

import { isErrorCode, type ErrorCode } from '../contracts/errors.ts';
import type { WorkerPhase } from '../contracts/messages.ts';

export type ParsedWorkerAckReply = Readonly<{
  protocolVersion: 1;
  jobId: string;
  generation: number;
  type: 'ACK';
  phase?: WorkerPhase;
  chunksCompleted?: number;
  totalChunks?: number;
}>;

export type ParsedWorkerProgressReply = Readonly<{
  protocolVersion: 1;
  jobId: string;
  generation: number;
  type: 'PROGRESS';
  phase: WorkerPhase;
  chunksCompleted: number;
  totalChunks?: number;
}>;

export type ParsedWorkerStagedArtifactsReply = Readonly<{
  protocolVersion: 1;
  jobId: string;
  generation: number;
  type: 'STAGED_ARTIFACTS';
  artifacts: unknown;
}>;

export type ParsedWorkerErrorReply = Readonly<{
  protocolVersion: 1;
  jobId: string;
  generation: number;
  type: 'ERROR';
  code: ErrorCode;
  sheetId?: number;
  r?: number;
  c?: number;
}>;

export type ParsedWorkerCancelledReply = Readonly<{
  protocolVersion: 1;
  jobId: string;
  generation: number;
  type: 'CANCELLED';
}>;

export type ParsedWorkerReply =
  | ParsedWorkerAckReply
  | ParsedWorkerProgressReply
  | ParsedWorkerStagedArtifactsReply
  | ParsedWorkerErrorReply
  | ParsedWorkerCancelledReply;

/**
 * Forbidden auth, credential, and principal fields that must never appear on a worker reply envelope
 * or prototype chain.
 */
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

/**
 * Forbidden progress fields that must never appear on ACK or PROGRESS envelopes or prototype chain.
 */
const FORBIDDEN_PROGRESS_FIELDS: readonly string[] = Object.freeze([
  'percent',
  'percentage',
]);

/**
 * Forbidden error fields that must never appear on ERROR envelopes or prototype chain.
 */
const FORBIDDEN_ERROR_FIELDS: readonly string[] = Object.freeze([
  'message',
  'stack',
  'body',
  'cause',
  'error',
]);

const CANCELLED_REQUIRED_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
]);
const CANCELLED_ALLOWED_KEYS: ReadonlySet<string> = new Set(CANCELLED_REQUIRED_KEYS);

const STAGED_ARTIFACTS_REQUIRED_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'artifacts',
]);
const STAGED_ARTIFACTS_ALLOWED_KEYS: ReadonlySet<string> = new Set(STAGED_ARTIFACTS_REQUIRED_KEYS);

const ACK_REQUIRED_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
]);
const ACK_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'phase',
  'chunksCompleted',
  'totalChunks',
]);

const PROGRESS_REQUIRED_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'phase',
  'chunksCompleted',
]);
const PROGRESS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'phase',
  'chunksCompleted',
  'totalChunks',
]);

const ERROR_REQUIRED_KEYS: readonly string[] = Object.freeze([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'code',
]);
const ERROR_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'protocolVersion',
  'jobId',
  'generation',
  'type',
  'code',
  'sheetId',
  'r',
  'c',
]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

function isValidPhase(phase: unknown): phase is WorkerPhase {
  return (
    phase === 'begin' ||
    phase === 'append' ||
    phase === 'serializing' ||
    phase === 'finalizing'
  );
}

/**
 * Parses and verifies a worker response reply envelope.
 *
 * Requirements enforced:
 * - Input must be a plain own record (Object.prototype or null prototype), not array, class, or primitive.
 * - Bound own keys between 4 and 8 BEFORE reading any property descriptors.
 * - No Symbol properties allowed.
 * - All envelope-level accessors (getters/setters) are rejected WITHOUT invocation by inspecting own descriptors.
 * - Only enumerable own DATA fields are accepted.
 * - Captures each data descriptor exactly once; no direct input reread or hasOwnProperty re-trap after snapshot.
 * - Exact actual keys per variant including optional keys (no known field count shortcuts).
 * - Forbidden auth fields rejected even via prototype pollution using has checks without value access.
 * - protocolVersion must be exactly 1.
 * - jobId must be a primitive non-empty string (opaque, preserved verbatim).
 * - generation must be a finite safe integer >= 0, rejecting -0.
 * - CANCELLED: exact 4 base keys.
 * - ACK: optional phase ('begin'|'append'|'serializing'|'finalizing'), chunksCompleted, totalChunks.
 *   If present, must be valid (undefined rejected). If both counters present, totalChunks >= chunksCompleted.
 *   Absent fields are omitted from returned wrapper. percent/percentage rejected even if undefined.
 * - PROGRESS: requires phase and chunksCompleted; optional totalChunks >= chunksCompleted.
 * - ERROR: requires code from error catalog; optional independent sheetId, r, c (safe non-negative integers, no -0).
 *   Rejects message, stack, body, cause, error, or unknown codes.
 * - STAGED_ARTIFACTS: exact 4 base keys + artifacts slot. artifacts remains typed unknown, untraversed,
 *   uncloned, unfrozen, with reference identity preserved.
 * - Returns a new frozen plain wrapper; never freezes input.
 * - On any failure or throwing trap/proxy, returns null safely.
 */
export function parseWorkerReply(input: unknown): ParsedWorkerReply | null {
  try {
    if (typeof input !== 'object' || input === null) {
      return null;
    }

    if (Array.isArray(input)) {
      return null;
    }

    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length < 4 || ownKeys.length > 8) {
      return null;
    }

    const ownNames: string[] = [];
    for (let i = 0; i < ownKeys.length; i++) {
      const key = ownKeys[i]!;
      if (typeof key !== 'string') {
        return null;
      }
      ownNames.push(key);
    }

    const captured: Record<string, unknown> = Object.create(null);

    for (let i = 0; i < ownNames.length; i++) {
      const key = ownNames[i]!;
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (!desc) {
        return null;
      }
      if (!desc.enumerable) {
        return null;
      }
      if (typeof desc.get !== 'undefined' || typeof desc.set !== 'undefined') {
        return null;
      }
      if (!('value' in desc)) {
        return null;
      }
      captured[key] = desc.value;
    }

    if (
      !('protocolVersion' in captured) ||
      !('jobId' in captured) ||
      !('generation' in captured) ||
      !('type' in captured)
    ) {
      return null;
    }

    if (captured['protocolVersion'] !== 1) {
      return null;
    }

    const jobId = captured['jobId'];
    if (typeof jobId !== 'string' || jobId.length === 0) {
      return null;
    }

    const generation = captured['generation'];
    if (!isSafeNonNegativeInteger(generation)) {
      return null;
    }

    const type = captured['type'];
    if (
      type !== 'ACK' &&
      type !== 'PROGRESS' &&
      type !== 'STAGED_ARTIFACTS' &&
      type !== 'ERROR' &&
      type !== 'CANCELLED'
    ) {
      return null;
    }

    let requiredKeys: readonly string[];
    let allowedKeys: ReadonlySet<string>;

    switch (type) {
      case 'CANCELLED':
        requiredKeys = CANCELLED_REQUIRED_KEYS;
        allowedKeys = CANCELLED_ALLOWED_KEYS;
        break;
      case 'STAGED_ARTIFACTS':
        requiredKeys = STAGED_ARTIFACTS_REQUIRED_KEYS;
        allowedKeys = STAGED_ARTIFACTS_ALLOWED_KEYS;
        break;
      case 'ACK':
        requiredKeys = ACK_REQUIRED_KEYS;
        allowedKeys = ACK_ALLOWED_KEYS;
        break;
      case 'PROGRESS':
        requiredKeys = PROGRESS_REQUIRED_KEYS;
        allowedKeys = PROGRESS_ALLOWED_KEYS;
        break;
      case 'ERROR':
        requiredKeys = ERROR_REQUIRED_KEYS;
        allowedKeys = ERROR_ALLOWED_KEYS;
        break;
    }

    for (let i = 0; i < requiredKeys.length; i++) {
      if (!(requiredKeys[i]! in captured)) {
        return null;
      }
    }

    for (let i = 0; i < ownNames.length; i++) {
      if (!allowedKeys.has(ownNames[i]!)) {
        return null;
      }
    }

    for (let i = 0; i < FORBIDDEN_AUTH_FIELDS.length; i++) {
      if (FORBIDDEN_AUTH_FIELDS[i]! in (input as object)) {
        return null;
      }
    }

    if (type === 'ACK' || type === 'PROGRESS') {
      for (let i = 0; i < FORBIDDEN_PROGRESS_FIELDS.length; i++) {
        if (FORBIDDEN_PROGRESS_FIELDS[i]! in (input as object)) {
          return null;
        }
      }
    }

    if (type === 'ERROR') {
      for (let i = 0; i < FORBIDDEN_ERROR_FIELDS.length; i++) {
        if (FORBIDDEN_ERROR_FIELDS[i]! in (input as object)) {
          return null;
        }
      }
    }

    switch (type) {
      case 'CANCELLED':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'CANCELLED',
        });

      case 'STAGED_ARTIFACTS':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'STAGED_ARTIFACTS',
          artifacts: captured['artifacts'],
        });

      case 'ACK': {
        let phase: WorkerPhase | undefined;
        if ('phase' in captured) {
          const p = captured['phase'];
          if (!isValidPhase(p)) {
            return null;
          }
          phase = p;
        }

        let chunksCompleted: number | undefined;
        if ('chunksCompleted' in captured) {
          const cc = captured['chunksCompleted'];
          if (!isSafeNonNegativeInteger(cc)) {
            return null;
          }
          chunksCompleted = cc;
        }

        let totalChunks: number | undefined;
        if ('totalChunks' in captured) {
          const tc = captured['totalChunks'];
          if (!isSafeNonNegativeInteger(tc)) {
            return null;
          }
          totalChunks = tc;
        }

        if (typeof chunksCompleted === 'number' && typeof totalChunks === 'number') {
          if (totalChunks < chunksCompleted) {
            return null;
          }
        }

        const out: {
          protocolVersion: 1;
          jobId: string;
          generation: number;
          type: 'ACK';
          phase?: WorkerPhase;
          chunksCompleted?: number;
          totalChunks?: number;
        } = {
          protocolVersion: 1,
          jobId,
          generation,
          type: 'ACK',
        };
        if (typeof phase !== 'undefined') out.phase = phase;
        if (typeof chunksCompleted !== 'undefined') out.chunksCompleted = chunksCompleted;
        if (typeof totalChunks !== 'undefined') out.totalChunks = totalChunks;

        return Object.freeze(out);
      }

      case 'PROGRESS': {
        const p = captured['phase'];
        if (!isValidPhase(p)) {
          return null;
        }

        const cc = captured['chunksCompleted'];
        if (!isSafeNonNegativeInteger(cc)) {
          return null;
        }

        let totalChunks: number | undefined;
        if ('totalChunks' in captured) {
          const tc = captured['totalChunks'];
          if (!isSafeNonNegativeInteger(tc) || tc < cc) {
            return null;
          }
          totalChunks = tc;
        }

        const out: {
          protocolVersion: 1;
          jobId: string;
          generation: number;
          type: 'PROGRESS';
          phase: WorkerPhase;
          chunksCompleted: number;
          totalChunks?: number;
        } = {
          protocolVersion: 1,
          jobId,
          generation,
          type: 'PROGRESS',
          phase: p,
          chunksCompleted: cc,
        };
        if (typeof totalChunks !== 'undefined') out.totalChunks = totalChunks;

        return Object.freeze(out);
      }

      case 'ERROR': {
        const code = captured['code'];
        if (!isErrorCode(code)) {
          return null;
        }

        let sheetId: number | undefined;
        if ('sheetId' in captured) {
          const s = captured['sheetId'];
          if (!isSafeNonNegativeInteger(s)) {
            return null;
          }
          sheetId = s;
        }

        let r: number | undefined;
        if ('r' in captured) {
          const row = captured['r'];
          if (!isSafeNonNegativeInteger(row)) {
            return null;
          }
          r = row;
        }

        let c: number | undefined;
        if ('c' in captured) {
          const col = captured['c'];
          if (!isSafeNonNegativeInteger(col)) {
            return null;
          }
          c = col;
        }

        const out: {
          protocolVersion: 1;
          jobId: string;
          generation: number;
          type: 'ERROR';
          code: ErrorCode;
          sheetId?: number;
          r?: number;
          c?: number;
        } = {
          protocolVersion: 1,
          jobId,
          generation,
          type: 'ERROR',
          code,
        };
        if (typeof sheetId !== 'undefined') out.sheetId = sheetId;
        if (typeof r !== 'undefined') out.r = r;
        if (typeof c !== 'undefined') out.c = c;

        return Object.freeze(out);
      }
    }
  } catch {
    return null;
  }
}
