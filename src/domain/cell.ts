/**
 * T15a Pure Single-Cell Value Projection and Validation.
 * Projects a single Google Sheets CellData representation into a domain Cell.
 *
 * Rules:
 * - Validates absolute coordinates (safe nonnegative integers).
 * - Plain explicit objects; never spreads raw API source properties.
 * - Raw blanks vs never-set cannot be distinguished; formatting-only or empty returns null.
 * - Mode 'raw': uses effectiveValue union (number, string, boolean, error).
 * - Mode 'formatted': outputs supplied formattedValue string only.
 * - Mode 'formula_text': ONLY explicit userEnteredValue.formulaValue yields formulaText;
 *   nonformula cells use raw effective typed value.
 */

import type { Cell, ExportMode, StringCell, NumberCell, BooleanCell, ErrorCell } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface RawExtendedValue {
  readonly numberValue?: unknown;
  readonly stringValue?: unknown;
  readonly boolValue?: unknown;
  readonly formulaValue?: unknown;
  readonly errorValue?: unknown;
}

interface RawErrorValue {
  readonly type?: unknown;
  readonly message?: unknown;
}

type ExtractedValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly value: { readonly code: string; readonly message: string } };

function extractNumberFormatType(cellObj: Record<string, unknown>): string | undefined {
  const formats = [cellObj.effectiveFormat];
  for (const fmt of formats) {
    if (fmt === undefined) continue;
    if (!isRecord(fmt)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    const fmtObj = fmt as Record<string, unknown>;
    if (!('numberFormat' in fmtObj) || fmtObj.numberFormat === undefined) continue;
    const nf = fmtObj.numberFormat;
    if (!isRecord(nf)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    const nfObj = nf as Record<string, unknown>;
    if (!('type' in nfObj) || nfObj.type === undefined) continue;
    if (typeof nfObj.type !== 'string') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return nfObj.type;
  }
  return undefined;
}

function parseExtendedValue(val: unknown, allowFormula: boolean): ExtractedValue | null {
  if (val === undefined) return null;
  if (!isRecord(val)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const obj = val as RawExtendedValue;
  const allowed = ['numberValue', 'stringValue', 'boolValue', 'formulaValue', 'errorValue'];
  if (Object.keys(val).some(key => !allowed.includes(key))) throw new DomainError('SOURCE_UNSUPPORTED');
  const presentKeys: string[] = [];
  if ('numberValue' in obj && obj.numberValue !== undefined) presentKeys.push('numberValue');
  if ('stringValue' in obj && obj.stringValue !== undefined) presentKeys.push('stringValue');
  if ('boolValue' in obj && obj.boolValue !== undefined) presentKeys.push('boolValue');
  if ('formulaValue' in obj && obj.formulaValue !== undefined) presentKeys.push('formulaValue');
  if ('errorValue' in obj && obj.errorValue !== undefined) presentKeys.push('errorValue');

  if (presentKeys.length === 0) {
    return null;
  }
  if (presentKeys.length > 1) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const key = presentKeys[0];
  if (key === 'numberValue') {
    const n = obj.numberValue;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return { kind: 'number', value: n };
  }
  if (key === 'stringValue') {
    const s = obj.stringValue;
    if (typeof s !== 'string') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return { kind: 'string', value: s };
  }
  if (key === 'boolValue') {
    const b = obj.boolValue;
    if (typeof b !== 'boolean') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return { kind: 'boolean', value: b };
  }
  if (key === 'formulaValue') {
    if (!allowFormula) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    const f = obj.formulaValue;
    if (typeof f !== 'string') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return { kind: 'string', value: f };
  }
  if (key === 'errorValue') {
    const err = obj.errorValue;
    if (!isRecord(err)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    const errObj = err as RawErrorValue;
    if (typeof errObj.type !== 'string' || typeof errObj.message !== 'string') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return {
      kind: 'error',
      value: { code: errObj.type, message: errObj.message }
    };
  }

  return null;
}

function assembleCell(
  r: number,
  c: number,
  val: ExtractedValue,
  formulaText: string | undefined,
  numberFormatType: string | undefined
): Cell {
  if (val.kind === 'string') {
    const cell: StringCell = {
      r,
      c,
      kind: 'string',
      value: val.value,
      ...(formulaText !== undefined ? { formulaText } : {}),
      ...(numberFormatType !== undefined ? { numberFormatType } : {})
    };
    return cell;
  }
  if (val.kind === 'number') {
    const cell: NumberCell = {
      r,
      c,
      kind: 'number',
      value: val.value,
      ...(numberFormatType !== undefined ? { numberFormatType } : {})
    };
    return cell;
  }
  if (val.kind === 'boolean') {
    const cell: BooleanCell = {
      r,
      c,
      kind: 'boolean',
      value: val.value,
      ...(numberFormatType !== undefined ? { numberFormatType } : {})
    };
    return cell;
  }
  const cell: ErrorCell = {
    r,
    c,
    kind: 'error',
    value: { code: val.value.code, message: val.value.message },
    ...(numberFormatType !== undefined ? { numberFormatType } : {})
  };
  return cell;
}

export function projectCell(input: unknown, r: number, c: number, mode: ExportMode): Cell | null {
  if (
    typeof r !== 'number' ||
    !Number.isSafeInteger(r) ||
    r < 0 ||
    Object.is(r, -0) ||
    typeof c !== 'number' ||
    !Number.isSafeInteger(c) ||
    c < 0 ||
    Object.is(c, -0)
  ) {
    throw new DomainError('RANGE_INVALID');
  }

  if (mode !== 'raw' && mode !== 'formatted' && mode !== 'formula_text') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  if (!isRecord(input)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const cellObj = input as Record<string, unknown>;

  if ('formattedValue' in cellObj && cellObj.formattedValue !== undefined && typeof cellObj.formattedValue !== 'string') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const userVal = 'userEnteredValue' in cellObj ? cellObj.userEnteredValue : undefined;
  const effVal = 'effectiveValue' in cellObj ? cellObj.effectiveValue : undefined;

  const parsedUser = parseExtendedValue(userVal, true);
  const parsedEff = parseExtendedValue(effVal, false);

  const isUserFormula =
    userVal !== undefined &&
    typeof userVal === 'object' &&
    userVal !== null &&
    !Array.isArray(userVal) &&
    'formulaValue' in userVal &&
    (userVal as RawExtendedValue).formulaValue !== undefined;

  const numberFormatType = extractNumberFormatType(cellObj);

  if (mode === 'raw') {
    if (parsedEff === null) {
      if (parsedUser !== null || cellObj.formattedValue !== undefined) {
        throw new DomainError('SOURCE_UNSUPPORTED');
      }
      return null;
    }
    return assembleCell(r, c, parsedEff, undefined, numberFormatType);
  }

  if (mode === 'formatted') {
    if (cellObj.formattedValue === undefined && parsedEff === null && parsedUser === null) {
      return null;
    }
    if (typeof cellObj.formattedValue !== 'string') {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return assembleCell(
      r,
      c,
      { kind: 'string', value: cellObj.formattedValue },
      undefined,
      numberFormatType
    );
  }

  // mode === 'formula_text'
  if (isUserFormula) {
    const formula = (userVal as RawExtendedValue).formulaValue as string;
    return assembleCell(
      r,
      c,
      { kind: 'string', value: formula },
      formula,
      numberFormatType
    );
  }

  if (parsedEff === null) {
    if (parsedUser !== null || cellObj.formattedValue !== undefined) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return null;
  }

  return assembleCell(r, c, parsedEff, undefined, numberFormatType);
}
