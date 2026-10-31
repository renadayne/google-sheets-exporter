import { validateReport, validateExport } from './generated/validators.js';
import type { ExportReport, JsonExportDocument } from './domain.ts';

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
