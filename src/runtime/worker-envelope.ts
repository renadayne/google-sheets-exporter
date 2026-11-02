/**
 * T36b1 Safe Worker Request Envelope Parser
 *
 * Bounded prerequisite for dedicated export worker: parses and validates the outer
 * command envelope across the postMessage worker boundary.
 *
 * CRITICAL INVARIANTS:
 * 1. Validates ONLY the outer envelope structure (protocolVersion, jobId, generation, type, and payload slot key).
 * 2. Payload (context, chunk, report) remains UNKNOWN and is NOT traversed, cloned, frozen, or asserted.
 * 3. Does NOT authorize processing, execution, or publication. Caller must:
 *    - Validate and snapshot payloads using snapshotWriterContext, snapshotWriterChunk and report validators.
 *    - Enforce that for APPEND commands, `chunk.jobId === envelope.jobId`.
 *    - Verify active `jobId` and monotonic `generation` before processing.
 * 4. This parser is NOT a WorkerRequest type guard; compile-time checks are erased at runtime.
 * 5. Hostile proxies, descriptor traps, or throwing reads fail null, never raw exceptions.
 */

export type ParsedWorkerCommand =
  | Readonly<{ protocolVersion: 1; jobId: string; generation: number; type: 'BEGIN'; context: unknown }>
  | Readonly<{ protocolVersion: 1; jobId: string; generation: number; type: 'APPEND'; chunk: unknown }>
  | Readonly<{ protocolVersion: 1; jobId: string; generation: number; type: 'FINALIZE'; report: unknown }>
  | Readonly<{ protocolVersion: 1; jobId: string; generation: number; type: 'CANCEL' }>;

/**
 * Forbidden auth, credential, and principal fields that must never appear on a worker command envelope
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
 * Parses and verifies a worker command request envelope.
 *
 * Requirements enforced:
 * - Input must be a plain own record (Object.prototype or null prototype), not array, class, or primitive.
 * - No Symbol properties allowed.
 * - All envelope-level accessors (getters/setters) are rejected WITHOUT invocation by inspecting own descriptors.
 * - Only enumerable own DATA fields are accepted.
 * - Closed exact key sets:
 *   - BEGIN: [protocolVersion, jobId, generation, type, context]
 *   - APPEND: [protocolVersion, jobId, generation, type, chunk]
 *   - FINALIZE: [protocolVersion, jobId, generation, type, report]
 *   - CANCEL: [protocolVersion, jobId, generation, type] (no payload slot)
 * - All actual keys checked, not just counts.
 * - Rejects non-enumerable masks, inherited required fields or extras, and forbidden auth fields even if undefined.
 * - Captures each descriptor value exactly once.
 * - protocolVersion must be exactly 1.
 * - jobId must be a primitive non-empty string (opaque, preserved exactly, no trim/regex/cap).
 * - generation must be a finite safe integer >= 0, rejecting -0.
 * - Returns a new frozen known-field envelope with payload identity preserved.
 * - Input and payload are NOT mutated or frozen.
 * - On any failure or throwing trap/proxy, returns null safely.
 */
export function parseWorkerCommand(input: unknown): ParsedWorkerCommand | null {
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
    if (ownKeys.length < 4 || ownKeys.length > 5) return null;
    const ownNames: string[] = [];
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
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
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      Object.is(generation, -0)
    ) {
      return null;
    }

    const type = captured['type'];
    if (type !== 'BEGIN' && type !== 'APPEND' && type !== 'FINALIZE' && type !== 'CANCEL') {
      return null;
    }

    let expectedKeys: readonly string[];
    switch (type) {
      case 'BEGIN':
        expectedKeys = ['protocolVersion', 'jobId', 'generation', 'type', 'context'];
        break;
      case 'APPEND':
        expectedKeys = ['protocolVersion', 'jobId', 'generation', 'type', 'chunk'];
        break;
      case 'FINALIZE':
        expectedKeys = ['protocolVersion', 'jobId', 'generation', 'type', 'report'];
        break;
      case 'CANCEL':
        expectedKeys = ['protocolVersion', 'jobId', 'generation', 'type'];
        break;
    }

    if (ownNames.length !== expectedKeys.length) {
      return null;
    }

    const expectedSet = new Set(expectedKeys);
    for (let i = 0; i < ownNames.length; i++) {
      if (!expectedSet.has(ownNames[i]!)) {
        return null;
      }
    }

    for (let i = 0; i < expectedKeys.length; i++) {
      const expKey = expectedKeys[i]!;
      if (!Object.prototype.hasOwnProperty.call(input, expKey)) {
        return null;
      }
    }

    for (let i = 0; i < FORBIDDEN_AUTH_FIELDS.length; i++) {
      if (FORBIDDEN_AUTH_FIELDS[i]! in (input as object)) {
        return null;
      }
    }

    switch (type) {
      case 'BEGIN':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'BEGIN',
          context: captured['context'],
        });
      case 'APPEND':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'APPEND',
          chunk: captured['chunk'],
        });
      case 'FINALIZE':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'FINALIZE',
          report: captured['report'],
        });
      case 'CANCEL':
        return Object.freeze({
          protocolVersion: 1,
          jobId,
          generation,
          type: 'CANCEL',
        });
    }
  } catch {
    return null;
  }
}
