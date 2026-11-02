import { describe, it, expect } from 'vitest';
import type { ExportRequest, ExportScope } from '../../src/contracts/domain.ts';
import { buildScopePlan } from '../../src/domain/scope.ts';
import {
  parseExportRequest,
  PROVISIONAL_MAX_SHEETS,
} from '../../src/jobs/request-snapshot.ts';
import {
  createCanonicalSourceRef,
  createCanonicalWorkbookMeta,
  createSyntheticAccountContext,
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_PRINCIPAL_KEY,
  CANONICAL_LIMITS_VERSION,
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_EMPTY_SHEET_ID,
} from '../helpers/fixtures.ts';

function buildCanonicalTestRequest(): ExportRequest {
  return buildScopePlan(
    createCanonicalSourceRef(),
    createCanonicalWorkbookMeta(),
    createSyntheticAccountContext(),
    {
      mode: 'raw',
      format: 'json',
      visibility: 'include_all',
      limitsVersion: CANONICAL_LIMITS_VERSION,
    }
  );
}

describe('T30c Bounded Immutable Page Job Request Parser', () => {
  // Group 1: Valid requests built through actual buildScopePlan + canonical helpers, exact whole fields, freeze, and input isolation
  describe('Group 1: Valid requests, field fidelity, freezing, and input isolation', () => {
    it('parses valid request built through buildScopePlan with exact seven fields and deep freeze', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const parsed = parseExportRequest(canonicalReq);

      expect(parsed).not.toBeNull();
      if (!parsed) return;

      // Exact seven fields
      expect(parsed.sourceId).toBe(CANONICAL_SPREADSHEET_ID);
      expect(parsed.principalKey).toBe(CANONICAL_PRINCIPAL_KEY);
      expect(parsed.mode).toBe('raw');
      expect(parsed.format).toBe('json');
      expect(parsed.visibility).toBe('include_all');
      expect(parsed.limitsVersion).toBe(CANONICAL_LIMITS_VERSION);
      expect(parsed.scopes).toHaveLength(2);

      // Scopes complete values, types, and coordinates
      expect(parsed.scopes[0]).toEqual({
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: {
          sheetId: CANONICAL_SPARSE_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 90000,
          c1: 26,
        },
      });
      expect(parsed.scopes[1]).toEqual({
        sheetId: CANONICAL_EMPTY_SHEET_ID,
        rect: {
          sheetId: CANONICAL_EMPTY_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 1000,
          c1: 26,
        },
      });

      // Deep frozen assertions
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.scopes)).toBe(true);
      expect(Object.isFrozen(parsed.scopes[0])).toBe(true);
      expect(Object.isFrozen(parsed.scopes[0].rect)).toBe(true);
      expect(Object.isFrozen(parsed.scopes[1])).toBe(true);
      expect(Object.isFrozen(parsed.scopes[1].rect)).toBe(true);
    });

    it('preserves input isolation without mutating or freezing the input object', () => {
      const mutableInput = {
        sourceId: 'src-isolated',
        principalKey: 'pk-isolated',
        scopes: [
          {
            sheetId: 10,
            rect: { sheetId: 10, r0: 0, c0: 0, r1: 5, c1: 5 },
          },
        ],
        mode: 'formatted' as const,
        format: 'csv' as const,
        visibility: 'api_visible' as const,
        limitsVersion: 'v1.0',
      };

      const parsed = parseExportRequest(mutableInput);
      expect(parsed).not.toBeNull();

      // Input was not frozen
      expect(Object.isFrozen(mutableInput)).toBe(false);
      expect(Object.isFrozen(mutableInput.scopes)).toBe(false);
      expect(Object.isFrozen(mutableInput.scopes[0])).toBe(false);
      expect(Object.isFrozen(mutableInput.scopes[0].rect)).toBe(false);

      // Mutating input does not affect parsed snapshot
      mutableInput.sourceId = 'mutated';
      mutableInput.scopes[0].sheetId = 999;
      expect(parsed?.sourceId).toBe('src-isolated');
      expect(parsed?.scopes[0].sheetId).toBe(10);
    });

    it('preserves non-numeric source order and verbatim whitespace/casing', () => {
      // Non-numeric order: sheet 205 precedes sheet 101
      const wbMeta = createCanonicalWorkbookMeta();
      const reorderedWb = {
        ...wbMeta,
        sheets: [
          { ...wbMeta.sheets[1], index: 0 },
          { ...wbMeta.sheets[0], index: 1 },
        ],
      };

      const planned = buildScopePlan(
        createCanonicalSourceRef(),
        reorderedWb,
        createSyntheticAccountContext(),
        {
          mode: 'formula_text',
          format: 'xlsx',
          visibility: 'include_all',
          limitsVersion: '  untrimmed-limits-1.0  ',
        }
      );

      const customInput = {
        sourceId: '  source-id-with-spaces  ',
        principalKey: '  secret-opaque-key  ',
        scopes: planned.scopes,
        mode: planned.mode,
        format: planned.format,
        visibility: planned.visibility,
        limitsVersion: planned.limitsVersion,
      };

      const parsed = parseExportRequest(customInput);
      expect(parsed).not.toBeNull();
      if (!parsed) return;

      // Preserved verbatim without trimming
      expect(parsed.sourceId).toBe('  source-id-with-spaces  ');
      expect(parsed.principalKey).toBe('  secret-opaque-key  ');
      expect(parsed.limitsVersion).toBe('  untrimmed-limits-1.0  ');

      // Preserved source order: 205 then 101, NOT sorted by numeric ID
      expect(parsed.scopes[0].sheetId).toBe(CANONICAL_EMPTY_SHEET_ID);
      expect(parsed.scopes[1].sheetId).toBe(CANONICAL_SPARSE_SHEET_ID);
    });
  });

  // Group 2: Null records and non-object inputs
  describe('Group 2: Null records and non-object inputs', () => {
    it('accepts valid records with null prototypes for root, scope, and rect', () => {
      const canonicalReq = buildCanonicalTestRequest();

      const nullRect = Object.assign(Object.create(null), {
        sheetId: 1,
        r0: 0,
        c0: 0,
        r1: 10,
        c1: 10,
      });

      const nullScope = Object.assign(Object.create(null), {
        sheetId: 1,
        rect: nullRect,
      });

      const nullReq = Object.assign(Object.create(null), {
        sourceId: canonicalReq.sourceId,
        principalKey: canonicalReq.principalKey,
        scopes: [nullScope],
        mode: canonicalReq.mode,
        format: canonicalReq.format,
        visibility: canonicalReq.visibility,
        limitsVersion: canonicalReq.limitsVersion,
      });

      const parsed = parseExportRequest(nullReq);
      expect(parsed).not.toBeNull();
      expect(parsed?.scopes[0].sheetId).toBe(1);
      expect(parsed?.scopes[0].rect).toEqual({
        sheetId: 1,
        r0: 0,
        c0: 0,
        r1: 10,
        c1: 10,
      });
    });

    it('safely returns null for null, undefined, primitives, and non-plain prototypes', () => {
      expect(parseExportRequest(null)).toBeNull();
      expect(parseExportRequest(undefined)).toBeNull();
      expect(parseExportRequest(42)).toBeNull();
      expect(parseExportRequest('request-string')).toBeNull();
      expect(parseExportRequest(true)).toBeNull();
      expect(parseExportRequest(Symbol('sym'))).toBeNull();
      expect(parseExportRequest(() => {})).toBeNull();
      expect(parseExportRequest([1, 2, 3])).toBeNull();

      // Non-plain prototypes
      class FakeRequest {}
      const fakeObj = new FakeRequest();
      Object.assign(fakeObj, buildCanonicalTestRequest());
      expect(parseExportRequest(fakeObj)).toBeNull();

      const foreignProtoObj = Object.create({ inherited: true });
      Object.assign(foreignProtoObj, buildCanonicalTestRequest());
      expect(parseExportRequest(foreignProtoObj)).toBeNull();
    });
  });

  // Group 3: Descriptor values captured once with full values/types
  describe('Group 3: Descriptor values captured once with full values and types', () => {
    it('reads property descriptors exactly once per key on root, array, scope, and rect', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const rootDescCalls: string[] = [];

      const trackedRoot = new Proxy(canonicalReq, {
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop === 'string') {
            rootDescCalls.push(prop);
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });

      const parsed = parseExportRequest(trackedRoot);
      expect(parsed).not.toBeNull();

      // Exactly 7 descriptor calls on root, once per key
      const expectedKeys = [
        'sourceId',
        'principalKey',
        'scopes',
        'mode',
        'format',
        'visibility',
        'limitsVersion',
      ];
      expect(rootDescCalls.sort()).toEqual(expectedKeys.sort());
    });

    it('asserts complete values and types on captured snapshot', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const parsed = parseExportRequest(canonicalReq);
      expect(parsed).not.toBeNull();
      if (!parsed) return;

      expect(typeof parsed.sourceId).toBe('string');
      expect(typeof parsed.principalKey).toBe('string');
      expect(typeof parsed.mode).toBe('string');
      expect(typeof parsed.format).toBe('string');
      expect(typeof parsed.visibility).toBe('string');
      expect(typeof parsed.limitsVersion).toBe('string');
      expect(Array.isArray(parsed.scopes)).toBe(true);

      for (const scope of parsed.scopes) {
        expect(typeof scope.sheetId).toBe('number');
        expect(Number.isSafeInteger(scope.sheetId)).toBe(true);
        expect(typeof scope.rect).toBe('object');
        expect(scope.rect.sheetId).toBe(scope.sheetId);
        expect(typeof scope.rect.r0).toBe('number');
        expect(typeof scope.rect.c0).toBe('number');
        expect(typeof scope.rect.r1).toBe('number');
        expect(typeof scope.rect.c1).toBe('number');
        expect(Number.isSafeInteger(scope.rect.r0)).toBe(true);
        expect(Number.isSafeInteger(scope.rect.c0)).toBe(true);
        expect(Number.isSafeInteger(scope.rect.r1)).toBe(true);
        expect(Number.isSafeInteger(scope.rect.c1)).toBe(true);
      }
    });
  });

  // Group 4: Envelope/scope/rect getter zero invocations and masks/extras/prototype/traps safely rejected
  describe('Group 4: Getter zero invocations, masks, extras, prototype pollution, and traps', () => {
    it('rejects hostile getters on root fields with zero getter invocations', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const keys = [
        'sourceId',
        'principalKey',
        'scopes',
        'mode',
        'format',
        'visibility',
        'limitsVersion',
      ] as const;

      for (const key of keys) {
        let getterCalls = 0;
        const badObj = { ...canonicalReq };
        Object.defineProperty(badObj, key, {
          get() {
            getterCalls++;
            throw new Error(`Hostile getter for ${key}`);
          },
          enumerable: true,
          configurable: true,
        });

        expect(parseExportRequest(badObj)).toBeNull();
        expect(getterCalls).toBe(0);
      }
    });

    it('rejects hostile getters on scope and rect fields with zero getter invocations', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Getter on scope.sheetId
      let scopeGetterCalls = 0;
      const badScope: any = { ...canonicalReq.scopes[0] };
      Object.defineProperty(badScope, 'sheetId', {
        get() {
          scopeGetterCalls++;
          throw new Error('Hostile scope getter');
        },
        enumerable: true,
        configurable: true,
      });
      expect(
        parseExportRequest({ ...canonicalReq, scopes: [badScope] })
      ).toBeNull();
      expect(scopeGetterCalls).toBe(0);

      // Getter on rect.r0
      let rectGetterCalls = 0;
      const badRect: any = { ...canonicalReq.scopes[0].rect };
      Object.defineProperty(badRect, 'r0', {
        get() {
          rectGetterCalls++;
          throw new Error('Hostile rect getter');
        },
        enumerable: true,
        configurable: true,
      });
      const scopeWithBadRect = {
        sheetId: canonicalReq.scopes[0].sheetId,
        rect: badRect,
      };
      expect(
        parseExportRequest({ ...canonicalReq, scopes: [scopeWithBadRect] })
      ).toBeNull();
      expect(rectGetterCalls).toBe(0);
    });

    it('rejects extra properties, symbols, non-enumerable, and inherited properties on root, scope, and rect', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Extra property on root
      expect(
        parseExportRequest({ ...canonicalReq, sheetOrder: [101] })
      ).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, extraField: 'bad' })).toBeNull();

      // Symbol property on root
      expect(
        parseExportRequest({ ...canonicalReq, [Symbol('leak')]: 'bad' })
      ).toBeNull();

      // Non-enumerable required property on root
      const nonEnumReq = { ...canonicalReq };
      Object.defineProperty(nonEnumReq, 'mode', {
        value: 'raw',
        enumerable: false,
        configurable: true,
      });
      expect(parseExportRequest(nonEnumReq)).toBeNull();

      // Inherited required property (not own property)
      const protoParent = { mode: 'raw' as const };
      const inheritedReq = Object.create(protoParent);
      Object.assign(inheritedReq, {
        sourceId: canonicalReq.sourceId,
        principalKey: canonicalReq.principalKey,
        scopes: canonicalReq.scopes,
        format: canonicalReq.format,
        visibility: canonicalReq.visibility,
        limitsVersion: canonicalReq.limitsVersion,
      });
      expect(parseExportRequest(inheritedReq)).toBeNull();

      // Extra property on scope
      const extraScope = { ...canonicalReq.scopes[0], extraProp: 'bad' };
      expect(
        parseExportRequest({ ...canonicalReq, scopes: [extraScope] })
      ).toBeNull();

      // Symbol on scope
      const symScope = { ...canonicalReq.scopes[0], [Symbol('bad')]: 1 };
      expect(
        parseExportRequest({ ...canonicalReq, scopes: [symScope] })
      ).toBeNull();

      // Extra property on rect
      const extraRect = { ...canonicalReq.scopes[0].rect, extraCoord: 0 };
      expect(
        parseExportRequest({
          ...canonicalReq,
          scopes: [{ sheetId: canonicalReq.scopes[0].sheetId, rect: extraRect }],
        })
      ).toBeNull();

      // Symbol on rect
      const symRect = { ...canonicalReq.scopes[0].rect, [Symbol('bad')]: 0 };
      expect(
        parseExportRequest({
          ...canonicalReq,
          scopes: [{ sheetId: canonicalReq.scopes[0].sheetId, rect: symRect }],
        })
      ).toBeNull();
    });

    it('rejects root credential fields and prototype pollution without invoking getters', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const forbiddenCreds = [
        'accessToken',
        'refreshToken',
        'token',
        'displayEmail',
        'email',
        'principal',
        'authorization',
        'headers',
        'account',
        'auth',
        'password',
        'clientSecret',
        'client_secret',
        'bearer',
      ] as const;

      for (const cred of forbiddenCreds) {
        expect(
          parseExportRequest({ ...canonicalReq, [cred]: 'secret-token' })
        ).toBeNull();
      }

      // Prototype pollution check: polluting Object.prototype with forbidden credential
      let credGetterCalls = 0;
      Object.defineProperty(Object.prototype, 'accessToken', {
        get() {
          credGetterCalls++;
          return 'polluted-token';
        },
        configurable: true,
      });

      try {
        expect(parseExportRequest(canonicalReq)).toBeNull();
        // Presence check with 'in' operator MUST NOT invoke the getter
        expect(credGetterCalls).toBe(0);
      } finally {
        delete (Object.prototype as any).accessToken;
      }
    });

    it('safely catches throwing proxy traps and returns null', () => {
      const canonicalReq = buildCanonicalTestRequest();

      const throwingOwnKeys = new Proxy(canonicalReq, {
        ownKeys() {
          throw new Error('Hostile ownKeys trap');
        },
      });
      expect(parseExportRequest(throwingOwnKeys)).toBeNull();

      const throwingHas = new Proxy(canonicalReq, {
        has() {
          throw new Error('Hostile has trap');
        },
      });
      expect(parseExportRequest(throwingHas)).toBeNull();
    });
  });

  // Group 5: Enums, IDs, coordinates, -0, duplicates, empty, and reversed
  describe('Group 5: Enums, IDs, coordinates, -0, duplicates, and empty/reversed bounds', () => {
    it('rejects invalid enums and empty strings', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Invalid enums
      expect(parseExportRequest({ ...canonicalReq, mode: 'invalid' })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, format: 'invalid' })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, visibility: 'invalid' })).toBeNull();

      // Empty strings
      expect(parseExportRequest({ ...canonicalReq, sourceId: '' })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, principalKey: '' })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, limitsVersion: '' })).toBeNull();

      // Non-string values for string fields
      expect(parseExportRequest({ ...canonicalReq, sourceId: 123 })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, principalKey: null })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, limitsVersion: true })).toBeNull();
    });

    it('rejects -0, negative coordinates, floats, and non-safe integers', () => {
      const canonicalReq = buildCanonicalTestRequest();

      function reqWithRect(rectOverrides: Partial<ExportScope['rect']>): unknown {
        const baseScope = canonicalReq.scopes[0];
        const newRect = { ...baseScope.rect, ...rectOverrides };
        return {
          ...canonicalReq,
          scopes: [{ sheetId: newRect.sheetId, rect: newRect }],
        };
      }

      // Negative coordinates
      expect(parseExportRequest(reqWithRect({ r0: -1 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ c0: -1 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ sheetId: -1 }))).toBeNull();

      // -0 rejection
      expect(parseExportRequest(reqWithRect({ r0: -0 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ c0: -0 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ r1: -0 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ c1: -0 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ sheetId: -0 }))).toBeNull();

      // Floats and NaN / Infinity
      expect(parseExportRequest(reqWithRect({ r0: 1.5 }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ c1: NaN }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ r1: Infinity }))).toBeNull();
      expect(parseExportRequest(reqWithRect({ c0: -Infinity }))).toBeNull();
    });

    it('rejects duplicate sheet IDs and mismatched scope/rect sheet IDs', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Duplicate sheet IDs
      const duplicateScope = {
        sheetId: CANONICAL_SPARSE_SHEET_ID,
        rect: {
          sheetId: CANONICAL_SPARSE_SHEET_ID,
          r0: 0,
          c0: 0,
          r1: 10,
          c1: 10,
        },
      };
      expect(
        parseExportRequest({
          ...canonicalReq,
          scopes: [canonicalReq.scopes[0], duplicateScope],
        })
      ).toBeNull();

      // Mismatched scope.sheetId vs rect.sheetId
      const mismatchedScope = {
        sheetId: 101,
        rect: { sheetId: 102, r0: 0, c0: 0, r1: 10, c1: 10 },
      };
      expect(
        parseExportRequest({
          ...canonicalReq,
          scopes: [mismatchedScope],
        })
      ).toBeNull();
    });

    it('rejects reversed or empty rectangle intervals (r1 <= r0 or c1 <= c0)', () => {
      const canonicalReq = buildCanonicalTestRequest();

      function reqWithCoords(r0: number, c0: number, r1: number, c1: number): unknown {
        return {
          ...canonicalReq,
          scopes: [
            {
              sheetId: 1,
              rect: { sheetId: 1, r0, c0, r1, c1 },
            },
          ],
        };
      }

      // Empty intervals (r1 == r0 or c1 == c0)
      expect(parseExportRequest(reqWithCoords(10, 0, 10, 5))).toBeNull();
      expect(parseExportRequest(reqWithCoords(0, 5, 10, 5))).toBeNull();

      // Reversed intervals (r1 < r0 or c1 < c0)
      expect(parseExportRequest(reqWithCoords(10, 0, 5, 5))).toBeNull();
      expect(parseExportRequest(reqWithCoords(0, 10, 5, 5))).toBeNull();
    });
  });

  // Group 6: Huge safe endpoints no area allocation
  describe('Group 6: Huge safe endpoints without area allocation or chunk materialization', () => {
    it('accepts safe integer endpoints up to MAX_SAFE_INTEGER without area overflow', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const hugeReq = {
        ...canonicalReq,
        scopes: [
          {
            sheetId: 1,
            rect: {
              sheetId: 1,
              r0: 0,
              c0: 0,
              r1: Number.MAX_SAFE_INTEGER,
              c1: Number.MAX_SAFE_INTEGER,
            },
          },
        ],
      };

      const parsed = parseExportRequest(hugeReq);
      expect(parsed).not.toBeNull();
      expect(parsed?.scopes[0].rect.r1).toBe(Number.MAX_SAFE_INTEGER);
      expect(parsed?.scopes[0].rect.c1).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('accepts large non-zero origin safe coordinates', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const largeReq = {
        ...canonicalReq,
        scopes: [
          {
            sheetId: 5,
            rect: {
              sheetId: 5,
              r0: 10_000_000,
              c0: 100_000,
              r1: 20_000_000,
              c1: 200_000,
            },
          },
        ],
      };

      const parsed = parseExportRequest(largeReq);
      expect(parsed).not.toBeNull();
      expect(parsed?.scopes[0].rect).toEqual({
        sheetId: 5,
        r0: 10_000_000,
        c0: 100_000,
        r1: 20_000_000,
        c1: 200_000,
      });
    });
  });

  // Group 7: Array key mask attack and bounds check before descriptors
  describe('Group 7: Array key mask attacks, bounds checking, and element allocation guards', () => {
    it('bounds scopes array length (1..4096) before inspecting elements or allocating descriptors', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Empty scopes array length 0
      expect(parseExportRequest({ ...canonicalReq, scopes: [] })).toBeNull();

      // Over-bound array length 4097 rejected before reading elements
      let elementReads = 0;
      const overBoundArray = new Proxy(new Array(PROVISIONAL_MAX_SHEETS + 1), {
        get(target, key, receiver) {
          if (key === 'length') return PROVISIONAL_MAX_SHEETS + 1;
          elementReads++;
          return Reflect.get(target, key, receiver);
        },
      });

      expect(
        parseExportRequest({ ...canonicalReq, scopes: overBoundArray })
      ).toBeNull();
      expect(elementReads).toBe(0);
    });

    it('rejects array key mask attacks, symbols, extra keys, and non-canonical index keys', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Extra property on scopes array
      const arrWithExtra = [...canonicalReq.scopes];
      (arrWithExtra as any).mask = 'attack';
      expect(parseExportRequest({ ...canonicalReq, scopes: arrWithExtra })).toBeNull();

      // Non-canonical index key '01'
      const arrNonCanonical = [...canonicalReq.scopes];
      Object.defineProperty(arrNonCanonical, '01', {
        value: canonicalReq.scopes[0],
        enumerable: true,
        configurable: true,
      });
      expect(parseExportRequest({ ...canonicalReq, scopes: arrNonCanonical })).toBeNull();

      // Negative index key '-1'
      const arrNegative = [...canonicalReq.scopes];
      (arrNegative as any)['-1'] = canonicalReq.scopes[0];
      expect(parseExportRequest({ ...canonicalReq, scopes: arrNegative })).toBeNull();

      // Symbol key on array
      const arrSymbol = [...canonicalReq.scopes];
      (arrSymbol as any)[Symbol('attack')] = canonicalReq.scopes[0];
      expect(parseExportRequest({ ...canonicalReq, scopes: arrSymbol })).toBeNull();
    });

    it('rejects sparse arrays with missing element descriptors', () => {
      const canonicalReq = buildCanonicalTestRequest();
      const validScope = canonicalReq.scopes[0];

      // Sparse array: length 3, index 1 missing
      const sparseScopes: ExportScope[] = [validScope];
      sparseScopes[2] = { ...validScope, sheetId: 99 };
      expect(parseExportRequest({ ...canonicalReq, scopes: sparseScopes })).toBeNull();
    });

    it('rejects accessors on array length or indices', () => {
      const canonicalReq = buildCanonicalTestRequest();

      // Accessor on array length
      const arrWithLengthGetter = new Proxy([...canonicalReq.scopes], {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'length') {
            return {
              get() {
                return 1;
              },
              enumerable: false,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      });
      expect(
        parseExportRequest({ ...canonicalReq, scopes: arrWithLengthGetter })
      ).toBeNull();

      // Accessor on array index
      const arrWithIndexGetter = [...canonicalReq.scopes];
      Object.defineProperty(arrWithIndexGetter, '0', {
        get() {
          return canonicalReq.scopes[0];
        },
        enumerable: true,
        configurable: true,
      });
      expect(
        parseExportRequest({ ...canonicalReq, scopes: arrWithIndexGetter })
      ).toBeNull();
    });

    it('rejects non-array scopes or modified array prototypes', () => {
      const canonicalReq = buildCanonicalTestRequest();

      expect(parseExportRequest({ ...canonicalReq, scopes: {} })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, scopes: 'scopes' })).toBeNull();
      expect(parseExportRequest({ ...canonicalReq, scopes: null })).toBeNull();

      const customArray = [...canonicalReq.scopes];
      Object.setPrototypeOf(customArray, { customProto: true });
      expect(parseExportRequest({ ...canonicalReq, scopes: customArray })).toBeNull();
    });
  });
});
