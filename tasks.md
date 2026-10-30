# Small-task backlog for implementation agents

Đây là backlog gốc. Trạng thái thực hiện, kết quả review và commit hiện tại nằm ở [docs/task-status.md](docs/task-status.md). Mỗi heading là một đơn vị giao việc, không giao nguyên tài liệu cho một agent để làm hết. Dependencies nghĩa là predecessor đã review/pass trong phạm vi được phép, không chỉ đã có file; offline pass không thay thế live verification.

## Quy tắc và prompt giao việc

`A§X` = section X trong architecture.md; `F§X` = feasibility-assessment.md. Ngoài inputs liệt kê, chỉ đọc đúng contract/import/test liên quan. Không cần load cả repo hay sáu tài liệu cho mỗi task.

Mọi task phải trả: files changed, behavior, lệnh test và kết quả thật, limitations/blockers, handoff `docs/handoffs/Txx.md`. Chỉ sửa vùng ownership liệt kê + tests tương ứng + handoff. Không tự sửa requirements, contract, scopes hoặc giới hạn để làm test pass. Không commit secrets. Không tạo “mock authorization success” trong production. Size S ~1 behavior/1-3 files; M ~2-4 files, tách tiếp nếu vượt. Spike có thể dừng bằng kết luận fail có evidence, không bắt buộc viết production code.

```text
Implement only Txx: <title>.
Dependencies reviewed: <IDs + handoff paths>.
Read: <exact requirement excerpts + architecture sections + contracts>.
Allowed files: <paths>. Do not edit other production modules.
Implement: <task Steps>. Do not implement: <Out of scope>.
Pass criteria: <task assertions>; run <targeted test command from package scripts>.
If input/contract is missing or contradictory, report blocker; do not invent a replacement.
Return handoff with exact tests/results and remaining limitations. Stop after Txx.
```

Commands sau T07: `npm run typecheck`, `npm test -- <test-file>`, `npm run build`, `npm run test:e2e -- <spec-file>`. T07 phải đảm bảo scripts tồn tại; task trước T07 ghi reproducible spike commands riêng. Không chạy toàn bộ suite cho mọi leaf task; G7 chạy tổng hợp.

## Foundation và spikes

### T01 — Record planning review and prerequisites (S)
- Depends: none. Read: requirements §9-10, decisions table, implementation stages.
- Files/output: `docs/evidence/planning-review.md`; không application code.
- Steps: ghi accepted/revise decisions, gate owner, tenant/client prerequisites có/thiếu; không ghi approval nếu chưa có.
- Pass: mỗi B/Q có status+owner; permission boundary được review. Missing approvals là pending.
- Trace: FR-02, NFR-05/08/10, AC-10/11/20. Out: OAuth setup automation.

### T02 — Prove authorization truth table (M, reviewer-assisted spike)
- Depends: T01. Read: F§2-5, A§C, B01/B02/Q06.
- Files/output: `docs/evidence/authorization-matrix.md`, sanitized response fixtures; isolated probe only.
- Steps: owner/editor/viewer allowed; viewer IRM; writer restriction; shared-drive; DLP/context deny; missing fields; canDownload disagreement; mid-job revocation. Use same principal for metadata checks. Establish field omission semantics and allowed predicate; no data read after denial.
- Pass: expected/actual per row + official sources + residual gaps. G1 blocked if target policy coverage cannot be proven. Review exact permission predicate before T18.
- Trace: FR-02/13, NFR-05/06, AC-10/11/12/14/20. Out: production gate or alternate extraction.

### T03 — Verify GridData fidelity and visibility (M, spike)
- Depends: T01. Read: A§E/F, F§5 S02.
- Files/output: `docs/evidence/grid-fidelity.md`, `tests/fixtures/grid/*.json` (synthetic only).
- Steps: create approved known-value fixture; read bounded offsets; verify modes/date/error/empty-string/merged/hidden/filter metadata and unsupported types. Include A1,D50,Z90000 + nonzero-origin chunks.
- Pass: oracle vs returned coordinates/types; blank omission semantics documented; filter-view limitation explicit.
- Trace: FR-03/04/05/07/12, NFR-02, AC-04/05/07/08/18. Out: production reader.

