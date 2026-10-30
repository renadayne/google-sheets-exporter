# T03 — GridData fidelity and visibility spike: offline evidence

Date: 2026-10-31. Status: **PARTIAL — offline PASS; live verification pending Google credentials.**

## Execution and scope

This spike implements the offline foundation of T03:
- Synthetic fixtures under `tests/fixtures/grid/` shaped after Google Sheets API v4 schemas ([Spreadsheet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets), [GridData](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets#GridData), [CellData](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells#CellData)).
- Independent handwritten oracle expectations in `multisheet-fidelity.oracle.json` and `unavailable-visibility.oracle.json`.
- Dependency-free fixture checker in `spikes/grid-fidelity/check-fixtures.mjs` verifying coordinates, types, merges, visibility, and mutation rejection.

Google Cloud/OAuth is not configured. Live API calls were **NOT RUN**. Synthetic fixtures verify structural invariants and parser assumptions; they do not prove undocumented live Google Sheets behavior or runtime quota.

## Reproduction

```powershell
node spikes/grid-fidelity/check-fixtures.mjs
```

Runs on Node v24 with zero external dependencies. Exits 0 with 20/20 checks passing.

## Reviewed checks

| Invariant / Feature | Result | Documented schema fact vs Synthetic assumption vs Live verification |
|---|---|---|
| Sheet ordering | PASS | Schema fact: `SheetProperties.index` designates sheet position ([SheetProperties](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/sheets#SheetProperties)). Synthetic check: sorted by `properties.index`. API array order is not assumed stable without explicit sorting. |
| Sparse chunk offsets | PASS | Schema fact: `GridData.startRow`/`startColumn` default to 0 when omitted ([GridData](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets#GridData)). Synthetic check: A1, D50, Z90000 chunked without allocating intermediate arrays. |
| Nonzero chunk origin | PASS | Schema fact: bounded range queries return `startRow`/`startColumn` offsets. Synthetic check: C5 origin [4,2] verified. |
| Value types | PASS | Schema fact: `effectiveValue` holds string/number/bool/error ([ExtendedValue](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/cells#ExtendedValue)). Synthetic check: types matched to oracle. |
| Date serial preservation | PASS | Schema fact: date/time values are numeric serials with `numberFormat.type: "DATE"`. Synthetic check: raw 45200 preserved without JS Date conversion. |
| Formula text & results | PASS | Schema fact: `userEnteredValue.formulaValue` preserves formula string; `effectiveValue` contains computed result. Synthetic check: `=SUM(10, 20)` -> 30 verified. |
| Formula empty string | PASS | Synthetic assumption: formulas evaluating to empty string produce `stringValue: ""`. Schema defines `stringValue` field, but live empty-string formula payload remains pending live verification. |
| Blank omission vs empty | PASS | Synthetic assumption: cleared/blank cells omit `values[c]` or emit empty `{}`. Field schema allows omission; live distinction between cleared vs never-set cells is unverified. |
| Error representation | PASS | Schema fact: `errorValue` contains `type` and `message` ([ErrorValue](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/cells#ErrorValue)). Synthetic check: `DIVIDE_BY_ZERO` verified. |
| Merge range anchor | PASS | Synthetic assumption: Sheets API populates anchor cell and leaves non-anchors empty. Synthetic check: C5:D5 anchor C5 has value; all non-anchors validated empty. |
| Populated merge mutation | PASS | Synthetic check: temporary mutation populating merged non-anchor D5 is rejected by validator and cleanly restored in `finally`. |
| Row/col visibility flags | PASS | Schema fact: `DimensionProperties` expose `hiddenByUser` and `hiddenByFilter` ([DimensionProperties](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/sheets#DimensionProperties)). Synthetic check: verified by offset. |
| Unavailable visibility | PASS | Design boundary: the fixture provides no dimension metadata or evidence that its omission means visible, so the checker expects uncertainty. Saved filter definitions alone do not establish the active browser-session view. Exact live behavior remains pending. |
| Non-GRID sheet type | PASS | Schema fact: `sheetType: "OBJECT"` sheets lack grid coordinates/data. Synthetic check: detected pre-job; requires user warning without silent skip. |
| Live API round-trip | NOT RUN | Requires Google Cloud project, OAuth credentials, and live workbook. |

## Invariant definitions and findings

1. **Coordinate resolution and sparse chunking**:
   - Chunks map to absolute coordinates via `absRow = (startRow || 0) + relRow`.
   - Distant cells (A1, D50, Z90000) are handled as separate sparse chunks without 90k array allocations.
2. **Value normalization integrity**:
   - Dates remain numeric serial numbers (`45200`) alongside format metadata, preventing browser timezone corruption.
   - Text, empty strings (`""`), formulas, and error values are preserved in their respective schema fields.
3. **Merge policy**:
   - Range C5:D5 merges C5 (anchor) and D5 (non-anchor). Validator iterates all declared non-anchor positions to ensure no values exist, preventing fill-down fabrication. A temporary mutation check confirmed populated non-anchors fail validation.
4. **Visibility and filter boundaries**:
   - `DimensionProperties` provide `hiddenByUser` and `hiddenByFilter`.
   - Do not infer the active browser-session filter from saved `filterViews`. Their exact interaction with returned metadata has not been verified live. In this fixture, dimension metadata and visibility provenance are missing; the conservative expected action is to disable `api-visible`. Mere filter-view presence does not disable it when sufficient metadata is available.
5. **Sheet ordering and non-GRID sheets**:
   - Workbook sheet order is established via explicit `properties.index`.
   - Non-GRID sheets (`OBJECT`) are detected and flagged for pre-job warning.

## Pending live work

- Authenticate with live Google Cloud credentials and query a live test sheet with A1/D50/Z90000.
- Verify live API payload shape for empty-string formulas, cleared cells, and saved filter views.
