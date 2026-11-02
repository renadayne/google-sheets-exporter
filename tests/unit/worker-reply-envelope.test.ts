import { describe, it, expect, afterEach } from 'vitest';
import { parseWorkerReply } from '../../src/runtime/worker-reply-envelope.ts';
import type { ErrorCode } from '../../src/contracts/errors.ts';

describe('T36b3 Safe Worker Reply Envelope Parser', () => {
  // Clean up any prototype pollution after each test
  afterEach(() => {
    delete (Object.prototype as any).accessToken;
    delete (Object.prototype as any).token;
    delete (Object.prototype as any).email;
    delete (Object.prototype as any).percent;
    delete (Object.prototype as any).percentage;
    delete (Object.prototype as any).message;
    delete (Object.prototype as any).stack;
    delete (Object.prototype as any).body;
    delete (Object.prototype as any).cause;
    delete (Object.prototype as any).error;
  });

  // --- Group 1: Independent exact wrappers, known fields, and datatypes for every variant ---
  describe('Group 1: Independent exact wrappers, known fields, and datatypes for every variant', () => {
    it('parses valid CANCELLED response and returns exact frozen 4-key wrapper', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-cancel-01',
        generation: 0,
        type: 'CANCELLED',
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-cancel-01',
        generation: 0,
        type: 'CANCELLED',
      });
      expect(result?.type).toBe('CANCELLED');
      expect(Object.keys(result as object)).toEqual(['protocolVersion', 'jobId', 'generation', 'type']);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('parses valid ACK response with all 3 optional fields', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-ack-01',
        generation: 2,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 3,
        totalChunks: 10,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-ack-01',
        generation: 2,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 3,
        totalChunks: 10,
      });
      expect(result?.type).toBe('ACK');
      if (result && result.type === 'ACK') {
        expect(result.phase).toBe('append');
        expect(result.chunksCompleted).toBe(3);
        expect(result.totalChunks).toBe(10);
      }
    });

    it('parses valid minimal ACK response (no optional fields)', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-ack-min',
        generation: 1,
        type: 'ACK',
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-ack-min',
        generation: 1,
        type: 'ACK',
      });
      expect(Object.keys(result as object)).toEqual(['protocolVersion', 'jobId', 'generation', 'type']);
    });

    it('parses valid PROGRESS response with optional totalChunks', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-prog-01',
        generation: 4,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 8,
        totalChunks: 12,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-prog-01',
        generation: 4,
        type: 'PROGRESS',
        phase: 'serializing',
        chunksCompleted: 8,
        totalChunks: 12,
      });
      expect(result?.type).toBe('PROGRESS');
      if (result && result.type === 'PROGRESS') {
        expect(result.phase).toBe('serializing');
        expect(result.chunksCompleted).toBe(8);
        expect(result.totalChunks).toBe(12);
      }
    });

    it('parses valid PROGRESS response without optional totalChunks', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-prog-nototal',
        generation: 1,
        type: 'PROGRESS',
        phase: 'begin',
        chunksCompleted: 0,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-prog-nototal',
        generation: 1,
        type: 'PROGRESS',
        phase: 'begin',
        chunksCompleted: 0,
      });
      expect('totalChunks' in (result as object)).toBe(false);
    });

    it('parses valid STAGED_ARTIFACTS response preserving artifacts unknown slot', () => {
      const sampleArtifacts = [{ name: 'out.csv', bytes: new Uint8Array([1, 2, 3]) }];
      const input = {
        protocolVersion: 1,
        jobId: 'job-staged-01',
        generation: 5,
        type: 'STAGED_ARTIFACTS',
        artifacts: sampleArtifacts,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('STAGED_ARTIFACTS');
      if (result && result.type === 'STAGED_ARTIFACTS') {
        expect(result.artifacts).toBe(sampleArtifacts);
      }
    });

    it('parses valid ERROR response with all coordinates (sheetId, r, c)', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-err-01',
        generation: 3,
        type: 'ERROR',
        code: 'CELL_LIMIT_EXCEEDED' as ErrorCode,
        sheetId: 101,
        r: 50,
        c: 4,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-err-01',
        generation: 3,
        type: 'ERROR',
        code: 'CELL_LIMIT_EXCEEDED',
        sheetId: 101,
        r: 50,
        c: 4,
      });
      expect(result?.type).toBe('ERROR');
      if (result && result.type === 'ERROR') {
        expect(result.code).toBe('CELL_LIMIT_EXCEEDED');
        expect(result.sheetId).toBe(101);
        expect(result.r).toBe(50);
        expect(result.c).toBe(4);
      }
    });

    it('parses valid minimal ERROR response (code only, no coords)', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-err-min',
        generation: 2,
        type: 'ERROR',
        code: 'INTERNAL_ERROR' as ErrorCode,
      };
      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-err-min',
        generation: 2,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
      });
      expect('sheetId' in (result as object)).toBe(false);
      expect('r' in (result as object)).toBe(false);
      expect('c' in (result as object)).toBe(false);
    });

    it('allows independent coordinates on ERROR without fabricated hierarchy', () => {
      // sheetId only
      const resSheetOnly = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-coord-1',
        generation: 1,
        type: 'ERROR',
        code: 'RANGE_EMPTY',
        sheetId: 0,
      });
      expect(resSheetOnly).not.toBeNull();
      if (resSheetOnly && resSheetOnly.type === 'ERROR') {
        expect(resSheetOnly.sheetId).toBe(0);
        expect('r' in resSheetOnly).toBe(false);
        expect('c' in resSheetOnly).toBe(false);
      }

      // r only
      const resROnly = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-coord-2',
        generation: 1,
        type: 'ERROR',
        code: 'RANGE_INVALID',
        r: 42,
      });
      expect(resROnly).not.toBeNull();
      if (resROnly && resROnly.type === 'ERROR') {
        expect('sheetId' in resROnly).toBe(false);
        expect(resROnly.r).toBe(42);
        expect('c' in resROnly).toBe(false);
      }

      // c only
      const resCOnly = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-coord-3',
        generation: 1,
        type: 'ERROR',
        code: 'RANGE_OUT_OF_BOUNDS',
        c: 7,
      });
      expect(resCOnly).not.toBeNull();
      if (resCOnly && resCOnly.type === 'ERROR') {
        expect('sheetId' in resCOnly).toBe(false);
        expect('r' in resCOnly).toBe(false);
        expect(resCOnly.c).toBe(7);
      }

      // r and c without sheetId
      const resRC = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-coord-4',
        generation: 1,
        type: 'ERROR',
        code: 'SIZE_LIMIT_EXCEEDED',
        r: 10,
        c: 20,
      });
      expect(resRC).not.toBeNull();
      if (resRC && resRC.type === 'ERROR') {
        expect('sheetId' in resRC).toBe(false);
        expect(resRC.r).toBe(10);
        expect(resRC.c).toBe(20);
      }
    });
  });

  // --- Group 2: Optional fields omit vs undefined rejection & totals comparison ---
  describe('Group 2: Optional fields omit vs undefined rejection & totals comparison', () => {
    it('omits absent optional fields from ACK return wrapper', () => {
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-partial',
        generation: 1,
        type: 'ACK',
        phase: 'finalizing',
      });
      expect(result).not.toBeNull();
      expect('phase' in (result as object)).toBe(true);
      expect('chunksCompleted' in (result as object)).toBe(false);
      expect('totalChunks' in (result as object)).toBe(false);
    });

    it('rejects ACK when optional fields are explicitly present with undefined', () => {
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-u1',
        generation: 1,
        type: 'ACK',
        phase: undefined,
      })).toBeNull();

      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-u2',
        generation: 1,
        type: 'ACK',
        chunksCompleted: undefined,
      })).toBeNull();

      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-u3',
        generation: 1,
        type: 'ACK',
        totalChunks: undefined,
      })).toBeNull();
    });

    it('enforces totalChunks >= chunksCompleted when both are present on ACK', () => {
      // Equal is valid
      const eq = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-eq',
        generation: 1,
        type: 'ACK',
        chunksCompleted: 5,
        totalChunks: 5,
      });
      expect(eq).not.toBeNull();

      // Greater is valid
      const gt = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-gt',
        generation: 1,
        type: 'ACK',
        chunksCompleted: 3,
        totalChunks: 5,
      });
      expect(gt).not.toBeNull();

      // Less is rejected
      const lt = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-lt',
        generation: 1,
        type: 'ACK',
        chunksCompleted: 5,
        totalChunks: 4,
      });
      expect(lt).toBeNull();
    });

    it('accepts totalChunks without chunksCompleted and chunksCompleted without totalChunks on ACK', () => {
      const tcOnly = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-tc',
        generation: 1,
        type: 'ACK',
        totalChunks: 10,
      });
      expect(tcOnly).not.toBeNull();
      if (tcOnly && tcOnly.type === 'ACK') {
        expect(tcOnly.totalChunks).toBe(10);
        expect('chunksCompleted' in tcOnly).toBe(false);
      }

      const ccOnly = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-ack-cc',
        generation: 1,
        type: 'ACK',
        chunksCompleted: 2,
      });
      expect(ccOnly).not.toBeNull();
      if (ccOnly && ccOnly.type === 'ACK') {
        expect(ccOnly.chunksCompleted).toBe(2);
        expect('totalChunks' in ccOnly).toBe(false);
      }
    });

    it('omits absent totalChunks from PROGRESS return wrapper', () => {
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-prog-notc',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 3,
      });
      expect(result).not.toBeNull();
      expect('totalChunks' in (result as object)).toBe(false);
    });

    it('rejects PROGRESS when totalChunks is undefined', () => {
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-prog-tc-undef',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 3,
        totalChunks: undefined,
      });
      expect(result).toBeNull();
    });

    it('enforces totalChunks >= chunksCompleted on PROGRESS', () => {
      // Valid equal
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-p-eq',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 4,
        totalChunks: 4,
      })).not.toBeNull();

      // Valid greater
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-p-gt',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 4,
        totalChunks: 10,
      })).not.toBeNull();

      // Rejected less
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-p-lt',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 5,
        totalChunks: 3,
      })).toBeNull();
    });

    it('rejects PROGRESS when required phase or chunksCompleted is missing', () => {
      // missing phase
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-p-nophase',
        generation: 1,
        type: 'PROGRESS',
        chunksCompleted: 1,
      })).toBeNull();

      // missing chunksCompleted
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-p-nocc',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
      })).toBeNull();
    });

    it('omits absent coordinates from ERROR return wrapper and rejects undefined coordinates', () => {
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-partial',
        generation: 1,
        type: 'ERROR',
        code: 'NETWORK_TIMEOUT',
        sheetId: 1,
      });
      expect(result).not.toBeNull();
      expect('sheetId' in (result as object)).toBe(true);
      expect('r' in (result as object)).toBe(false);
      expect('c' in (result as object)).toBe(false);

      // Undefined sheetId
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-u1',
        generation: 1,
        type: 'ERROR',
        code: 'NETWORK_TIMEOUT',
        sheetId: undefined,
      })).toBeNull();

      // Undefined r
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-u2',
        generation: 1,
        type: 'ERROR',
        code: 'NETWORK_TIMEOUT',
        r: undefined,
      })).toBeNull();

      // Undefined c
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-u3',
        generation: 1,
        type: 'ERROR',
        code: 'NETWORK_TIMEOUT',
        c: undefined,
      })).toBeNull();
    });

    it('rejects ERROR when code is missing or not in real error catalog', () => {
      // Missing code
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-nocode',
        generation: 1,
        type: 'ERROR',
      })).toBeNull();

      // Fabricated/unknown code
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-badcode',
        generation: 1,
        type: 'ERROR',
        code: 'SOME_FABRICATED_CODE',
      })).toBeNull();

      // Prototype property name
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-err-proto',
        generation: 1,
        type: 'ERROR',
        code: 'toString',
      })).toBeNull();
    });
  });

  // --- Group 3: Hostile envelope accessors zero calls & one descriptor capture per key ---
  describe('Group 3: Hostile envelope accessors zero calls & one descriptor capture per key', () => {
    it('rejects envelope getters on base fields WITHOUT executing the getter function', () => {
      const fields = ['protocolVersion', 'jobId', 'generation', 'type'] as const;

      for (const field of fields) {
        let getterRan = false;
        const input: Record<string, unknown> = {
          protocolVersion: 1,
          jobId: 'job-getter-test',
          generation: 1,
          type: 'CANCELLED',
        };

        Object.defineProperty(input, field, {
          get() {
            getterRan = true;
            throw new Error(`Hostile getter on ${field}`);
          },
          enumerable: true,
          configurable: true,
        });

        const result = parseWorkerReply(input);
        expect(result).toBeNull();
        expect(getterRan).toBe(false);
      }
    });

    it('rejects envelope getters on variant fields WITHOUT executing the getter function', () => {
      const variantCases: Array<{ base: Record<string, unknown>; field: string }> = [
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'ACK' }, field: 'phase' },
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'ACK' }, field: 'chunksCompleted' },
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'ACK' }, field: 'totalChunks' },
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'STAGED_ARTIFACTS' }, field: 'artifacts' },
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'ERROR' }, field: 'code' },
        { base: { protocolVersion: 1, jobId: 'j', generation: 1, type: 'ERROR', code: 'INTERNAL_ERROR' }, field: 'sheetId' },
      ];

      for (const { base, field } of variantCases) {
        let getterRan = false;
        const input = { ...base };
        Object.defineProperty(input, field, {
          get() {
            getterRan = true;
            throw new Error(`Hostile getter on ${field}`);
          },
          enumerable: true,
          configurable: true,
        });

        const result = parseWorkerReply(input);
        expect(result).toBeNull();
        expect(getterRan).toBe(false);
      }
    });

    it('captures each property descriptor exactly once and performs zero direct input rereads', () => {
      const descriptorReads: Record<string, number> = {};
      let getTrapCalls = 0;

      const raw = {
        protocolVersion: 1,
        jobId: 'job-desc-01',
        generation: 2,
        type: 'ACK',
        phase: 'append',
        chunksCompleted: 1,
        totalChunks: 5,
      };

      const input = new Proxy(raw, {
        getOwnPropertyDescriptor(target, prop) {
          const key = String(prop);
          descriptorReads[key] = (descriptorReads[key] || 0) + 1;
          return Object.getOwnPropertyDescriptor(target, prop);
        },
        get(target, prop, receiver) {
          getTrapCalls++;
          return Reflect.get(target, prop, receiver);
        },
      });

      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('ACK');

      // Every own property descriptor read exactly once
      const expectedKeys = ['protocolVersion', 'jobId', 'generation', 'type', 'phase', 'chunksCompleted', 'totalChunks'];
      for (const k of expectedKeys) {
        expect(descriptorReads[k]).toBe(1);
      }

      // Zero get trap calls on envelope input
      expect(getTrapCalls).toBe(0);
    });

    it('does not re-trap hasOwnProperty after snapshot', () => {
      let descriptorCalls = 0;

      const raw = {
        protocolVersion: 1,
        jobId: 'job-retrap',
        generation: 0,
        type: 'CANCELLED',
      };

      const input = new Proxy(raw, {
        getOwnPropertyDescriptor(target, prop) {
          descriptorCalls++;
          if (descriptorCalls > 4) throw new Error('Unexpected descriptor reread');
          return Object.getOwnPropertyDescriptor(target, prop);
        },
      });

      const result = parseWorkerReply(input);
      expect(result).toEqual(raw);
      expect(descriptorCalls).toBe(4);
    });
  });

  // --- Group 4: Own key snapshot bounds (4..8) & symbols & non-enumerables & extra fields ---
  describe('Group 4: Own key snapshot bounds (4..8) & symbols & non-enumerables & extra fields', () => {
    it('rejects envelopes with fewer than 4 keys before reading any field descriptors', () => {
      let descriptors = 0;
      const input = new Proxy({ protocolVersion: 1, jobId: 'j', generation: 1 }, {
        ownKeys: () => ['protocolVersion', 'jobId', 'generation'],
        getOwnPropertyDescriptor() {
          descriptors++;
          throw new Error('Must not inspect undersized envelope');
        },
      });
      expect(parseWorkerReply(input)).toBeNull();
      expect(descriptors).toBe(0);
    });

    it('rejects envelopes with more than 8 keys before reading any field descriptors', () => {
      let descriptors = 0;
      const input = new Proxy({}, {
        ownKeys: () => [
          'protocolVersion', 'jobId', 'generation', 'type', 'code', 'sheetId', 'r', 'c', 'extraKey'
        ],
        getOwnPropertyDescriptor() {
          descriptors++;
          throw new Error('Must not inspect oversized envelope');
        },
      });
      expect(parseWorkerReply(input)).toBeNull();
      expect(descriptors).toBe(0);
    });

    it('rejects Symbol own keys before reading any field descriptors', () => {
      let descriptors = 0;
      const sym = Symbol('secret');
      const input = new Proxy({}, {
        ownKeys: () => ['protocolVersion', 'jobId', 'generation', 'type', sym],
        getOwnPropertyDescriptor() {
          descriptors++;
          throw new Error('Must not inspect symbol envelope');
        },
      });
      expect(parseWorkerReply(input)).toBeNull();
      expect(descriptors).toBe(0);
    });

    it('rejects non-enumerable required fields', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-nonenum',
        type: 'CANCELLED',
      };
      Object.defineProperty(input, 'generation', {
        value: 1,
        enumerable: false,
        configurable: true,
      });
      expect(parseWorkerReply(input)).toBeNull();
    });

    it('rejects non-enumerable extra fields', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-nonenum-extra',
        generation: 1,
        type: 'CANCELLED',
      };
      Object.defineProperty(input, 'hiddenExtra', {
        value: 'payload',
        enumerable: false,
        configurable: true,
      });
      expect(parseWorkerReply(input)).toBeNull();
    });

    it('rejects inherited required fields (prototype key masking)', () => {
      const proto = { protocolVersion: 1 };
      const input = Object.create(proto);
      input.jobId = 'job-proto-req';
      input.generation = 1;
      input.type = 'CANCELLED';
      // Missing own protocolVersion
      expect(parseWorkerReply(input)).toBeNull();
    });

    it('rejects extra unknown fields for every variant', () => {
      // CANCELLED + extra
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'CANCELLED',
        extra: 'forbidden',
      })).toBeNull();

      // STAGED_ARTIFACTS + extra
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'STAGED_ARTIFACTS',
        artifacts: [],
        extra: 'forbidden',
      })).toBeNull();

      // ACK + extra
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ACK',
        extra: 'forbidden',
      })).toBeNull();

      // PROGRESS + extra
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 1,
        extra: 'forbidden',
      })).toBeNull();

      // ERROR + extra
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
        extra: 'forbidden',
      })).toBeNull();
    });

    it('rejects percent and percentage fields on ACK and PROGRESS even if undefined', () => {
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ACK',
        percent: 50,
      })).toBeNull();

      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ACK',
        percentage: undefined,
      })).toBeNull();

      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'PROGRESS',
        phase: 'append',
        chunksCompleted: 1,
        percent: undefined,
      })).toBeNull();
    });

    it('rejects message, stack, body, cause, error on ERROR even if undefined', () => {
      const forbiddenErrorKeys = ['message', 'stack', 'body', 'cause', 'error'];
      for (const key of forbiddenErrorKeys) {
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
          [key]: undefined,
        })).toBeNull();

        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
          [key]: 'leak',
        })).toBeNull();
      }
    });
  });

  // --- Group 5: Prototypes, prototype pollution traps, credential/auth fields ---
  describe('Group 5: Prototypes, prototype pollution traps, credential/auth fields', () => {
    it('rejects non-plain prototypes (arrays, Error instances, custom classes, Dates)', () => {
      // Array
      expect(parseWorkerReply([1, 2, 3])).toBeNull();

      // Error instance
      const err = new Error('boom');
      Object.assign(err, { protocolVersion: 1, jobId: 'j', generation: 1, type: 'CANCELLED' });
      expect(parseWorkerReply(err)).toBeNull();

      // Custom class instance
      class CustomReply {
        protocolVersion = 1;
        jobId = 'j';
        generation = 1;
        type = 'CANCELLED';
      }
      expect(parseWorkerReply(new CustomReply())).toBeNull();

      // Date
      const date = new Date();
      Object.assign(date, { protocolVersion: 1, jobId: 'j', generation: 1, type: 'CANCELLED' });
      expect(parseWorkerReply(date)).toBeNull();
    });

    it('accepts plain null prototype (Object.create(null))', () => {
      const input = Object.create(null);
      input.protocolVersion = 1;
      input.jobId = 'job-null-proto';
      input.generation = 1;
      input.type = 'CANCELLED';

      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result?.jobId).toBe('job-null-proto');
    });

    it('rejects envelopes with forbidden auth/credential fields on input', () => {
      const forbidden = [
        'principalKey', 'displayEmail', 'email', 'principal',
        'token', 'accessToken', 'refreshToken', 'authorization',
        'headers', 'account', 'auth', 'exportRequest',
      ];

      for (const field of forbidden) {
        const input: Record<string, unknown> = {
          protocolVersion: 1,
          jobId: 'job-auth-test',
          generation: 1,
          type: 'CANCELLED',
          [field]: 'secret-value',
        };
        expect(parseWorkerReply(input)).toBeNull();
      }
    });

    it('rejects envelopes when forbidden auth fields are polluted on Object.prototype without accessing values', () => {
      let getterRan = false;
      Object.defineProperty(Object.prototype, 'accessToken', {
        get() {
          getterRan = true;
          return 'stolen-token';
        },
        set() {},
        configurable: true,
      });

      try {
        const input = {
          protocolVersion: 1,
          jobId: 'job-proto-polluted',
          generation: 1,
          type: 'CANCELLED',
        };

        const result = parseWorkerReply(input);
        expect(result).toBeNull();
        // has check ('in') checks prototype without triggering getter
        expect(getterRan).toBe(false);
      } finally {
        delete (Object.prototype as any).accessToken;
      }
    });

    it('rejects ERROR when message or stack is polluted on Object.prototype without accessing values', () => {
      let getterRan = false;
      Object.defineProperty(Object.prototype, 'message', {
        get() {
          getterRan = true;
          return 'polluted-error-message';
        },
        set() {},
        configurable: true,
      });

      try {
        const input = {
          protocolVersion: 1,
          jobId: 'job-err-polluted',
          generation: 1,
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
        };

        const result = parseWorkerReply(input);
        expect(result).toBeNull();
        expect(getterRan).toBe(false);
      } finally {
        delete (Object.prototype as any).message;
      }
    });

    it('rejects ACK/PROGRESS when percent is polluted on Object.prototype without accessing values', () => {
      let getterRan = false;
      Object.defineProperty(Object.prototype, 'percent', {
        get() {
          getterRan = true;
          return 99;
        },
        set() {},
        configurable: true,
      });

      try {
        const inputAck = {
          protocolVersion: 1,
          jobId: 'job-ack-percent',
          generation: 1,
          type: 'ACK',
        };
        expect(parseWorkerReply(inputAck)).toBeNull();
        expect(getterRan).toBe(false);

        const inputProg = {
          protocolVersion: 1,
          jobId: 'job-prog-percent',
          generation: 1,
          type: 'PROGRESS',
          phase: 'append',
          chunksCompleted: 1,
        };
        expect(parseWorkerReply(inputProg)).toBeNull();
        expect(getterRan).toBe(false);
      } finally {
        delete (Object.prototype as any).percent;
      }
    });

    it('fails safely to null when hostile proxy traps throw', () => {
      // Throwing ownKeys
      const throwingOwnKeys = new Proxy({}, {
        ownKeys() { throw new Error('Hostile ownKeys trap'); },
      });
      expect(parseWorkerReply(throwingOwnKeys)).toBeNull();

      // Throwing getPrototypeOf
      const throwingProto = new Proxy({}, {
        getPrototypeOf() { throw new Error('Hostile getPrototypeOf trap'); },
      });
      expect(parseWorkerReply(throwingProto)).toBeNull();

      // Throwing has trap
      const throwingHas = new Proxy({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'CANCELLED',
      }, {
        has() { throw new Error('Hostile has trap'); },
      });
      expect(parseWorkerReply(throwingHas)).toBeNull();
    });
  });

  // --- Group 6: Counters boundaries, safe integers, -0, and invalid data types ---
  describe('Group 6: Counters boundaries, safe integers, -0, and invalid data types', () => {
    it('accepts 0 as a safe non-negative integer for all counter and coordinate fields', () => {
      // generation 0
      const cancel0 = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 0,
        type: 'CANCELLED',
      });
      expect(cancel0).not.toBeNull();
      expect(cancel0?.generation).toBe(0);

      // chunksCompleted 0, totalChunks 0
      const ack0 = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 0,
        type: 'ACK',
        chunksCompleted: 0,
        totalChunks: 0,
      });
      expect(ack0).not.toBeNull();
      if (ack0 && ack0.type === 'ACK') {
        expect(ack0.chunksCompleted).toBe(0);
        expect(ack0.totalChunks).toBe(0);
      }

      // sheetId 0, r 0, c 0
      const err0 = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 0,
        type: 'ERROR',
        code: 'RANGE_EMPTY',
        sheetId: 0,
        r: 0,
        c: 0,
      });
      expect(err0).not.toBeNull();
      if (err0 && err0.type === 'ERROR') {
        expect(err0.sheetId).toBe(0);
        expect(err0.r).toBe(0);
        expect(err0.c).toBe(0);
      }
    });

    it('rejects -0 on generation, chunksCompleted, totalChunks, sheetId, r, c', () => {
      // generation -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: -0,
        type: 'CANCELLED',
      })).toBeNull();

      // chunksCompleted -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ACK',
        chunksCompleted: -0,
      })).toBeNull();

      // totalChunks -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ACK',
        totalChunks: -0,
      })).toBeNull();

      // sheetId -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
        sheetId: -0,
      })).toBeNull();

      // r -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
        r: -0,
      })).toBeNull();

      // c -0
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'ERROR',
        code: 'INTERNAL_ERROR',
        c: -0,
      })).toBeNull();
    });

    it('rejects negative numbers, floats, NaN, Infinity, and unsafe integers', () => {
      const invalidNumbers = [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 53];

      for (const num of invalidNumbers) {
        // generation
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: num,
          type: 'CANCELLED',
        })).toBeNull();

        // chunksCompleted
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ACK',
          chunksCompleted: num,
        })).toBeNull();

        // totalChunks
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ACK',
          totalChunks: num,
        })).toBeNull();

        // sheetId
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
          sheetId: num,
        })).toBeNull();
      }
    });

    it('preserves opaque nonempty jobId verbatim and rejects empty/non-string jobId', () => {
      // Empty string
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: '',
        generation: 1,
        type: 'CANCELLED',
      })).toBeNull();

      // Non-string
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 12345,
        generation: 1,
        type: 'CANCELLED',
      })).toBeNull();

      // String object
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: new String('job-object'),
        generation: 1,
        type: 'CANCELLED',
      })).toBeNull();

      // Unicode / opaque string preserved exactly
      const unicodeId = '🚀_job:uuid-1234-abcd_⚡';
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: unicodeId,
        generation: 1,
        type: 'CANCELLED',
      });
      expect(result).not.toBeNull();
      expect(result?.jobId).toBe(unicodeId);
    });

    it('rejects invalid protocolVersion and invalid phase strings', () => {
      // protocolVersion not 1
      expect(parseWorkerReply({
        protocolVersion: 2,
        jobId: 'j',
        generation: 1,
        type: 'CANCELLED',
      })).toBeNull();

      expect(parseWorkerReply({
        protocolVersion: '1',
        jobId: 'j',
        generation: 1,
        type: 'CANCELLED',
      })).toBeNull();

      // Invalid phase strings
      const badPhases = ['start', 'complete', 'finished', 'BEGIN', '', 123];
      for (const p of badPhases) {
        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'ACK',
          phase: p,
        })).toBeNull();

        expect(parseWorkerReply({
          protocolVersion: 1,
          jobId: 'j',
          generation: 1,
          type: 'PROGRESS',
          phase: p,
          chunksCompleted: 1,
        })).toBeNull();
      }
    });
  });

  // --- Group 7: STAGED_ARTIFACTS unknown slot: identity preserved, throwing proxy untouched, no traversal ---
  describe('Group 7: STAGED_ARTIFACTS unknown slot: identity preserved, throwing proxy untouched, no traversal', () => {
    it('preserves hostile throwing proxy in artifacts slot without triggering any traps', () => {
      let trapsInvoked = 0;
      const hostileArtifactsProxy = new Proxy({}, {
        get() { trapsInvoked++; throw new Error('Hostile get trap on artifacts'); },
        has() { trapsInvoked++; throw new Error('Hostile has trap on artifacts'); },
        ownKeys() { trapsInvoked++; throw new Error('Hostile ownKeys trap on artifacts'); },
        getOwnPropertyDescriptor() { trapsInvoked++; throw new Error('Hostile getOwnPropertyDescriptor trap on artifacts'); },
      });

      const input = {
        protocolVersion: 1,
        jobId: 'job-hostile-artifacts',
        generation: 1,
        type: 'STAGED_ARTIFACTS',
        artifacts: hostileArtifactsProxy,
      };

      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('STAGED_ARTIFACTS');
      if (result && result.type === 'STAGED_ARTIFACTS') {
        // Identity preserved
        expect(result.artifacts).toBe(hostileArtifactsProxy);
      }
      // Zero traps invoked on artifacts
      expect(trapsInvoked).toBe(0);
    });

    it('does not assert array or traverse artifacts', () => {
      // Primitive string in artifacts
      const resStr = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'STAGED_ARTIFACTS',
        artifacts: 'raw-string-not-array',
      });
      expect(resStr).not.toBeNull();
      if (resStr && resStr.type === 'STAGED_ARTIFACTS') {
        expect(resStr.artifacts).toBe('raw-string-not-array');
      }

      // Null in artifacts
      const resNull = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'STAGED_ARTIFACTS',
        artifacts: null,
      });
      expect(resNull).not.toBeNull();
      if (resNull && resNull.type === 'STAGED_ARTIFACTS') {
        expect(resNull.artifacts).toBeNull();
      }
    });

    it('preserves payload mutability and does not freeze input envelope or artifacts payload', () => {
      const artifactsObj = { file: 'test.xlsx' };
      const input = {
        protocolVersion: 1,
        jobId: 'job-unfrozen-check',
        generation: 2,
        type: 'STAGED_ARTIFACTS',
        artifacts: artifactsObj,
      };

      const result = parseWorkerReply(input);
      expect(result).not.toBeNull();

      // Input envelope is NOT frozen
      expect(Object.isFrozen(input)).toBe(false);

      // Artifacts payload is NOT frozen
      expect(Object.isFrozen(artifactsObj)).toBe(false);

      // Result wrapper IS frozen
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // --- Group 8: Caller verification contract, immutability, and security boundaries ---
  describe('Group 8: Caller verification contract, immutability, and security boundaries', () => {
    it('returns frozen plain wrapper that cannot be mutated', () => {
      const result = parseWorkerReply({
        protocolVersion: 1,
        jobId: 'job-frozen-wrapper',
        generation: 1,
        type: 'CANCELLED',
      });
      expect(result).not.toBeNull();
      expect(Object.isFrozen(result)).toBe(true);

      // Attempting to modify properties in strict mode throws
      expect(() => {
        (result as any).jobId = 'mutated';
      }).toThrow();

      expect(() => {
        (result as any).newProp = 'injected';
      }).toThrow();
    });

    it('rejects non-object inputs safely', () => {
      expect(parseWorkerReply(null)).toBeNull();
      expect(parseWorkerReply(undefined)).toBeNull();
      expect(parseWorkerReply('string')).toBeNull();
      expect(parseWorkerReply(123)).toBeNull();
      expect(parseWorkerReply(true)).toBeNull();
      expect(parseWorkerReply(Symbol('sym'))).toBeNull();
      expect(parseWorkerReply(() => {})).toBeNull();
    });

    it('rejects empty object safely', () => {
      expect(parseWorkerReply({})).toBeNull();
    });

    it('rejects unknown reply type', () => {
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'SOME_UNKNOWN_TYPE',
      })).toBeNull();

      // Request types are not valid reply types
      expect(parseWorkerReply({
        protocolVersion: 1,
        jobId: 'j',
        generation: 1,
        type: 'BEGIN',
      })).toBeNull();
    });
  });
});
