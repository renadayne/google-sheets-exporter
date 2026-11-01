import { validateReport, validateExport, validateCell } from './generated/validators.js';
import type { ExportReport, JsonExportDocument, Cell } from './domain.ts';

/**
 * Validates that an unknown value structurally satisfies the ExportReport schema.
 *
 * Safe wrapper around precompiled static validator:
 * - Catches hostile getter throws and returns false.
 * - Resets generated validator `.errors` to null to avoid leaking schema error structures.
 * - Performs no object mutation or type coercion.
 *
 * Note: Cross-field relational consistency (such as coordinate bounds, rectangle coverage,
 * and interval ordering) remains a separate T24b domain obligation.
 */
export function isExportReport(input: unknown): input is ExportReport {
  try {
    const valid = validateReport(input);
    return Boolean(valid);
  } catch {
    return false;
  } finally {
    try {
      validateReport.errors = null;
    } catch {
      // In case property assignment fails
    }
  }
}

/**
 * Validates that an unknown value structurally satisfies the JsonExportDocument schema.
 *
 * Safe wrapper around precompiled static validator:
 * - Catches hostile getter throws and returns false.
 * - Resets generated validator `.errors` to null to avoid leaking schema error structures.
 * - Performs no object mutation or type coercion.
 *
 * Note: Cross-field relational consistency (such as coordinate bounds, rectangle coverage,
 * and interval ordering) remains a separate T24b domain obligation.
 */
export function isJsonExportDocument(input: unknown): input is JsonExportDocument {
  try {
    const valid = validateExport(input);
    return Boolean(valid);
  } catch {
    return false;
  } finally {
    try {
      validateExport.errors = null;
    } catch {
      // In case property assignment fails
    }
  }
}

/**
 * Validates that an unknown value structurally satisfies the Cell schema.
 *
 * Safe wrapper around precompiled static validator:
 * - Catches hostile getter throws and returns false.
 * - Resets generated validator `.errors` to null to avoid leaking schema error structures.
 * - Performs no object mutation or type coercion.
 *
 * Note: This certifies schema structure only; selected-scope bounds, safe coordinates,
 * and formula/mode agreement remain consumer obligations.
 */
export function isCell(input: unknown): input is Cell {
  try {
    const valid = validateCell(input);
    return Boolean(valid);
  } catch {
    return false;
  } finally {
    try {
      validateCell.errors = null;
    } catch {
      // In case property assignment fails
    }
  }
}