### T04 — Validate browser writer and dependency choice (M, spike)
- Depends: T01. Read: A§B/H/I, F§5 S03.
- Files/output: `docs/evidence/browser-writers.md`, isolated fixture harness.
- Steps: bundle ExcelJS/fflate in MV3 worker, write 3-tab XLSX/CSV ZIP; inspect XLSX XML for formulas; open in independent reader and desktop reader; test sparse Z90000, names, long strings, BOM, injection payloads, worker termination.
- Pass: no CSP/Node-runtime errors, no formulas/repair; document failures/memory and pin tested candidate versions. Failed candidate -> reviewed replacement spike, not blind swap.
- Trace: FR-08/09/11, NFR-01/03/05, AC-01/02/06/09/16. Out: UI integration.

### T05 — Verify OAuth, account identity and scopes (M, spike)
- Depends: T01. Read: A§B/C, F§3; B03/B04.
- Files/output: `docs/evidence/oauth-setup.md`, redacted config template.
- Steps: configure test extension client/ID and APIs; test identity token and same-token userinfo; differing Chrome/Sheets accounts, denied consent, revoked token, enterprise approval; prove no client secret needed. Confirm minimal hosts/scopes and public/internal review implications.
- Pass: reproducible steps; correct account shown, no silent account fallback; sensitive failures classified from actual reason where available.
- Trace: FR-01/02/13, NFR-01/05/06/10, AC-11/12/19/20. Out: persisting tokens or page auth reuse.

### T06 — Calibrate initial resource budgets (M, spike)
- Depends: T03,T04. Read: A§I, test-plan benchmark table.
- Files/output: `docs/evidence/initial-benchmarks.md` and synthetic benchmark generator.
- Steps: record positions vs nonempty cells vs bytes, dense/sparse/long-string read+write, actual browser memory, API counts/time; compare proposed budgets.
- Pass: actual measurements/hardware/versions; supported envelope and fallback reviewed. Failing target remains blocker until limits or design reviewed.
- Trace: FR-05/06/11, NFR-03/04, AC-04/13/15/16. Out: declaring all Google max-sized workbooks supported.

### T07 — Minimal MV3 build and test harness (M)
- Depends: T01,T04,T05. Read: A§B/D.
- Files: package.json, lockfile, tsconfig, vite config, manifest template, minimal entries; this foundation exception can exceed 5 tiny config files.
- Steps: pin tested versions/runtime; scripts typecheck/test/build/test:e2e; local page+worker bundles, action bootstrap placeholder; no live API data job.
- Pass: clean install/build; unpacked extension loads no CSP/manifest errors; no remote code; permissions match reviewed T05.
- Trace: FR-13, NFR-01/08/10, AC-20. Out: auth/data logic.

### T08 — Freeze domain and port contracts (M)
- Depends: T02,T03,T07. Read: A§D/E/F/I and spike findings.
- Files: `src/contracts/{domain,ports,errors,messages}.ts`.
- Steps: discriminated unions, zero-based Rect, typed Cell/error, job generation, safe error codes, async port cancellation and writer lifecycle; error classes preserve retry reason without HTTP secrets.
- Pass: typecheck + compile-time invalid-case fixtures; reviewer approves interface names/semantics. No any-shaped API payload crossing domain boundary.
- Trace: FR-02/04/05/10/11, NFR-08, AC-03/08/14/15. Out: adapter implementation.

Execution refinement for Flash: T08a defines domain types and negative type fixtures; T08b adds ports/errors against the reviewed domain; T08c adds sanitized worker-message contracts. Review/commit each substep separately. T08 is complete only when all three pass together; preserve the same parent scope and traceability.

### T09 — JSON/report schemas and valid examples (S)
- Depends: T08. Read: A§G.
- Files: `src/contracts/export.schema.json`, report schema and synthetic examples.
- Steps: draft 2020-12 schemas, required fields/enums, bounded coordinates, no secrets; document schema vs runtime cross-field checks.
- Pass: valid raw/formatted/formula/error/empty examples; rejects missing completeness/invalid coordinates/type mismatch/extra account token fields.
- Trace: FR-10/12/13, NFR-07/08, AC-03/05/08. Out: serializer.

