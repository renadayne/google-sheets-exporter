# JSON Schema Specification & Consumer Guide

Normative schemas for export documents and metadata reports conforming to Architecture §G and `src/contracts/domain.ts`.

## 1. Schemas and Composition

- `src/contracts/report.schema.json` (`urn:google-sheets-exporter:report.schema.json`):
  Metadata-only `ExportReport` schema. Covers source, execution timing, scope selections, sheet order, name mappings, interval exclusions, source observations, and CSV transform counts.
- `src/contracts/export.schema.json` (`urn:google-sheets-exporter:export.schema.json`):
  Successful `JsonExportDocument` schema. Extends the extensible `baseReport` definition from `report.schema.json`, requires `sheets` array, enforces `export.complete: true`, `export.format: "json"`, and restricts consistency to exclude detected changes.
- **Draft 2020-12 unevaluatedProperties**: Both schemas close their final composed root with `unevaluatedProperties: false` and nested objects with `additionalProperties: false`. This avoids the draft-7 `allOf`/`additionalProperties: false` extension trap while preventing secret/auth leaks at boundaries.

## 2. Dev-Only Tooling & MV3 CSP Constraint

- `ajv` (v8) and `ajv-formats` (v3) are development-only dependencies for Node tests and CI verification.
- **MV3 CSP Caveat**: Ajv compiles schemas at runtime using `Function()`, which is prohibited under Chrome Extension Manifest V3 CSP (`script-src 'self'`). Never import Ajv into runtime code (`src/runtime/`, `src/source/`, `src/jobs/`, `src/export/`).
- Runtime boundaries must use reviewed static type guards, precompiled standalone validators, or explicit structural checks.

## 3. Cell Representation and Mode Projections

- **Scalar Fidelity**: Strict kinds (`string`, `number`, `boolean`, `error`). No coercion between numeric strings and numbers.
- **Date Serials**: Dates remain numeric serial numbers with optional `numberFormatType` (e.g. `DATE_TIME`). No JavaScript `Date` objects.
- **Tagged Errors**: Error cells require structured `{ code, message }` values, not raw strings.
- **Formula Projections**:
  - `raw`: Formula text is omitted; cell values are evaluated scalars. `formulaText` is forbidden.
  - `formatted`: All cells are string representations (`kind: "string"`). `formulaText` is forbidden.
  - `formula_text`: Formula cells carry inert formula expressions in `formulaText` and `value`. Nonformula cells retain typed values without `formulaText`. Ordinary strings looking like formulas (e.g. `"=SUM..."`) are never rejected.
- A `formulaText` property is valid only on a string cell; a computed numeric/boolean/error result cannot stand in for the requested expression. A successful JSON document has at least one selected sheet, while an empty worksheet still uses `cells: []`.
- **Timestamps**: Client-produced timestamps (`startedAt`, `producedAt`, `observedAt`) require UTC format with `Z` suffix.

## 4. Constraints JSON Schema Cannot Enforce

Standard JSON Schema validates isolated document structures. The following cross-field relational constraints remain explicit runtime/test obligations:

1. **Scope/ID/Order Agreement**: Mutual consistency between `sheetOrder`, `sheets[].id`, `selectedScopes[].sheetId`, and `nameMappings[].sheetId`.
2. **Unique Coordinates**: Guaranteeing each `(r, c)` cell coordinate is unique within its sheet.
3. **In-Scope Coordinate Bounds**: Ensuring every cell satisfies `r0 <= r < r1` and `c0 <= c < c1` of the sheet scope.
4. **Interval Ordering**: Verifying `start < end` in exclusion intervals and `r0 < r1`, `c0 < c1` in rectangles.
5. **Coverage Ledger Completeness**: Proving the fetched chunk partition exactly covers the selected grid rectangles without omission or unverified gaps.
6. **Projection Agreement**: When `formulaText` is present, its expression must match the inert string value. CSV transformation totals must equal their per-sheet sum. These require explicit runtime checks, not nonstandard schema keywords.
