# Root writer browser evidence

Date: 2026-11-02 (Asia/Saigon). Status: **PASS for this synthetic MV3 writer harness**. This does not complete production T36 or release gates.

## Reproduction

Use installed Node24.14.0 and the root lockfile:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node tests/e2e/writer-browser-smoke.mjs
```

`CHROME_PATH` can select the Chrome executable. An inaccessible executable exits2 with `BROWSER_EXECUTION_PENDING`; that is not a pass. `--build-only` verifies packaging without a browser and cannot establish runtime success.

Antigravity implemented the harness with explicit Gemini Flash. Initial output required review corrections; correction job `11c5a68e-a4cd-4976-8bfb-fe35eb2abe69` ended with backend DNS failure after writing files. Codex reviewed actual changes, corrected remaining profile/oracle/cleanup issues, and independently ran both isolated and integrated main versions successfully using already granted Node execution.

## Observed environment and outputs

Chrome **156.0.8078.74**, Node **24.14.0**, Vite **8.3.5**. Runtime pins: ExcelJS4.4.0 and fflate0.8.3. Independent readers: SheetJS0.20.3, fast-xml-parser5.11.2, csv-parse5.6.0 and a bounded ZIP32 reader using Node zlib/CRC.

The genuine bundled module Worker was approximately 1,123.79kB. In the recorded main run, output sizes were JSON1996B, CSV ZIP1180B, XLSX7802B and companion862B. These are one small fixture's outputs, not calibrated limits or a performance benchmark.

| Check | Observed result |
|---|---|
| Real MV3 page + dedicated ES module Worker | PASS; writer modules execute under script-src/object-src/worker-src self, without unsafe-eval |
| Full JSON document | PASS; schema plus independent exact source/export/scopes/order/mapping/visibility and every typed Cell |
| CSV ZIP | PASS; exact ordered 3 CSVs + manifest, native inflate/CRC/local-CD checks and independent full row matrices |
| Actual CSV safety counts | PASS; 2 transformed strings, source-order counts 1/0/1, controlled warning and exact apostrophe prefixes |
| XLSX + companion | PASS; 3 source-order sheets, middle blank tab, absolute nonzero-origin coordinates, typed scalars/date serial and matching report |
| Formula/link safety | PASS for fixture; inert string cells, no formula/external-reference nodes or external relationships |
| Text fidelity | PASS; Unicode/literal escape text, CSV CRLF and independent one-pass XML/ST_Xstring original CRLF |
| Native transfer | PASS; four actual source ArrayBuffers had byteLength0 after transfer |
| Negative geometry | PASS; a matching-job partial rectangle actually rejected with FORMAT_SERIALIZATION_FAILED |
| Page observers | Zero captured CSP violations, page runtime/console errors and worker error/message-error events |
| Owned browser | Fresh profile path verified inside workspace scratch; public browser close resolved before exit0 |

The fixture has source IDs30/10/20, a middle blank tab, one offset rectangle and formula_text projection with ordinary mixed scalar values. It uses no Google account, source workbook, token, download dispatch or object URL.

## Boundaries

- This page/worker fixture protocol is test-only and is not the production versioned worker bridge or its input validator.
- Page CDP observes page console/runtime events. Separate worker-console instrumentation and broad network/privacy auditing are not established here.
- SheetJS normalizes CRLF to LF; its assertion records that reader limitation. Independent XML decoding checks exact original CRLF. Desktop Excel/LibreOffice behavior remains pending.
- The test builds into ignored `.local/writer-browser-smoke/<run>/dist`; generated profiles, downloads directories and bundles are not committed. Playwright's generated temporary profile is redirected into owned workspace scratch and checked via the actual browser command line.
- Current production UI/worker remains the unconfigured scaffold. Live G1/G7, desktop CSV execution/XLSX repair checks, memory/throughput calibration and production worker/controller/download integration remain pending.
- Dependency audit findings remain as recorded in [writer-dependencies.md](writer-dependencies.md). Successful smoke execution does not prove advisory paths unreachable or approve release.

## T36c3b: native production protocol extension (2026-11-02)

Tech lead independently ran `node tests/e2e/writer-browser-smoke.mjs --bridge` and the default mode in the isolated reviewed checkout on Chrome156.0.8078.74 / Node24.14.0. Both PASS after cleanup and Vite8 input-option corrections.

Bridge mode loads the actual `src/runtime/writer-worker.ts` entry and sends version1 BEGIN/APPEND/FINALIZE messages through a native dedicated module worker. Three jobs use increasing generations and actual local JSON/CSV/XLSX WriterPorts. A fourth job has incomplete matching-job coverage and returns only the expected serialization error. Observed counts: 20 valid commands, 16 ACKs, 4 PROGRESS, 3 STAGED_ARTIFACTS, 1 ERROR, 0 unexpected replies. Malformed/auth-contaminated and stale request examples produce no accepted output.

The existing independent full JSON, CSV/ZIP and XLSX/OOXML oracles run unchanged in both modes. Bridge results: JSON1996B, CSVZIP1180B, XLSX7802B plus report862B; zero captured page/CSP/worker error events, and owned browser teardown PASS. Sizes describe this tiny synthetic fixture only.

Production replies do not expose sender detachment telemetry. Bridge mode omits that field and makes no direct sender-detachment claim; the host's native structuredClone unit check and default harness's actual four-buffer observation are separate evidence. Worker-client orchestration, native cancel/crash behavior, controller/download integration, live G1/G7 and calibration remain pending. The product UI still uses the unconfigured scaffold.
