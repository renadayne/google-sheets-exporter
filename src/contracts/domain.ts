/**
 * T08a Domain Contract Types
 * Pure TypeScript definitions for core domain entities and metadata.
 * Declared contracts: readonly, typed values and zero-based coordinates.
 * Runtime validation is still required at untrusted boundaries.
 */

// --- Source and Principal Identification ---

/** Validated reference to a Google Sheets source document. highlightedSheetId is UI hint only. */
export interface SourceRef {
  readonly spreadsheetId: string;
  readonly highlightedSheetId?: number;
}

/** Memory-only principal. Never persisted, logged, or serialized into reports. */
export interface AccountContext {
  readonly principalKey: string;
  readonly displayEmail: string;
}

// --- Eligibility Status (6 Discriminators) ---

export type EligibilityStatus =
  | 'permitted'
  | 'restricted'
  | 'login_required'
  | 'admin_approval_required'
  | 'missing_or_inaccessible'
  | 'uncertain';

export type NegativeEligibilityStatus = Exclude<EligibilityStatus, 'permitted'>;

/** Permitted status: binds sourceId, principalKey, timestamp, and evidenceRevision. */
export interface PermittedEligibility {
  readonly status: 'permitted';
  readonly sourceId: string;
  readonly principalKey: string;
  readonly checkedAt: string;
  /** Local evidence/rule-format identifier, not an immutable Google permission revision. */
  readonly evidenceRevision: string;
  readonly reasonCode: string;
}

export interface NegativeEligibility<T extends NegativeEligibilityStatus = NegativeEligibilityStatus> {
  readonly status: T;
  readonly sourceId?: string;
  readonly principalKey?: string;
  readonly checkedAt: string;
  readonly evidenceRevision?: string;
  readonly reasonCode: string;
}

export type RestrictedEligibility = NegativeEligibility<'restricted'>;
export type LoginRequiredEligibility = NegativeEligibility<'login_required'>;
export type AdminApprovalRequiredEligibility = NegativeEligibility<'admin_approval_required'>;
export type MissingOrInaccessibleEligibility = NegativeEligibility<'missing_or_inaccessible'>;
export type UncertainEligibility = NegativeEligibility<'uncertain'>;

/** Public authorization decision union. Transport retries belong to adapters. */
export type Eligibility = PermittedEligibility | NegativeEligibility;

// --- Workbook and Sheet Metadata ---

export type SheetType = 'GRID' | 'OBJECT' | 'DATA_SOURCE';

export interface SheetMeta {
  readonly id: number;
  readonly title: string;
  readonly index: number;
  readonly type: SheetType | string;
  readonly hidden: boolean;
  /** Missing for non-grid/unsupported sources; never fabricate bounds as zero. */
  readonly rows?: number;
  readonly columns?: number;
}

export interface WorkbookMeta {
  readonly id: string;
  readonly title: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly sheets: readonly SheetMeta[];
  readonly sourceVersionObservation?: string;
}

// --- Coordinates, Scope, and Request ---

/**
 * 2D sheet bounding rectangle: zero-based, half-open intervals [r0, r1) x [c0, c1).
 * Coordinates are numbers; area/bounds validation is runtime logic.
 */
export interface Rect {
  readonly sheetId: number;
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
}

export type ExportMode = 'formatted' | 'raw' | 'formula_text';
export type ExportFormat = 'xlsx' | 'csv' | 'json';
/** Visibility: include_all includes hidden cells; api_visible excludes hidden without compaction. */
export type VisibilityMode = 'include_all' | 'api_visible';

export interface ExportScope {
  readonly sheetId: number;
  readonly rect: Rect;
}

/** Immutable export request binding principal and source to selected scopes. */
export interface ExportRequest {
  readonly sourceId: string;
  readonly principalKey: string;
  /** One scope per selected sheet, ordered by source sheet index. */
  readonly scopes: readonly ExportScope[];
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly visibility: VisibilityMode;
  readonly limitsVersion: string;
}

// --- Normalized Cells ---

export interface CellErrorValue {
  readonly code: string;
  readonly message: string;
}

export interface StringCell {
  readonly r: number;
  readonly c: number;
  readonly kind: 'string';
  readonly value: string;
  readonly formulaText?: string;
  readonly numberFormatType?: string;
}

export interface NumberCell {
  readonly r: number;
  readonly c: number;
  readonly kind: 'number';
  readonly value: number;
  readonly formulaText?: string;
  readonly numberFormatType?: string;
}

export interface BooleanCell {
  readonly r: number;
  readonly c: number;
  readonly kind: 'boolean';
  readonly value: boolean;
  readonly formulaText?: string;
  readonly numberFormatType?: string;
}