### T10 — Shared fixture oracles and fake ports (M)
- Depends: T08,T09,T03. Read: test-plan fixtures.
- Files: `tests/fixtures`, `tests/helpers/fake-ports.ts`.
- Steps: deterministic clock/random/fetch adapters, small fixtures with explicit expected coordinates, mutation/denial/cancel schedules; generated large data only on demand.
- Pass: helpers themselves deterministic; oracle hand-reviewed; no real account metadata; no duplicate production algorithms generating expected results.
- Trace: FR-02/05/11, NFR-02/04/10, AC-04/10/13/15. Out: mocking away production safety gates.

## Pure source/domain tasks

### T11 — Validate source URL/ID (S)
- Depends: T08,T10. Read: FR-01, A§D.
- Files: `src/source/identify.ts`, corresponding unit test.
- Steps: allow supported docs.google.com spreadsheets URL and validated ID, parse gid as highlight only; reject alternate host/scheme/userinfo/path tricks and unsupported published links; return SourceRef.
- Pass: URL/ID table incl malicious URLs and malformed gid; no arbitrary endpoint returned.
- Trace: FR-01, NFR-05, AC-19/20. Out: network/current-tab access.

### T12 — A1 parser and canonical bounds (S)
- Depends: T08,T10. Read: A§E points 1-2.
- Files: `src/source/a1.ts`, unit test.
- Steps: convert columns/rows, optional escaped quoted sheet names, rectangle/single cell/whole rows/columns; resolve grid bounds; reject unsupported unions/named ranges/out-of-bounds safely.
- Pass: Z/AA transitions, Unicode/apostrophe sheet, absolute `$` notation, A1/last grid cell, reversed/mismatched sheet inputs; no off-by-one.
- Trace: FR-03/05/06, NFR-02, AC-04/06/16. Out: UI selectors.

### T13 — Build immutable scope plan (S)
- Depends: T11,T12,T08,T10. Read: A§E.
- Files: `src/domain/scope.ts`, unit test.
- Steps: original sheet order, hidden default, gid highlight independent from selection, one rect/sheet, full allocated bounds; validate unsupported selected type/zero tabs.
- Pass: exact plan from 3-tab fixture, explicit selected range, no implicit filtering/used-range shrink.
- Trace: FR-01/03/05/06/07, NFR-07, AC-01/04/18/19. Out: estimates/network.

### T14 — Partition grid and track exact coverage (M)
- Depends: T13,T08,T10. Read: A§D/E/I.
- Files: `src/domain/chunks.ts`, `coverage.ts`, tests.
- Steps: deterministic 2D tiling, split oversized chunk, completed IDs, no duplicate counting; disallow overlapping/missing coverage at finalize.
- Pass: seeded/property tests prove union equals requested Rect; blank chunks complete; repeated/retried chunk no duplication; A1/Z90000 included.
- Trace: FR-05/06/11, NFR-02/03, AC-04/05/13. Out: HTTP retries.

### T15 — Normalize GridData to typed sparse cells (M)
- Depends: T03,T08,T10. Read: A§E/F.
- Files: `src/domain/normalize.ts`, tests.
- Steps: use response offsets, keep scalar types/empty strings/errors, project selected mode only; enforce response cells within requested range; no coercion/merge fill-down.
- Pass: nonzero offsets, trailing omission, formula empty result, number/bool/date serial/error, special whitespace; source strings never become formulas.
- Trace: FR-04/05/10, NFR-02, AC-04/05/07/08/09. Out: formatting guessed from locale.

### T16 — Apply API visibility without compaction (S)
- Depends: T03,T08,T10,T13. Read: A§E points 4-6.
- Files: `src/domain/visibility.ts`, tests.
- Steps: dimension intervals, hiddenByUser/Filter union, include-all; preserve gaps and exclusions; metadata insufficiency produces capability error.
- Pass: known hidden row/col cells excluded, surviving coordinates unchanged, no active-filter-view claim.
- Trace: FR-05/07, NFR-02/07, AC-18. Out: UI scraping or personal filter simulation.

## Auth, network and acquisition

