import { describe, it, expect } from 'vitest';
import { SAFE_ERROR_MESSAGES } from '../../src/contracts/errors.ts';
import {
  snapshotExportReport,
  MAX_JSON_NODES,
  MAX_JSON_DEPTH
} from '../../src/export/report-snapshot.ts';
import { createCanonicalExportReport } from '../helpers/fixtures.ts';

function isDeepFrozen(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return true;
  if (!Object.isFrozen(obj)) return false;
  if (Array.isArray(obj)) {
    return obj.every(isDeepFrozen);
  }
  for (const key of Object.keys(obj)) {
    if (!isDeepFrozen((obj as Record<string, unknown>)[key])) return false;
  }
  return true;
}

describe('snapshotExportReport', () => {
  const defaultSignal = new AbortController().signal;
  const defaultOptions = { signal: defaultSignal, maxNodes: MAX_JSON_NODES };
  it('accepts the exact JSON node budget, including a final empty array', () => {
    const input = createCanonicalExportReport();
    const count = (value: unknown): number => 1 + (value !== null && typeof value === 'object'
      ? Object.values(value).reduce<number>((sum, child) => sum + count(child), 0) : 0);
    const maxNodes = count(input);
    expect(snapshotExportReport(input, { signal: defaultSignal, maxNodes })).toEqual(input);
    expect(() => snapshotExportReport(input, { signal: defaultSignal, maxNodes: maxNodes - 1 }))
      .toThrow(expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' }));
  });

  it('checks every actual array key when a proxy masks a valid configurable index', () => {
    for (const extra of ['extra', Symbol('extra')]) {
      const input = createCanonicalExportReport();
      const array = [...input.sheetOrder];
      Object.defineProperty(array, extra, { enumerable: true, configurable: true, value: 'private' });
      const proxy = new Proxy(array, { ownKeys: target => Reflect.ownKeys(target).filter(key => key !== '1') });
      const malicious = { ...input, sheetOrder: proxy };
      expect(() => snapshotExportReport(malicious, defaultOptions))
        .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
    }
  });

  it('contains an abort-state getter that throws after its initial capture', () => {
    let reads = 0;
    const signal = { get aborted() {
      if (++reads === 1) return false;
      throw new Error('private abort diagnostic');
    }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    expect(() => snapshotExportReport(createCanonicalExportReport(), { signal, maxNodes: MAX_JSON_NODES }))
      .toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED', message: SAFE_ERROR_MESSAGES.FORMAT_SERIALIZATION_FAILED }));
    expect(reads).toBe(2);
  });

  // Group 1: All known report fields unchanged / deep frozen / input mutation isolation
  describe('Group 1: Known fields, deep freeze, and mutation isolation', () => {
    it('captures canonical export report with exact field fidelity', () => {
      const canonical = createCanonicalExportReport();
      const snapshot = snapshotExportReport(canonical, defaultOptions);

      expect(snapshot).toEqual(canonical);
      expect(snapshot).not.toBe(canonical);
      expect(snapshot.source).not.toBe(canonical.source);
      expect(snapshot.export).not.toBe(canonical.export);
      expect(snapshot.selectedScopes).not.toBe(canonical.selectedScopes);
      expect(snapshot.sheetOrder).not.toBe(canonical.sheetOrder);
      expect(snapshot.nameMappings).not.toBe(canonical.nameMappings);
      expect(snapshot.exclusions).not.toBe(canonical.exclusions);
    });

    it('ensures all returned containers are deeply frozen', () => {
      const canonical = createCanonicalExportReport();
      const snapshot = snapshotExportReport(canonical, defaultOptions);

      expect(isDeepFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.source)).toBe(true);
      expect(Object.isFrozen(snapshot.export)).toBe(true);
      expect(Object.isFrozen(snapshot.selectedScopes)).toBe(true);
      expect(Object.isFrozen(snapshot.sheetOrder)).toBe(true);
      expect(Object.isFrozen(snapshot.nameMappings)).toBe(true);
      expect(Object.isFrozen(snapshot.exclusions)).toBe(true);
      if (snapshot.sourceObservations) {
        expect(Object.isFrozen(snapshot.sourceObservations)).toBe(true);
      }
    });

    it('isolates output from post-call input mutations without freezing input', () => {
      const input = createCanonicalExportReport();
      expect(Object.isFrozen(input)).toBe(false);

      const snapshot = snapshotExportReport(input, defaultOptions);
      expect(Object.isFrozen(input)).toBe(false);

      // Mutate input fields
      (input as any).schemaVersion = '9.9';
      (input.source as any).id = 'mutated-source-id';
      (input.sheetOrder as number[]).push(999);
      (input.export.warnings as any[]).push({ code: 'W', message: 'mutated' });

      expect(snapshot.schemaVersion).toBe('1.0');
      expect(snapshot.source.id).toBe('synthetic-canonical-wb-001');
      expect(snapshot.sheetOrder).toEqual([101, 205]);
      expect(snapshot.export.warnings).toEqual([]);
    });
  });

  // Group 2: Descriptor Proxy changing value captured once incl nested metadata
  describe('Group 2: Descriptor proxy changing value captured once', () => {
    it('captures changing descriptor value exactly once and preserves complete expected object', () => {
      const canonical = createCanonicalExportReport();
      let descriptorReads = 0;
      const originalSource = canonical.source;

      // Wrap source in a proxy where getOwnPropertyDescriptor returns fresh data descriptor once
      const proxiedSource = new Proxy(originalSource, {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'id') {
            descriptorReads++;
            return {
              value: descriptorReads === 1 ? 'initial-captured-id' : 'changed-descriptor-id',
              writable: true,
              enumerable: true,
              configurable: true
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });

      const input = { ...canonical, source: proxiedSource };
      const snapshot = snapshotExportReport(input, defaultOptions);

      expect(descriptorReads).toBe(1);
      expect(snapshot.source.id).toBe('initial-captured-id');
      expect(snapshot.source.title).toBe(canonical.source.title);
      expect(snapshot.source.locale).toBe(canonical.source.locale);
      expect(snapshot.source.timeZone).toBe(canonical.source.timeZone);
      expect(Object.isFrozen(snapshot.source)).toBe(true);
    });
  });

  // Group 3: Hostile getter zero calls
  describe('Group 3: Hostile getter zero calls', () => {
    it('rejects getters on root or nested properties with 0 invocations', () => {
      const canonical = createCanonicalExportReport();
      let getterCalls = 0;

      Object.defineProperty(canonical.source, 'id', {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls++;
          return 'hostile-getter-value';
        }
      });

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(getterCalls).toBe(0);
    });

    it('rejects setters without getter with 0 invocations', () => {
      const canonical = createCanonicalExportReport();
      let setterCalls = 0;

      Object.defineProperty(canonical.source, 'id', {
        enumerable: true,
        configurable: true,
        set(_v) {
          setterCalls++;
        }
      });

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(setterCalls).toBe(0);
    });

    it('rejects getters on array elements with 0 invocations', () => {
      const canonical = createCanonicalExportReport();
      let arrayGetterCalls = 0;

      Object.defineProperty(canonical.sheetOrder, '0', {
        enumerable: true,
        configurable: true,
        get() {
          arrayGetterCalls++;
          return 1;
        }
      });

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(arrayGetterCalls).toBe(0);
    });
  });

  // Group 4: Symbol / extras / auth fields schema fail
  describe('Group 4: Symbols, extra properties, and credential fields fail', () => {
    it('rejects symbol properties on input objects', () => {
      const canonical = createCanonicalExportReport();
      (canonical as any)[Symbol('evil')] = 'symbol-value';

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects unknown/extra properties via schema validation', () => {
      const canonical = createCanonicalExportReport();
      (canonical as any).extraProperty = 'not-in-schema';

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects auth/credential fields at root and nested levels', () => {
      const authKeys = ['accessToken', 'refreshToken', 'principalKey', 'token', 'authorization'];

      for (const key of authKeys) {
        const rootInput = createCanonicalExportReport();
        (rootInput as any)[key] = 'secret';
        expect(() => snapshotExportReport(rootInput, defaultOptions)).toThrow(
          expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
        );

        const sourceInput = createCanonicalExportReport();
        (sourceInput.source as any)[key] = 'secret';
        expect(() => snapshotExportReport(sourceInput, defaultOptions)).toThrow(
          expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
        );

        const exportInput = createCanonicalExportReport();
        (exportInput.export as any)[key] = 'secret';
        expect(() => snapshotExportReport(exportInput, defaultOptions)).toThrow(
          expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
        );
      }
    });
  });

  // Group 5: Sparse / extra arrays / cycles / shared acyclic / node / depth guards
  describe('Group 5: Arrays, cycles, shared acyclic, and node/depth bounds', () => {
    it('rejects sparse arrays with holes', () => {
      const canonical = createCanonicalExportReport();
      const sparseArr: any[] = [1, , 2]; // sparse
      (canonical as any).sheetOrder = sparseArr;

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects arrays with extra non-index properties', () => {
      const canonical = createCanonicalExportReport();
      const extraArr: any = [1, 2];
      extraArr.foo = 'extra';
      (canonical as any).sheetOrder = extraArr;

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects cyclic references', () => {
      const canonical = createCanonicalExportReport();
      (canonical as any).self = canonical;

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('supports shared acyclic references by copying each occurrence', () => {
      const canonical = createCanonicalExportReport();
      const sharedWarning = { code: 'W1', message: 'shared-warning' };
      (canonical.export as any).warnings = [sharedWarning, sharedWarning];

      const snapshot = snapshotExportReport(canonical, defaultOptions);
      expect(snapshot.export.warnings.length).toBe(2);
      expect(snapshot.export.warnings[0]).toEqual(sharedWarning);
      expect(snapshot.export.warnings[1]).toEqual(sharedWarning);
      expect(snapshot.export.warnings[0]).not.toBe(snapshot.export.warnings[1]);
    });

    it('enforces node limit cap and bounds before allocation', () => {
      const canonical = createCanonicalExportReport();

      // Too small maxNodes
      expect(() => snapshotExportReport(canonical, { signal: defaultSignal, maxNodes: 5 })).toThrow(
        expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' })
      );
    });

    it('enforces depth limit cap exceeding MAX_JSON_DEPTH (32)', () => {
      expect(MAX_JSON_DEPTH).toBe(32);
      let deep: any = { leaf: 42 };
      for (let i = 0; i < 35; i++) {
        deep = { child: deep };
      }

      expect(() => snapshotExportReport(deep, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'SIZE_LIMIT_EXCEEDED' })
      );
    });
  });

  // Group 6: Options validation and lifecycle abort fences
  describe('Group 6: Options capture and cancellation fences', () => {
    it('captures options properties once and rejects invalid configs', () => {
      const canonical = createCanonicalExportReport();

      // Null or non-object options
      expect(() => snapshotExportReport(canonical, null as any)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );
      expect(() => snapshotExportReport(canonical, [] as any)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' })
      );

      // Bad maxNodes
      for (const badNodes of [0, -1, -0, 1.5, NaN, Infinity, MAX_JSON_NODES + 1, '10']) {
        expect(() => snapshotExportReport(canonical, { signal: defaultSignal, maxNodes: badNodes as any })).toThrow(
          expect.objectContaining({ code: 'CONFIG_INVALID' })
        );
      }

      // Bad signal
      for (const badSignal of [null, undefined, {}, { aborted: 'not-bool' }]) {
        expect(() => snapshotExportReport(canonical, { signal: badSignal as any, maxNodes: 1000 })).toThrow(
          expect.objectContaining({ code: 'CONFIG_INVALID' })
        );
      }
    });

    it('rejects with OPERATION_ABORTED when signal is already aborted', () => {
      const canonical = createCanonicalExportReport();
      const ac = new AbortController();
      ac.abort();

      expect(() => snapshotExportReport(canonical, { signal: ac.signal, maxNodes: 1000 })).toThrow(
        expect.objectContaining({ code: 'OPERATION_ABORTED' })
      );
    });

    it('aborts during traversal when signal is triggered', () => {
      const canonical = createCanonicalExportReport();
      const ac = new AbortController();

      const proxied = new Proxy(canonical.source, {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'locale') ac.abort();
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      });

      expect(() =>
        snapshotExportReport({ ...canonical, source: proxied }, { signal: ac.signal, maxNodes: 1000 })
      ).toThrow(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
    });

    it('traps proxy throws and safely remaps to FORMAT_SERIALIZATION_FAILED', () => {
      const canonical = createCanonicalExportReport();
      const hostile = new Proxy(canonical.source, {
        getOwnPropertyDescriptor() {
          throw new Error('hostile error in trap');
        }
      });

      expect(() =>
        snapshotExportReport({ ...canonical, source: hostile }, defaultOptions)
      ).toThrow(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
    });
  });

  // Group 7: Generic capture and prototype purity
  describe('Group 7: Prototype purity, toJSON rejection, and non-native JSON primitives', () => {
    it('accepts null prototype records', () => {
      const canonical = createCanonicalExportReport();
      const nullProtoSource = Object.assign(Object.create(null), canonical.source);
      const input = { ...canonical, source: nullProtoSource };

      const snapshot = snapshotExportReport(input, defaultOptions);
      expect(snapshot.source.id).toBe(canonical.source.id);
      expect(Object.isFrozen(snapshot.source)).toBe(true);
    });

    it('rejects custom classes and prototypes', () => {
      const canonical = createCanonicalExportReport();
      class CustomSource {
        id = 'custom';
        title = 'custom';
        locale = 'en';
        timeZone = 'UTC';
      }
      const input = { ...canonical, source: new CustomSource() as any };

      expect(() => snapshotExportReport(input, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects toJSON on input objects without invoking it', () => {
      const canonical = createCanonicalExportReport();
      let toJSONCalls = 0;
      (canonical as any).toJSON = () => {
        toJSONCalls++;
        return {};
      };

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
      expect(toJSONCalls).toBe(0);
    });

    it('rejects prototype pollution of toJSON on Object.prototype without invoking', () => {
      const canonical = createCanonicalExportReport();
      let pollutedCalls = 0;
      try {
        (Object.prototype as any).toJSON = () => {
          pollutedCalls++;
          return {};
        };

        expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
          expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
        );
        expect(pollutedCalls).toBe(0);
      } finally {
        delete (Object.prototype as any).toJSON;
      }
    });

    it('rejects non-native JSON primitives like undefined values, BigInt, functions', () => {
      const canonical = createCanonicalExportReport();
      (canonical as any).undefField = undefined;

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );

      const canonical2 = createCanonicalExportReport();
      (canonical2 as any).bigintField = 100n;

      expect(() => snapshotExportReport(canonical2, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });

    it('rejects non-finite numbers like NaN, Infinity, -Infinity', () => {
      const canonical = createCanonicalExportReport();
      (canonical.export.warnings as any) = [{ code: 'W', message: 'msg', sheetId: NaN }];

      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );

      (canonical.export.warnings as any) = [{ code: 'W', message: 'msg', sheetId: Infinity }];
      expect(() => snapshotExportReport(canonical, defaultOptions)).toThrow(
        expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' })
      );
    });
  });
});