export interface ErrorCell {
  readonly r: number;
  readonly c: number;
  readonly kind: 'error';
  readonly value: CellErrorValue;
  readonly formulaText?: string;
  readonly numberFormatType?: string;
}

/**
 * Normalized sparse cell with absolute coordinates.
 * Dates remain numeric serial numbers (never Date). Formulas remain inert strings.
 */
export type Cell = StringCell | NumberCell | BooleanCell | ErrorCell;

// --- Chunks and Coverage ---

export interface DimensionInterval {
  readonly start: number;
  readonly end: number;
}

export interface ExcludedIntervals {
  readonly rows: readonly DimensionInterval[];
  readonly columns: readonly DimensionInterval[];
}

export interface NormalizedChunk {
  readonly jobId: string;
  readonly chunkId: string;
  readonly rect: Rect;
  readonly cells: readonly Cell[];
  readonly excludedIntervals: ExcludedIntervals;
  readonly byteCount: number;
}

/**
 * Snapshot of 2D partition coverage ledger.
 * Note: isScopeComplete indicates selected-scope completeness, NOT atomic consistency.
 */
export interface CoverageSnapshot {
  readonly plannedLeafCount: number;
  readonly completedChunkIds: readonly string[];
  readonly failedChunkIds: readonly string[];
  readonly splitChunkIds: readonly string[];
  readonly isScopeComplete: boolean;
}

// --- Artifact and Report ---

/** Private staged artifact; no declared auth fields. Controller alone may authorize publication. */
export interface Artifact {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: Uint8Array | Blob;
  readonly byteLength: number;
  readonly safeSummary: string;
}

/** Consistency observed across chunk reads; Sheets API does not provide atomic snapshots. */
export type ConsistencyStatus =
  | 'not_atomic_no_change_detected'
  | 'not_atomic_changes_detected'
  | 'not_atomic_unverified';

export interface ReportSourceMeta {
  readonly id: string;
  readonly title: string;
  readonly locale: string;
  readonly timeZone: string;
}

export interface ReportWarning {
  readonly code: string;
  readonly message: string;
  readonly sheetId?: number;
}

export interface ReportExportMeta {
  readonly startedAt: string;
  readonly producedAt: string;
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly visibility: VisibilityMode;
  /** Selected-scope completeness: true when all selected scopes were fetched without omission. */
  readonly complete: boolean;
  readonly consistency: ConsistencyStatus;
  readonly warnings: readonly ReportWarning[];
}

export interface SheetNameMapping {
  readonly sheetId: number;
  readonly originalTitle: string;
  readonly exportedName: string;
}

export interface SheetExclusions {
  readonly sheetId: number;
  readonly excludedRows: readonly DimensionInterval[];
  readonly excludedColumns: readonly DimensionInterval[];
}

export interface SourceObservation {
  readonly observedAt: string;
  /** Drive file version observation; does not pin an atomic Sheets snapshot. */
  readonly version?: string;
  readonly modifiedTime?: string;
}

export interface ReportSourceObservations {
  readonly before?: SourceObservation;
  readonly after?: SourceObservation;
}

export interface ReportCsvTransforms {
  readonly policy: 'apostrophe_prefix_v1';
  readonly totalTransformedCells: number;
  readonly bySheet: readonly { readonly sheetId: number; readonly transformedCells: number }[];
}

export interface JsonExportSheet {
  readonly id: number;
  readonly title: string;
  readonly index: number;
  readonly scope: Rect;
  readonly visibility: {
    readonly mode: VisibilityMode;
    readonly excludedRows: readonly DimensionInterval[];
    readonly excludedColumns: readonly DimensionInterval[];
  };
  readonly cells: readonly Cell[];
}

/** Export execution report conforming to Architecture G. */
export interface ExportReport {
  readonly schemaVersion: '1.0';
  readonly source: ReportSourceMeta;
  readonly export: ReportExportMeta;
  readonly selectedScopes: readonly ExportScope[];
  readonly sheetOrder: readonly number[];
  readonly limitsVersion: string;
  readonly nameMappings: readonly SheetNameMapping[];
  readonly exclusions: readonly SheetExclusions[];
  readonly sourceObservations?: ReportSourceObservations;
  readonly csvTransformCounts?: ReportCsvTransforms;
}

/** Successful JSON file envelope, distinct from a metadata-only report. */
export interface JsonExportDocument extends ExportReport {
  readonly export: ReportExportMeta & {
    readonly complete: true;
    readonly format: 'json';
    readonly consistency: Exclude<ConsistencyStatus, 'not_atomic_changes_detected'>;
  };
  readonly sheets: readonly JsonExportSheet[];
}
