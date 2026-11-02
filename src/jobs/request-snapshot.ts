/**
 * T30c Bounded Immutable Page Job Request Parser
 *
 * Parses and validates an untrusted input into an immutable, deep-frozen ExportRequest.
 * Pure bounded structural snapshot:
 * - Grants no permission, source, account, metadata, or order authority.
 * - Invalid shapes, values, or throwing traps return null safely (no diagnostics/logs).
 * - Creates fresh deep-frozen known-field copies; never mutates or freezes input.
 * - This page-only request intentionally contains principalKey; it MUST NOT be sent to worker.
 *   Later WriterContext projection drops principalKey across worker boundaries.
 */

import type {
  ExportRequest,
  ExportScope,
} from '../contracts/domain.ts';

import { PROVISIONAL_MAX_SHEETS } from '../export/context.ts';
export { PROVISIONAL_MAX_SHEETS };

const REQUEST_KEYS = [
  'sourceId',
  'principalKey',
  'scopes',
  'mode',
  'format',
  'visibility',
  'limitsVersion',
] as const;

const REQUEST_KEY_SET = new Set<string>(REQUEST_KEYS);

const SCOPE_KEYS = ['sheetId', 'rect'] as const;
const SCOPE_KEY_SET = new Set<string>(SCOPE_KEYS);

const RECT_KEYS = ['sheetId', 'r0', 'c0', 'r1', 'c1'] as const;
const RECT_KEY_SET = new Set<string>(RECT_KEYS);