### T17 — Identity adapter and same-token account context (M)
- Depends: T05,T07,T08,T10. Read: A§B/C/D.
- Files: `src/auth/chrome-identity.ts`, `account.ts`, tests.
- Steps: interactive signin only, token retrieval memory-only, same-token identity display, signout invalidates generation; normalize consent/login/admin statuses from reviewed evidence.
- Pass: mismatched page/profile fixture shows token principal; no tokens in logs/errors/messages; no automatic signin on page visit.
- Trace: FR-02/13, NFR-05/06, AC-11/12. Out: Drive gate.

### T18 — Drive eligibility gate (M)
- Depends: T02,T17,T08,T10. Read: T02 reviewed predicate, F§3.
- Files: `src/source/drive-gate.ts`, table-driven tests.
- Steps: exact field mask, supportsAllDrives; classify permitted/restricted/uncertain/missing/admin/login; bind result to principal/source, no stale positive cache between jobs.
- Pass: every T02 matrix fixture; missing/mismatched evidence fail closed; never calls data port on denial. Reviewed predicate required, not inferred by implementer.
- Trace: FR-02/13, NFR-05/06, AC-10/11/12/14/20. Out: role guessing, fallback URLs.

### T19 — Bounded request runner (S)
- Depends: T08,T10. Read: A§I retry policy.
- Files: `src/jobs/retry.ts`, tests with fake clock.
- Steps: retry allowlist, 4 attempts, timeout, jitter/Retry-After bounded by wall budget, cancellation; redact errors; no broad retry-all-403.
- Pass: exact attempts/delays for 429/503/network; denial/404 one attempt; cancel during wait immediate; no raw token/body in error.
- Trace: FR-02/11/13, NFR-04/06, AC-13/14/15. Out: account switching.

### T20 — Workbook metadata adapter (S)
- Depends: T18,T19,T08,T10. Read: A§D/E, T03 metadata evidence.
- Files: `src/source/sheets-metadata.ts`, integration test.
- Steps: metadata field mask; map title/locale/timeZone/sheets order/id/type/grid bounds/hidden; reject malformed response with clear unsupported status.
- Pass: no grid data requested; stable IDs/order including empty/hidden/Unicode; explicit gate required.
- Trace: FR-03/06/07, NFR-02, AC-01/05/06/18. Out: cell acquisition.

### T21 — Bounded grid-read adapter (S)
- Depends: T20,T19,T08,T10. Read: A§E/F; T03 verified field masks.
- Files: `src/source/sheets-grid.ts`, integration test.
- Steps: safely quote sheet title, encode ranges/fields, parse only requested GridData fields, pass signal; provide byte measurement and oversize signal for split.
- Pass: apostrophe/title escaping, offsets, 401 refresh coordination error, oversized/empty response; never private endpoints or unbounded workbook read.
- Trace: FR-03/04/05/11, NFR-02/03, AC-04/06/08/13. Out: normalizing coordinates or publishing.

### T22 — Acquire chunks under gate with coverage (M)
- Depends: T14,T15,T16,T18,T19,T21,T10. Read: A§C/E/I.
- Files: `src/jobs/acquire.ts`, integration test.
- Steps: one in-flight request, pre-batch gate, read/normalize/filter/append, split oversized rectangle, ledger updates only on success, monotonic progress.
- Pass: no data after denial; late completion ignored; every leaf fetched incl blank regions; repeated chunk not appended twice; caller receives incomplete state on fault.
- Trace: FR-02/04/05/07/11, NFR-02/04/05, AC-04/10/13/14/15/18. Out: downloads/controller UI.

### T23 — Size estimator and runtime budget guards (S)
- Depends: T06,T13,T22,T10. Read: A§I and reviewed benchmark caps.
- Files: `src/jobs/limits.ts`, tests.
- Steps: estimate positions/chunks/request-minimum time with unknown bytes explicit; account for aggregate decoded/output bytes and emitted cells; return limit error before publishing.
- Pass: sparse large vs dense long-string bounds; numeric overflow-safe counts; warning/limit displayed scope unchanged; above-cap failure zero download.
- Trace: FR-05/06/11, NFR-03/07, AC-04/15/16. Out: automatically reducing range.

## Output writers

