import { describe, it, expect } from 'vitest';
import { parseWorkerCommand } from '../../src/runtime/worker-envelope.ts';

describe('T36b1 Worker Request Envelope Parser', () => {
  it('rejects oversized envelopes before reading any field descriptors', () => {
    let descriptors = 0;
    const input = new Proxy({}, {
      ownKeys: () => ['protocolVersion', 'jobId', 'generation', 'type', 'chunk', 'accessToken'],
      getOwnPropertyDescriptor() { descriptors++; throw new Error('Must not inspect rejected fields'); }
    });
    expect(parseWorkerCommand(input)).toBeNull();
    expect(descriptors).toBe(0);
  });
  // --- Group 1: Full expected outputs for all 4 variants ---
  describe('Group 1: Full expected outputs for all 4 variants', () => {
    it('parses valid BEGIN command and returns exact frozen envelope', () => {
      const sampleContext = { format: 'csv', sheetId: 0, title: 'Sheet1' };
      const input = {
        protocolVersion: 1,
        jobId: 'job-alpha-001',
        generation: 3,
        type: 'BEGIN',
        context: sampleContext,
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-alpha-001',
        generation: 3,
        type: 'BEGIN',
        context: sampleContext,
      });
      expect(result?.type).toBe('BEGIN');
      if (result && result.type === 'BEGIN') {
        expect(result.protocolVersion).toBe(1);
        expect(result.jobId).toBe('job-alpha-001');
        expect(result.generation).toBe(3);
        expect(result.context).toBe(sampleContext);
      }
    });

    it('parses valid APPEND command and returns exact frozen envelope', () => {
      const sampleChunk = { sheetId: 0, rowIndex: 0, values: [['a', 'b']] };
      const input = {
        protocolVersion: 1,
        jobId: 'job-alpha-002',
        generation: 2,
        type: 'APPEND',
        chunk: sampleChunk,
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-alpha-002',
        generation: 2,
        type: 'APPEND',
        chunk: sampleChunk,
      });
      expect(result?.type).toBe('APPEND');
      if (result && result.type === 'APPEND') {
        expect(result.chunk).toBe(sampleChunk);
      }
    });

    it('parses valid FINALIZE command and returns exact frozen envelope', () => {
      const sampleReport = { totalRows: 10, totalBytes: 512 };
      const input = {
        protocolVersion: 1,
        jobId: 'job-alpha-003',
        generation: 9,
        type: 'FINALIZE',
        report: sampleReport,
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-alpha-003',
        generation: 9,
        type: 'FINALIZE',
        report: sampleReport,
      });
      expect(result?.type).toBe('FINALIZE');
      if (result && result.type === 'FINALIZE') {
        expect(result.report).toBe(sampleReport);
      }
    });

    it('parses valid CANCEL command with closed 4-field envelope and no payload', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-alpha-004',
        generation: 0,
        type: 'CANCEL',
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        protocolVersion: 1,
        jobId: 'job-alpha-004',
        generation: 0,
        type: 'CANCEL',
      });
      expect(result?.type).toBe('CANCEL');
      if (result && result.type === 'CANCEL') {
        expect(Object.keys(result).sort()).toEqual(['generation', 'jobId', 'protocolVersion', 'type'].sort());
        expect('context' in result).toBe(false);
        expect('chunk' in result).toBe(false);
        expect('report' in result).toBe(false);
      }
    });
  });

  // --- Group 2: Opaque unicode ID, 0 generation, and null prototype ---
  describe('Group 2: Opaque unicode ID, 0 generation, and null prototype', () => {
    it('accepts Object.create(null) dictionary without Object.prototype', () => {
      const nullProtoInput = Object.create(null);
      nullProtoInput.protocolVersion = 1;
      nullProtoInput.jobId = 'null-proto-job';
      nullProtoInput.generation = 0;
      nullProtoInput.type = 'CANCEL';

      const result = parseWorkerCommand(nullProtoInput);
      expect(result).not.toBeNull();
      expect(result?.jobId).toBe('null-proto-job');
      expect(result?.generation).toBe(0);
    });

    it('accepts generation 0 as valid non-negative integer', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-zero-gen',
        generation: 0,
        type: 'CANCEL',
      };
      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result?.generation).toBe(0);
      expect(Object.is(result?.generation, 0)).toBe(true);
      expect(Object.is(result?.generation, -0)).toBe(false);
    });

    it('preserves opaque unicode jobId exactly without trimming, alteration, or cap', () => {
      const unicodeId = '  job-📊-日本語-\u0000-\uFFFF-!@#$%^&*() \t\r\n  ';
      const input = {
        protocolVersion: 1,
        jobId: unicodeId,
        generation: 1,
        type: 'CANCEL',
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result?.jobId).toBe(unicodeId);
      // Assert exact length and exact identity without whitespace trimming
      expect(result?.jobId.length).toBe(unicodeId.length);
      expect(result?.jobId.startsWith('  ')).toBe(true);
      expect(result?.jobId.endsWith('  ')).toBe(true);
    });
  });

  // --- Group 3: Exact own key masks, non-enumerables, inherited keys, symbols, auth fields, and extra payloads ---
  describe('Group 3: Exact own key masks, non-enumerables, inherited keys, symbols, auth fields, and extra payloads', () => {
    it('rejects envelope containing any own Symbol properties', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-sym',
        generation: 1,
        type: 'CANCEL',
        [Symbol('auth')]: 'leak',
      };
      expect(parseWorkerCommand(input)).toBeNull();
    });

    it('rejects non-enumerable own properties even if undefined or hidden mask', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-non-enum',
        generation: 1,
        type: 'CANCEL',
      };
      Object.defineProperty(input, 'token', {
        value: undefined,
        enumerable: false,
        configurable: true,
      });
      expect(parseWorkerCommand(input)).toBeNull();

      const input2 = {
        protocolVersion: 1,
        jobId: 'job-non-enum-2',
        generation: 1,
        type: 'CANCEL',
      };
      Object.defineProperty(input2, 'maskField', {
        value: 'hidden',
        enumerable: false,
        configurable: true,
      });
      expect(parseWorkerCommand(input2)).toBeNull();
    });

    it('rejects non-enumerable required fields', () => {
      const input = {
        jobId: 'job-req-non-enum',
        generation: 1,
        type: 'CANCEL',
      };
      Object.defineProperty(input, 'protocolVersion', {
        value: 1,
        enumerable: false,
        configurable: true,
      });
      expect(parseWorkerCommand(input)).toBeNull();
    });

    it('rejects inherited required fields and inherited prototype properties', () => {
      const basePrototype = {
        protocolVersion: 1,
        jobId: 'inherited-job',
        generation: 1,
      };
      const inherited = Object.create(basePrototype);
      inherited.type = 'CANCEL';
      expect(parseWorkerCommand(inherited)).toBeNull();
    });

    it('rejects forbidden auth/credential fields on envelope or prototype chain', () => {
      const forbidden = [
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
      ];

      for (const field of forbidden) {
        const input = {
          protocolVersion: 1,
          jobId: 'job-auth-test',
          generation: 1,
          type: 'CANCEL',
          [field]: 'should-be-rejected',
        };
        expect(parseWorkerCommand(input)).toBeNull();
      }
    });

    it('rejects extra unknown own keys on any variant', () => {
      const input = {
        protocolVersion: 1,
        jobId: 'job-extra-key',
        generation: 1,
        type: 'BEGIN',
        context: {},
        unexpectedExtra: true,
      };
      expect(parseWorkerCommand(input)).toBeNull();
    });

    it('rejects payload field attached to CANCEL command', () => {
      const inputWithContext = {
        protocolVersion: 1,
        jobId: 'job-cancel-extra',
        generation: 1,
        type: 'CANCEL',
        context: {},
      };
      expect(parseWorkerCommand(inputWithContext)).toBeNull();

      const inputWithChunk = {
        protocolVersion: 1,
        jobId: 'job-cancel-extra',
        generation: 1,
        type: 'CANCEL',
        chunk: {},
      };
      expect(parseWorkerCommand(inputWithChunk)).toBeNull();
    });

    it('rejects mismatched payload keys (e.g. BEGIN with chunk or FINALIZE with context)', () => {
      const beginWithChunk = {
        protocolVersion: 1,
        jobId: 'job-mismatch',
        generation: 1,
        type: 'BEGIN',
        chunk: {},
      };
      expect(parseWorkerCommand(beginWithChunk)).toBeNull();

      const finalizeWithContext = {
        protocolVersion: 1,
        jobId: 'job-mismatch-2',
        generation: 1,
        type: 'FINALIZE',
        context: {},
      };
      expect(parseWorkerCommand(finalizeWithContext)).toBeNull();
    });
  });

  // --- Group 4: Malformed IDs, versions, types, -0, and unsafe numbers ---
  describe('Group 4: Malformed IDs, versions, types, -0, and unsafe numbers', () => {
    it('rejects malformed protocolVersion values', () => {
      const badVersions = [0, 2, -1, '1', 1.1, null, undefined, true, {}, []];
      for (const ver of badVersions) {
        const input = {
          protocolVersion: ver,
          jobId: 'job-ver',
          generation: 1,
          type: 'CANCEL',
        };
        expect(parseWorkerCommand(input)).toBeNull();
      }
    });

    it('rejects empty string or non-string jobId', () => {
      const badIds = ['', null, undefined, 123, true, {}, []];
      for (const id of badIds) {
        const input = {
          protocolVersion: 1,
          jobId: id,
          generation: 1,
          type: 'CANCEL',
        };
        expect(parseWorkerCommand(input)).toBeNull();
      }
    });

    it('rejects -0, negative numbers, floats, NaN, and unsafe integers for generation', () => {
      const badGenerations = [
        -0,
        -1,
        -100,
        0.5,
        1.1,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        '1',
        null,
        undefined,
        true,
      ];

      for (const gen of badGenerations) {
        const input = {
          protocolVersion: 1,
          jobId: 'job-bad-gen',
          generation: gen,
          type: 'CANCEL',
        };
        expect(parseWorkerCommand(input)).toBeNull();
      }
    });

    it('rejects malformed or unknown type values', () => {
      const badTypes = ['UNKNOWN', 'begin', 'append', 'CANCEL_ALL', '', 123, null, undefined];
      for (const t of badTypes) {
        const input = {
          protocolVersion: 1,
          jobId: 'job-bad-type',
          generation: 1,
          type: t,
        };
        expect(parseWorkerCommand(input)).toBeNull();
      }
    });

    it('rejects non-objects, arrays, primitives, and class instances', () => {
      expect(parseWorkerCommand(null)).toBeNull();
      expect(parseWorkerCommand(undefined)).toBeNull();
      expect(parseWorkerCommand('string-input')).toBeNull();
      expect(parseWorkerCommand(12345)).toBeNull();
      expect(parseWorkerCommand(true)).toBeNull();
      expect(parseWorkerCommand([])).toBeNull();
      expect(parseWorkerCommand([1, 2, 3])).toBeNull();

      class CustomCommand {
        protocolVersion = 1;
        jobId = 'job-class';
        generation = 1;
        type = 'CANCEL';
      }
      expect(parseWorkerCommand(new CustomCommand())).toBeNull();
    });
  });

  // --- Group 5: Proxies throwing return null (hostile traps fail safely) ---
  describe('Group 5: Hostile proxies and descriptor traps fail null safely', () => {
    it('returns null when proxy getOwnPropertyDescriptor trap throws', () => {
      const hostile = new Proxy(
        { protocolVersion: 1, jobId: 'job-proxy', generation: 1, type: 'CANCEL' },
        {
          getOwnPropertyDescriptor() {
            throw new Error('Hostile getOwnPropertyDescriptor trap');
          },
        }
      );
      expect(parseWorkerCommand(hostile)).toBeNull();
    });

    it('returns null when proxy ownKeys trap throws', () => {
      const hostile = new Proxy(
        { protocolVersion: 1, jobId: 'job-proxy', generation: 1, type: 'CANCEL' },
        {
          ownKeys() {
            throw new Error('Hostile ownKeys trap');
          },
        }
      );
      expect(parseWorkerCommand(hostile)).toBeNull();
    });

    it('returns null when proxy getPrototypeOf trap throws', () => {
      const hostile = new Proxy(
        { protocolVersion: 1, jobId: 'job-proxy', generation: 1, type: 'CANCEL' },
        {
          getPrototypeOf() {
            throw new Error('Hostile getPrototypeOf trap');
          },
        }
      );
      expect(parseWorkerCommand(hostile)).toBeNull();
    });

    it('returns null when proxy has trap throws', () => {
      const hostile = new Proxy(
        { protocolVersion: 1, jobId: 'job-proxy', generation: 1, type: 'CANCEL' },
        {
          has() {
            throw new Error('Hostile has trap');
          },
        }
      );
      expect(parseWorkerCommand(hostile)).toBeNull();
    });
  });

  // --- Group 6: Envelope accessors must not execute ---
  describe('Group 6: Envelope accessors must not execute', () => {
    it('rejects envelope getter on jobId WITHOUT executing the getter function', () => {
      let getterExecuted = false;
      const input = {
        protocolVersion: 1,
        generation: 1,
        type: 'CANCEL',
      };
      Object.defineProperty(input, 'jobId', {
        get() {
          getterExecuted = true;
          throw new Error('Explosive getter');
        },
        enumerable: true,
        configurable: true,
      });

      const result = parseWorkerCommand(input);
      expect(result).toBeNull();
      expect(getterExecuted).toBe(false);
    });

    it('rejects envelope getter on protocolVersion, generation, type, or context without execution', () => {
      const fields = ['protocolVersion', 'generation', 'type', 'context'] as const;

      for (const field of fields) {
        let getterRan = false;
        const input: Record<string, unknown> = {
          protocolVersion: 1,
          jobId: 'job-getter-test',
          generation: 1,
          type: 'BEGIN',
          context: {},
        };
        Object.defineProperty(input, field, {
          get() {
            getterRan = true;
            return 'poison';
          },
          enumerable: true,
          configurable: true,
        });

        const result = parseWorkerCommand(input);
        expect(result).toBeNull();
        expect(getterRan).toBe(false);
      }
    });

    it('rejects envelope setter property without executing setter', () => {
      let setterRan = false;
      const input = {
        protocolVersion: 1,
        jobId: 'job-setter',
        generation: 1,
        type: 'CANCEL',
      };
      Object.defineProperty(input, 'jobId', {
        set(_v) {
          setterRan = true;
        },
        enumerable: true,
        configurable: true,
      });

      const result = parseWorkerCommand(input);
      expect(result).toBeNull();
      expect(setterRan).toBe(false);
    });
  });

  // --- Group 7: Payload hostile getters and huge arrays remain untouched and unknown ---
  describe('Group 7: Payload hostile getters and huge arrays remain untouched and unknown', () => {
    it('does NOT evaluate getters inside the payload object and returns payload as unknown', () => {
      let toxicGetterInvoked = false;
      const hostilePayload = {
        format: 'csv',
        get toxicProperty() {
          toxicGetterInvoked = true;
          throw new Error('Hostile payload trap');
        },
      };

      const input = {
        protocolVersion: 1,
        jobId: 'job-payload-test',
        generation: 1,
        type: 'BEGIN',
        context: hostilePayload,
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('BEGIN');
      if (result && result.type === 'BEGIN') {
        // Assert payload reference identity is preserved
        expect(result.context).toBe(hostilePayload);
        // Assert the toxic payload getter was NEVER executed by parseWorkerCommand
        expect(toxicGetterInvoked).toBe(false);
      }
    });

    it('does NOT iterate, clone, or scan large payload arrays', () => {
      let touches = 0;
      const hugeArray = new Proxy(new Array(200_000), {
        get() { touches++; throw new Error('Payload array must stay untouched'); },
        ownKeys() { touches++; throw new Error('Payload array must stay untouched'); }
      });
      const input = {
        protocolVersion: 1,
        jobId: 'job-huge-array',
        generation: 1,
        type: 'APPEND',
        chunk: { values: hugeArray },
      };

      const result = parseWorkerCommand(input);

      expect(result).not.toBeNull();
      expect(touches).toBe(0);
      if (result && result.type === 'APPEND') {
        expect(result.chunk).toBe(input.chunk);
      }
    });

    it('accepts raw/unknown payloads without validating or asserting domain shapes', () => {
      // The parser must treat payload as unknown, leaving domain validation to reviewed helpers
      const rawPayloads = ['raw-string', 12345, null, undefined, { arbitrary: true }];

      for (const p of rawPayloads) {
        const input = {
          protocolVersion: 1,
          jobId: 'job-raw-payload',
          generation: 1,
          type: 'BEGIN',
          context: p,
        };
        const result = parseWorkerCommand(input);
        expect(result).not.toBeNull();
        if (result && result.type === 'BEGIN') {
          expect(result.context).toBe(p);
        }
      }
    });
  });

  // --- Group 8: Fresh frozen wrapper with payload identity preserved and input not frozen/mutated ---
  describe('Group 8: Fresh frozen wrapper with payload identity preserved and input not frozen/mutated', () => {
    it('returns a fresh frozen wrapper while keeping input and payload unfrozen and unmutated', () => {
      const payload = { sheetId: 1, rows: [1, 2] };
      const input = {
        protocolVersion: 1,
        jobId: 'job-freeze-test',
        generation: 1,
        type: 'BEGIN',
        context: payload,
      };

      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();

      // Result envelope must be a new frozen reference
      expect(result).not.toBe(input);
      expect(Object.isFrozen(result)).toBe(true);

      // Input envelope must NOT be mutated or frozen
      expect(Object.isFrozen(input)).toBe(false);
      expect(input.protocolVersion).toBe(1);
      expect(input.jobId).toBe('job-freeze-test');

      // Payload must NOT be frozen or mutated
      expect(Object.isFrozen(payload)).toBe(false);
      expect(result && result.type === 'BEGIN' && result.context === payload).toBe(true);
    });
  });

  // --- Group 9: Security boundaries, caller verification contract, and unverified worker aspects ---
  describe('Group 9: Caller verification contract and security boundaries', () => {
    it('envelope parser alone does NOT enforce chunk.jobId === envelope.jobId (caller contract)', () => {
      const mismatchedChunk = { jobId: 'different-job-id', rowIndex: 0 };
      const input = {
        protocolVersion: 1,
        jobId: 'job-main-envelope',
        generation: 1,
        type: 'APPEND',
        chunk: mismatchedChunk,
      };

      // Demonstrates envelope parser succeeds because payload is unknown, but caller MUST verify chunk.jobId
      const result = parseWorkerCommand(input);
      expect(result).not.toBeNull();
      if (result && result.type === 'APPEND') {
        expect(result.jobId).toBe('job-main-envelope');
        expect(result.chunk).toBe(mismatchedChunk);
        // Explicitly confirm caller obligation:
        expect((result.chunk as { jobId: string }).jobId).not.toBe(result.jobId);
      }
    });

    it('envelope parser alone does NOT enforce active worker job state or generation monotonicity', () => {
      // Out-of-order or stale generation envelopes still parse as valid envelope shapes
      const staleInput = {
        protocolVersion: 1,
        jobId: 'stale-job',
        generation: 0,
        type: 'CANCEL',
      };
      const result = parseWorkerCommand(staleInput);
      expect(result).not.toBeNull();
      // Caller/dispatcher is responsible for comparing against current active job state
    });
  });
});
