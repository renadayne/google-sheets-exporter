# T04 — Browser writer spike: reviewed local results

Date: 2026-10-31 (Asia/Saigon). Status: **PARTIAL — local harness accepted; full T04 acceptance pending desktop reader checks and remaining edge coverage.**

## Execution and ownership

Antigravity created the isolated harness in `spikes/browser-writers`. Its job `6bdf17d2-4de7-46c6-b92c-0ae8ae6fa64e` ended with `RESOURCE_EXHAUSTED` / individual subscription quota reached before producing a handoff. Bridge completion was not treated as acceptance. Codex reviewed actual files and independently ran the checks below, fixed a hard-coded Blob revocation success flag, added a page-CDP response timeout, and reran the Chrome check.

No production extension, Google acquisition adapter or OAuth client was implemented. The harness operates exclusively on synthetic fixtures.

## Reproduction

```powershell
npm ci --prefix spikes/browser-writers
npm --prefix spikes/browser-writers run build
npm --prefix spikes/browser-writers run spike:node
npm --prefix spikes/browser-writers run spike:chrome
```

The review reused Antigravity's installed dependencies and exact lockfile; clean `npm ci` has **not** been independently rerun. Node 24.14.0, npm 11.9.0, Vite 6.2.6. ExcelJS 4.4.0, fflate 0.8.2. Test-only readers/tools: csv-parse 5.6.0, fast-xml-parser 5.2.5, SheetJS/xlsx 0.18.5, playwright-core 1.52.0. These are tested spike candidates, not a production dependency/security approval.

Chrome review used installed Chrome 156 in headless mode, a fresh temporary profile, a real `chrome-extension://` page and a bundled dedicated Web Worker. The restricted sandbox could not see the Chrome executable; the same synthetic test passed when granted execution access to the installed browser. `CHROME_PATH` supports another installation. No personal browser profile was opened.

## Reviewed checks

| Check | Result | Evidence / boundary |
|---|---|---|
| Local MV3 build | PASS | Vite bundle: worker 1,480.88 kB, extension page/background built without errors |
| Node writer and independent parsers | PASS | `spike:node` exited 0; XLSX XML + SheetJS; CSV ZIP + csv-parse |
| Genuine MV3 page/worker execution | PASS | `spike:chrome` exited 0 after review fixes; zero captured page, console and CSP errors |
| Three XLSX worksheets and source order | PASS | Main fixture names/order asserted in workbook XML and independent reader |
| Distant and offset positions | PASS | A1, D50, Z90000 retained; nonzero-origin third sheet begins at C5 |
| Sparse row nodes / empty worksheet | PASS | First sheet XML rows exactly 1,2,50,90000; second sheet has zero cell rows |
| Types, Unicode and embedded text | PASS | Numeric/boolean/string/empty-string fixture assertions; 00123 preserved as string; CR/LF, quotes and emoji round-trip |
| Formula text inert in XLSX | PASS for fixture | No `<f>`, hyperlink or external-link nodes in worksheets; reader reports string cells, no formulas |
| Multi-tab CSV package | PASS | Exactly 3 CSVs plus manifest; first CSV 90,000 x 26; third has origin C5 and 4 x 4 data |
| CSV safety transformation | PASS for parser assertions | Five dangerous text values prefixed; numeric -42.5 unchanged; execution behavior in desktop readers still pending |
| Representability guards | PASS for five cases | 32,768-char string, NUL, over-limit row, over-limit column, NaN rejected |
| Worker cancellation | PASS for harness | Heavy worker terminated; zero late messages observed over 150ms; does not prove all production cancellation races |
| Blob lifecycle | PASS after review fix | Read succeeds before revoke; subsequent read rejects; result asserted by runner |
| Deterministic edge-name collisions | PARTIAL | Main names asserted; additional collision/reserved-name cases printed but not all independently asserted |
| Excel/LibreOffice open without repair | NOT RUN | Independent parser does not establish absence of a desktop repair prompt |
| CSV formula execution in supported readers | NOT RUN | Requires controlled desktop reader validation; no universal safety claim |
| Large-workbook memory envelope | NOT RUN | Page heap is not worker peak memory; full calibration belongs to T06/T41 |
| Google API / authorization | NOT RUN | No OAuth setup; this harness contains no acquisition/policy evidence |

## Measurements from reviewer rerun

- Node: XLSX 8,148 bytes, approximately 25.19 ms; CSV ZIP 25,890 bytes, approximately 86.99 ms.
- Chrome worker: XLSX 8,148 bytes, approximately 20.90 ms; CSV ZIP 25,890 bytes, approximately 88.50 ms.
- Uncompressed CSV package: 7,145,790 bytes. Worker memory snapshots unavailable (`null`). Page CDP heap approximately 1.30 MB; **not** an end-to-end peak memory measurement.
- These are one-run synthetic observations, not benchmark targets or Google network timings. Generated summaries/artifacts are ignored and can be reproduced locally.

## Review findings and next work

Fixed: Blob revocation was originally reported with a constant `true`; now actual before/after reads are checked. Page CDP commands now time out after 10 seconds instead of waiting indefinitely.

Do not promote `writer-core.js` into production: no authorization/coverage/resource gates, no complete scalar/schema validation, no precision policy, no full Unicode/XML representability coverage, and the fixture always assumes complete input. Remaining production concerns belong to the corresponding bounded tasks. The spike manifest is a test manifest, not the final permission/CSP selection.

Next: resume T04's desktop-reader/edge coverage when delegation is available, or explicitly keep those checks pending while local foundation proceeds. T03 offline fixtures and T05 setup templates remain runnable without Google credentials. Antigravity delegation is currently blocked by subscription quota; do not repeatedly retry the same exhausted quota.