### T24 — JSON writer and schema validation (S)
- Depends: T09,T15,T10. Read: A§G.
- Files: `src/export/json.ts`, schema integration test.
- Steps: sparse sorted unique coordinates, mode/types/source metadata, scopes/exclusions/warnings, timestamp; complete report only when supplied complete ledger.
- Pass: schema-valid oracle round-trip, empty sheet, no credentials/unselected representations; reject nonfinite values/duplicates.
- Trace: FR-04/05/10/12/13, NFR-02/07, AC-03/04/05/07/08. Out: network or authorize publication.

### T25 — Deterministic filenames and worksheet mappings (S)
- Depends: T08,T10,T04. Read: A§H names.
- Files: `src/export/names.ts`, unit tests.
- Steps: invalid chars, length, Unicode-safe truncation, case-insensitive suffix collisions, reserved basenames; generate mapping from original IDs/titles.
- Pass: stable outputs for same ordered input, no duplicate names/path traversal, every original title mapped.
- Trace: FR-08/09/10, NFR-02/05, AC-06. Out: changing original source titles.

### T26 — Safe CSV row encoder (S)
- Depends: T15,T25,T10,T04. Read: A§E/H.
- Files: `src/export/csv.ts`, tests.
- Steps: rectangle-relative dense emission with full blank gaps, quote-all/comma/CRLF/UTF-8 BOM, source-text safety prefix, transform counts; no header inference.
- Pass: independent CSV parse of commas/quotes/CRLF/emoji/00123, blanks and nonzero-origin range; dangerous strings prefixed, numeric negatives unmodified.
- Trace: FR-04/05/09, NFR-02/05, AC-05/07/08/09. Out: ZIP/UI.

### T27 — CSV multi-tab package and manifest (S)
- Depends: T26,T09,T25,T04. Read: A§G/H.
- Files: `src/export/csv-package.ts`, integration test.
- Steps: one-tab CSV vs multi-tab ZIP, one file/tab in order, manifest mapping/origin/exclusions/transforms, bounded aggregate bytes; reject partial inputs.
- Pass: unzip with independent utility; 3 CSVs + manifest, correct stable IDs/names/row dimensions; no extra account fields.
- Trace: FR-03/09/10/13, NFR-07, AC-02/06/07. Out: direct downloads.

### T28 — XLSX scalar cell writer (M)
- Depends: T04,T15,T25,T10. Read: A§E/F/H.
- Files: `src/export/xlsx.ts`, integration tests.
- Steps: one sheet per selected tab, original order, absolute positions, typed scalars; formula mode strings; no formula/hyperlink objects; maintain empty sheets.
- Pass: independent reader exact A1/D50/Z90000/types/names; inspect ZIP XML no formula nodes/external links; no extra metadata worksheet.
- Trace: FR-03/04/05/08, NFR-02/05, AC-01/04/05/06/08/09. Out: recreating styles/formula calculation.

### T29 — XLSX representability guards and report (S)
- Depends: T28,T09,T23,T10. Read: A§G/H; Q05 review.
- Files: `src/export/xlsx-guards.ts`, tests; minimal call-site wiring in xlsx.ts.
- Steps: absolute dimension limits, string length, invalid XML chars, finite numeric precision policy; companion report; fail entire artifact if unsupported value.
- Pass: boundary+1 fixtures and unsupported chars reject without truncation; JSON alternative message; companion mapping/scopes correct.
- Trace: FR-06/08/12, NFR-02/07, AC-06/08/16/17. Out: silently sanitizing cell values.

## Orchestration and UI

### T30 — Job state machine with cancellation races (M)
- Depends: T22,T23,T24,T27,T29,T10. Read: A§D/I.
- Files: `src/jobs/controller.ts`, integration tests.
- Steps: legal transitions, immutable request, one active job/page, generation guards at await boundaries, AbortController, stage-private artifact; distinguish complete retrieval vs download.
- Pass: cancel during read/retry/serialize; stale messages/second job/account change cannot publish; terminal cleanup always called; no partial download.
- Trace: FR-02/11/13, NFR-04/05/06, AC-10/13/14/15. Out: DOM UI.