const FORBIDDEN_ROOT_CREDENTIAL_KEYS = [
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

function isNonNegativeSafeInt(val: unknown): val is number {
  return (
    typeof val === 'number' &&
    Number.isSafeInteger(val) &&
    val >= 0 &&
    !Object.is(val, -0)
  );
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const val = (obj as Record<string, unknown>)[keys[i]];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Parses and returns an immutable, deep-frozen ExportRequest snapshot from untrusted input,
 * or null if input shape, fields, types, coordinates, or constraints are invalid.
 */
export function parseExportRequest(input: unknown): ExportRequest | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return null;
    }

    // Reject prototype pollution / non-plain records
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      return null;
    }

    // Root credential presence checks without reading property values
    for (let i = 0; i < FORBIDDEN_ROOT_CREDENTIAL_KEYS.length; i++) {
      if (FORBIDDEN_ROOT_CREDENTIAL_KEYS[i] in input) {
        return null;
      }
    }

    // Exact seven own enumerable data fields check
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== REQUEST_KEYS.length) {
      return null;
    }
    for (let i = 0; i < ownKeys.length; i++) {
      const k = ownKeys[i];
      if (typeof k !== 'string' || !REQUEST_KEY_SET.has(k)) {
        return null;
      }
    }

    // Capture each descriptor ONCE into local container, rejecting accessors and non-enumerable properties
    let capturedSourceId: unknown;
    let capturedPrincipalKey: unknown;
    let capturedScopes: unknown;
    let capturedMode: unknown;
    let capturedFormat: unknown;
    let capturedVisibility: unknown;
    let capturedLimitsVersion: unknown;

    for (let i = 0; i < REQUEST_KEYS.length; i++) {
      const key = REQUEST_KEYS[i];
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (
        !desc ||
        !desc.enumerable ||
        'get' in desc ||
        'set' in desc ||
        !('value' in desc)
      ) {
        return null;
      }
      const val = desc.value;
      switch (key) {
        case 'sourceId':
          capturedSourceId = val;
          break;
        case 'principalKey':
          capturedPrincipalKey = val;
          break;
        case 'scopes':
          capturedScopes = val;
          break;
        case 'mode':
          capturedMode = val;
          break;
        case 'format':
          capturedFormat = val;
          break;
        case 'visibility':
          capturedVisibility = val;
          break;
        case 'limitsVersion':
          capturedLimitsVersion = val;
          break;
      }
    }

    // Opaque string validation: primitive non-empty string preserved verbatim without trim/caps
    if (
      typeof capturedSourceId !== 'string' ||
      capturedSourceId.length === 0 ||
      typeof capturedPrincipalKey !== 'string' ||
      capturedPrincipalKey.length === 0 ||
      typeof capturedLimitsVersion !== 'string' ||
      capturedLimitsVersion.length === 0
    ) {
      return null;
    }

    // Enum validation
    if (
      capturedMode !== 'formatted' &&
      capturedMode !== 'raw' &&
      capturedMode !== 'formula_text'
    ) {
      return null;
    }

    if (
      capturedFormat !== 'xlsx' &&
      capturedFormat !== 'csv' &&
      capturedFormat !== 'json'
    ) {
      return null;
    }

    if (
      capturedVisibility !== 'include_all' &&
      capturedVisibility !== 'api_visible'
    ) {
      return null;
    }

    // Scopes array validation
    if (!Array.isArray(capturedScopes)) {
      return null;
    }
    if (Object.getPrototypeOf(capturedScopes) !== Array.prototype) {
      return null;
    }

    const lenDesc = Object.getOwnPropertyDescriptor(capturedScopes, 'length');
    if (
      !lenDesc ||
      lenDesc.enumerable ||
      'get' in lenDesc ||
      'set' in lenDesc ||
      !('value' in lenDesc)
    ) {
      return null;
    }

    const len = lenDesc.value;
    if (
      typeof len !== 'number' ||
      !Number.isSafeInteger(len) ||
      len < 1 ||
      len > PROVISIONAL_MAX_SHEETS ||
      Object.is(len, -0)
    ) {
      return null;
    }

    // Bound array keys BEFORE allocating elements or reading descriptors
    const scopesKeys = Reflect.ownKeys(capturedScopes);
    if (scopesKeys.length !== len + 1) {
      return null;
    }

    for (let i = 0; i < scopesKeys.length; i++) {
      const k = scopesKeys[i];
      if (k === 'length') continue;
      if (typeof k !== 'string') return null;
      const idx = Number(k);
      if (
        !Number.isSafeInteger(idx) ||
        idx < 0 ||
        idx >= len ||
        String(idx) !== k ||
        Object.is(idx, -0)
      ) {
        return null;
      }
    }

    const copiedScopes: ExportScope[] = new Array(len);
    const seenSheetIds = new Set<number>();

    // Read index descriptors once in caller order
    for (let i = 0; i < len; i++) {
      const scopeDesc = Object.getOwnPropertyDescriptor(capturedScopes, String(i));
      if (
        !scopeDesc ||
        !scopeDesc.enumerable ||
        'get' in scopeDesc ||
        'set' in scopeDesc ||
        !('value' in scopeDesc)
      ) {
        return null;
      }

      const rawScope = scopeDesc.value;
      if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
        return null;
      }

      const scopeProto = Object.getPrototypeOf(rawScope);
      if (scopeProto !== Object.prototype && scopeProto !== null) {
        return null;
      }

      const rawScopeKeys = Reflect.ownKeys(rawScope);
      if (rawScopeKeys.length !== SCOPE_KEYS.length) {
        return null;
      }
      for (let k = 0; k < rawScopeKeys.length; k++) {
        const key = rawScopeKeys[k];
        if (typeof key !== 'string' || !SCOPE_KEY_SET.has(key)) {
          return null;
        }
      }

      let rawSheetId: unknown;
      let rawRect: unknown;

      for (let k = 0; k < SCOPE_KEYS.length; k++) {
        const key = SCOPE_KEYS[k];
        const desc = Object.getOwnPropertyDescriptor(rawScope, key);
        if (
          !desc ||
          !desc.enumerable ||
          'get' in desc ||
          'set' in desc ||
          !('value' in desc)
        ) {
          return null;
        }
        if (key === 'sheetId') rawSheetId = desc.value;
        else rawRect = desc.value;
      }

      if (!isNonNegativeSafeInt(rawSheetId)) {
        return null;
      }

      if (seenSheetIds.has(rawSheetId)) {
        return null;
      }
      seenSheetIds.add(rawSheetId);

      // Validate rect
      if (!rawRect || typeof rawRect !== 'object' || Array.isArray(rawRect)) {
        return null;
      }

      const rectProto = Object.getPrototypeOf(rawRect);
      if (rectProto !== Object.prototype && rectProto !== null) {
        return null;
      }

      const rawRectKeys = Reflect.ownKeys(rawRect);
      if (rawRectKeys.length !== RECT_KEYS.length) {
        return null;
      }
      for (let k = 0; k < rawRectKeys.length; k++) {
        const key = rawRectKeys[k];
        if (typeof key !== 'string' || !RECT_KEY_SET.has(key)) {
          return null;
        }
      }

      let rectSheetId: unknown;
      let r0: unknown;
      let c0: unknown;
      let r1: unknown;
      let c1: unknown;

      for (let k = 0; k < RECT_KEYS.length; k++) {
        const key = RECT_KEYS[k];
        const desc = Object.getOwnPropertyDescriptor(rawRect, key);
        if (
          !desc ||
          !desc.enumerable ||
          'get' in desc ||
          'set' in desc ||
          !('value' in desc)
        ) {
          return null;
        }
        const val = desc.value;
        switch (key) {
          case 'sheetId':
            rectSheetId = val;
            break;
          case 'r0':
            r0 = val;
            break;
          case 'c0':
            c0 = val;
            break;
          case 'r1':
            r1 = val;
            break;
          case 'c1':
            c1 = val;
            break;
        }
      }

      if (!isNonNegativeSafeInt(rectSheetId) || rectSheetId !== rawSheetId) {
        return null;
      }

      if (
        !isNonNegativeSafeInt(r0) ||
        !isNonNegativeSafeInt(c0) ||
        !isNonNegativeSafeInt(r1) ||
        !isNonNegativeSafeInt(c1)
      ) {
        return null;
      }

      if (r1 <= r0 || c1 <= c0) {
        return null;
      }

      copiedScopes[i] = {
        sheetId: rawSheetId,
        rect: {
          sheetId: rectSheetId,
          r0,
          c0,
          r1,
          c1,
        },
      };
    }

    const result: ExportRequest = {
      sourceId: capturedSourceId,
      principalKey: capturedPrincipalKey,
      scopes: copiedScopes,
      mode: capturedMode,
      format: capturedFormat,
      visibility: capturedVisibility,
      limitsVersion: capturedLimitsVersion,
    };

    return deepFreeze(result);
  } catch {
    return null;
  }
}
