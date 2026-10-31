# Test Fixtures and Oracles Catalog

This directory contains offline synthetic fixtures and oracle datasets used across unit, integration, and contract tests.

## Structure

```text
tests/fixtures/
├── authorization/
│   └── matrix.json                  # T02 offline authorization truth table matrix (24 cases)
├── exports/
│   ├── raw-multitab.json            # T09 valid multi-tab export document with extreme coordinates
│   ├── formatted-strings.json       # T09 formatted mode export document (all cells string kind)
│   ├── formula-text.json            # T09 formula_text mode export document (inert strings)
│   └── metadata-report-only.json    # T09 CSV export metadata execution report
├── grid/
│   ├── multisheet-fidelity.json     # T03 unvalidated transport data (3 tabs: SparseTab, ValuesAndVisibility, SummaryChart)
│   ├── multisheet-fidelity.oracle.json # T03 coordinate and type oracle for fidelity validation
│   ├── unavailable-visibility.json  # T03 missing dimension metadata transport fixture
│   └── unavailable-visibility.oracle.json # T03 visibility failure expectation oracle
└── README.md                        # This catalog documentation
```

## Shared Fixture Helpers (`tests/helpers/fixtures.ts`)

For unit and integration tests, use the typed factories and catalog helpers exported from `tests/helpers/fixtures.ts`:

- **Canonical 3-Tab Workbook**:
  - `createCanonicalWorkbookMeta()`: 3 sheets with stable NON-consecutive IDs (101, 205, 309) in source order (index 0, 1, 2).
  - Tab 0 (`id: 101`, `SparseTab`): visible populated sparse tab containing Z90000 (`[0, 90000) x [0, 26)`).
  - Tab 1 (`id: 205`, `EmptyTab`): visible empty tab (`[0, 1000) x [0, 26)`).
  - Tab 2 (`id: 309`, `HiddenTab`): hidden tab (`[0, 100) x [0, 10)`).
- **Matching Contexts and Requests**:
  - `createCanonicalSourceRef()`
  - `createSyntheticAccountContext()` (fake principal/email only)
  - `createSyntheticPermittedEligibility()` (local synthetic evidence revision only)
  - `createCanonicalExportRequest()` (default `include_all` for visible tabs in source order)
  - `createCanonicalWriterContext()` (sanitized context, strictly free of auth fields)
  - `createCanonicalExportReport()` (metadata-only execution report matching canonical export)
  - `createCanonicalJsonExportDocument()` (fully typed JSON document with canonical sparse cells)
- **Manual Sparse Oracle Cells**:
  - `CANONICAL_SPARSE_RAW_ORACLE_CELLS` / `createCanonicalSparseRawOracleCells()`:
    - `A1` (row 0, col 0): string `'00123'` (preserves leading zeroes without numeric coercion)
    - `D50` (row 49, col 3): string `'middle'`
    - `Z90000` (row 89999, col 25): number `42`
    - Stored as a compact list of 3 items; never dense 90,000-row arrays.
- **T03 Transport Payloads**:
  - `createMultisheetGridTransportPayload()`
  - `createUnavailableVisibilityGridTransportPayload()`
  - Kept typed as `unknown` inside `GridTransportPayload`; never cast to domain models without validation.
- **Reviewed Catalog**:
  - `REVIEWED_FIXTURE_CATALOG`: frozen catalog whose accessors return independent deep copies of T03 grid transport/oracles and T09 JSON exports. Transport byte counts measure the UTF-8 minified synthetic JSON body.

All factories return fresh nested deep copies (via `structuredClone`) to prevent cross-test state contamination.