### T31 — Download adapter and final permission barrier (M)
- Depends: T30,T18,T10. Read: A§C/G/I.
- Files: `src/runtime/download.ts`, integration tests; controller publish call-site.
- Steps: recheck same principal permission after serialization, generation check, Blob URL then downloads API; track completion/interruption; XLSX companion status; revoke URLs on terminal.
- Pass: revoke just before final check -> zero downloads; stale worker artifact ignored; browser rejects/cancels download -> actionable state; all files success required for completed bundle.
- Trace: FR-02/08/09/11/13, NFR-04/05/06, AC-01/02/10/14/15. Out: automatic alternate account retry.

### T32 — Source consistency observations (S)
- Depends: T30,T18,T20,T09,T10. Read: A§I consistency.
- Files: `src/jobs/consistency.ts`, integration tests; minimal controller hook.
- Steps: compare before/after version/modifiedTime/dimensions; detected change abort; always non-atomic report even when unchanged; comparison failure -> uncertain consistency error, no misleading snapshot.
- Pass: edit/resize during job prevents artifact; unchanged metadata has limitation; no false atomic claim for volatile formulas.
- Trace: FR-12, NFR-07, AC-17. Out: revision pinning guarantee.

### T33 — Source/account screen (S)
- Depends: T11,T17,T20,T07. Read: FR-01/02; A§B.
- Files: `src/ui/source-view.ts`, UI tests.
- Steps: manual URL/ID, current-tab prefill, active token account, signin/eligibility/source errors; textContent only; keyboard labels.
- Pass: malformed URL no network, gid highlight not selection, login/admin/restricted/uncertain distinct; page visit alone causes no extraction.
- Trace: FR-01/02/13, NFR-05/09, AC-10/11/12/19/20. Out: changing auth implementation.

### T34 — Scope/mode/format selector and estimate (S)
- Depends: T33,T13,T16,T23. Read: A§E/F/H.
- Files: `src/ui/scope-view.ts`, UI tests.
- Steps: tab checkbox order, hidden labels/opt-in, per-tab A1, 3 modes/formats, limits, API-visible limitation; show exact scope before explicit Export.
- Pass: zero selections disabled, unsupported selections/errors visible; giant scope not silently narrowed; every control keyboard-operable.
- Trace: FR-03/04/06/07, NFR-07/09, AC-08/16/18/19. Out: starting job automatically on mode change.

### T35 — Progress/error/completion view (S)
- Depends: T30,T23. Read: A§I state machine, FR-11.
- Files: `src/ui/job-view.ts`, UI tests.
- Steps: phase and chunk/tab counts, indeterminate serialization, cancel, safe actionable error codes, transformed CSV/consistency/partial-download summary.
- Pass: no fake 100% before download; aria-live status; no raw API secrets; cancelled/failed never show completed artifact.
- Trace: FR-06/11/12/13, NFR-07/09, AC-13/14/15/17. Out: retry orchestration in UI.

### T36 — Dedicated worker bridge and ownership cleanup (M)
- Depends: T24,T27,T29,T30,T08,T10. Read: A§B/C/I.
- Files: `src/runtime/export-worker.ts`, `worker-client.ts`, tests.
- Steps: validated messages/job generation, locally bundled writer, transferable buffers, progress, terminate-on-cancel; no tokens/API authority inside worker.
- Pass: malformed/stale message ignored; worker crash no publish; cancellation frees references/terminates; no duplicated giant buffers beyond benchmark envelope.
- Trace: FR-11/13, NFR-01/03/06, AC-15. Out: SW keepalive tricks.

### T37 — Compose runtime and UI (M)
- Depends: T31,T32,T34,T35,T36. Read: A§B/C/D.
- Files: `src/ui/main.ts`, `src/runtime/service-worker.ts`, `export.html`/styles; import-only wiring elsewhere if reviewed.
- Steps: real adapters composition; toolbar opens/reuses page, passes validated tab URL, explicit Export binds request; page close/signout hooks.
- Pass: mocked E2E 3 tabs all 3 formats; permissions occur before data; action click only prefills; no global tokens.
- Trace: FR-01/02/03/08/09/10/11/13, NFR-01/09, AC-01/02/03/12/19. Out: new product features.

### T38 — Lifecycle and privacy integration audit (S)
- Depends: T37. Read: A§C/I; NFR-05/06.
- Files: `tests/e2e/lifecycle.spec.ts`, `privacy.spec.ts`, evidence report; fixes assigned to owning task.
- Steps: stop service worker while exporting, close/reload page, crash worker, sign out, memory cleanup, endpoint/log/storage inspection, accessibility keyboard pass.
- Pass: SW stop not corrupt job; tab interruption no file/auto-resume; no persisted dataset/token; logs/exports redacted; no third-party data traffic.
- Trace: FR-02/11/13, NFR-01/05/06/09, AC-10/12/15. Out: introducing persistence to hide failures.

## Release verification

### T39 — Full offline acceptance suite (M)
- Depends: T38. Read: test-plan acceptance matrix.
- Files: `tests/integration/acceptance`, `tests/e2e/acceptance`, evidence checklist.
- Steps: run actual production composition with controlled API transport; validate files independently; complete every automated AC row.
- Pass: typecheck/unit/integration/build/E2E pass; mocked tests clearly labeled, not used as tenant evidence.
- Trace: FR-01..FR-13, NFR-01/02/04/07/09/10, AC-01..AC-20. Out: papering over failures by snapshot update.

### T40 — Real account and Workspace acceptance (M, human/admin-assisted)
- Depends: T38,T02,T05. Read: test-plan tenant protocol.
- Files: `docs/evidence/tenant-acceptance.md`; sanitized evidence only.
- Steps: real allow/deny/admin/multi-account/revoke/source-change/hidden fixtures; monitor data/download calls. Check final gate races with controlled policy changes.
- Pass: mandatory tenant rows pass with role/policy/version/date; absent tenant -> blocked, not pass/waived by implementer.
- Trace: FR-02/03/04/07/11/12/13, NFR-04/05/06, AC-08/10/11/12/14/17/18/20. Out: bypassing production restrictions to collect test data.

### T41 — Production benchmark and limit verification (S)
- Depends: T38,T06. Read: test-plan benchmarks, A§I.
- Files: `tests/benchmarks`, `docs/evidence/performance.md`.
- Steps: final bundled extension on documented machine, dense/sparse/long strings, actual limits plus one-over; measure requests/memory/cancel/bytes/elapsed.
- Pass: supported envelope meets targets; above-cap terminal no file; caps versioned and UI/docs aligned; failure creates blocker, not covert limit change.
- Trace: FR-05/06/11, NFR-03/04, AC-04/13/15/16. Out: unmeasured performance promises.

### T42 — Desktop reader compatibility and injection audit (S)
- Depends: T38,T04. Read: A§H; test-plan reader protocol.
- Files: `docs/evidence/reader-compatibility.md`, generated synthetic fixtures.
- Steps: Excel/LibreOffice versioned open/import of XLSX/CSV; no repair, no formula execution, name/type/Unicode/date semantics; independent XML/parser validation.
- Pass: all declared supported readers pass; transformed CSV documented; unsupported reader behavior not called safe universally.
- Trace: FR-04/08/09, NFR-02/05, AC-01/02/06/07/08/09/16. Out: changing value semantics without review.

### T43 — Reproducible setup and user limitations (S)
- Depends: T38,T05,T41. Read: reviewed decisions and observed behaviors.
- Files: README.md, `docs/setup.md`, `docs/privacy.md`.
- Steps: clean install/build/load, OAuth project/extension ID/scopes/admin setup, test commands, fixture export, local cleanup and tab lifetime, modes/ranges/CSV transforms/non-atomic disclaimer/restricted guidance.
- Pass: another person/clean environment follows guide; no hidden credentials/undocumented dependency.
- Trace: FR-02/04/06/11/12/13, NFR-06/07/10, AC-11/20. Out: publishing Web Store build.

### T44 — Final traceability and release decision (S, reviewer)
- Depends: T39,T40,T41,T42,T43. Read: all evidence summaries and test-plan matrices.
- Files: `docs/evidence/release-readiness.md`.
- Steps: every FR/NFR/AC linked to concrete test result, dependency/license/CSP/permissions review, unresolved blocker list; distinguish completed plan vs verified implementation.
- Pass: zero unmet Must for approved supported scope; stakeholder decides scope adjustments; no unrun manual evidence described as passed.
- Trace: FR-01..FR-13, NFR-01..NFR-10, AC-01..AC-20. Out: deployment/publishing without its own authorization.
