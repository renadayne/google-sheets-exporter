# Implementation status

Updated: 2026-10-31 (Asia/Saigon).

## Working agreement

- Antigravity implements bounded tasks; Codex reviews only after the delegated task finishes.
- User selected Gemini 3.8 Flash for implementation. Launch delegated jobs with explicit `--model gemini-3.8-flash-medium`, not the CLI default. Model availability was confirmed using `agy models` on 2026-10-31. The current bridge tool has no model parameter; a project-local runtime override supplies `agy_args` without changing global settings. Local machine paths/configuration stay under ignored `.local/`.
- Codex verifies completed changes and runs relevant checks, then commits and pushes each accepted step to `origin/main` with a professional commit message.
- User confirmed Google Cloud/OAuth is not configured yet and requested continuing local work. Offline foundation, fixtures, data processing, writers, UI and tests may proceed; live OAuth/Google/Workspace evidence remains pending. No live permission or release readiness claims follow from synthetic tests.
- Git executable: `D:\Software\Git\Git\cmd\git.exe`. Remote: `https://github.com/renadayne/google-sheets-exporter.git`.

## Accepted steps

| Step | Review | Commit |
|---|---|---|
| Planning baseline | Six artifacts; all FR/NFR/AC mapped; task dependency graph checked | `a713dea` |
| T01 planning review | Accepted after fixing sharing/download distinction and distinguishing unverified account access from account absence | `d7f9c60` |
| T04 automated writer subset | PARTIAL: Node/build/Chrome pass; desktop readers and memory calibration pending | `1d6f532` |
| T03 offline GridData | PARTIAL: offline 20/20 checks pass; live API pending | `ecc7318` |
| T05 offline setup | PARTIAL: reviewed public config/template; live OAuth pending | `8ced583` |
| T02 offline authorization | PARTIAL: 24 cases / 16 checks; live tenant pending | `9d50193` |

## Execution record and pending work

T04 local browser writer harness reviewed and accepted as a partial deliverable: build, Node and Chrome MV3 tests pass after two tech-lead fixes. Full T04 remains pending desktop reader/CSV execution checks and edge coverage. See `docs/evidence/browser-writers.md` and `docs/handoffs/T04.md`.

Historical failure: Antigravity job `6bdf17d2-4de7-46c6-b92c-0ae8ae6fa64e` stopped with `RESOURCE_EXHAUSTED` while using the CLI default model. This did not establish that all model quotas were exhausted. User requested switching to Gemini 3.8 Flash; job `1091fa56-48dd-45f1-865d-577534b38480` was launched with explicit Flash model selection for T03 offline fixtures. Await final task outcome before claiming success.

T03 offline fixtures are accepted after review/correction job `f724ae2a-be45-42c7-aecf-9d573c8b23c1`: corrected overlapping merge fixture, validate all oracle cells, and reject a populated merged non-anchor. Reviewer rerun: 20/20 checks pass. Live T03 API evidence remains pending. Completed job metadata confirms `gemini-3.8-flash-medium` was actually used.

User is offline/asleep and requested avoiding new interactive approvals. Reuse already granted execution permissions where available; if an action requires a fresh approval, record it pending and continue independent runnable work.

Next local work: T03 offline fixtures, T02/T05 offline evidence/setup templates, then foundation work. Live-only rows remain pending Google configuration independently of model quota availability.

T03 offline fixtures were pushed as `ecc7318`. T05 offline setup/template is reviewed with corrections to extension-ID, cache/revocation and account-context claims; no live OAuth run is implied. Next: T02 offline matrix and T07 local foundation.

T05 offline setup/template was pushed as `8ced583`. T02 offline matrix is accepted after correcting invented Drive restriction fields and error taxonomy: 24 synthetic cases; reviewer rerun 16/16 checks pass, including missing-trashed evidence and invalid-schema mutations. Live T02 remains pending; no production authorization gate is approved from synthetic evidence alone. Offline T07 foundation may proceed under the user's local-work instruction.

T02 offline matrix was pushed as `9d50193`. T07 foundation is now **reviewed PASS for offline scope** after correction job `30fbf4fd-fd4f-443b-9292-50cce39667bc`: real clean npm install, strict typecheck, 22 unit tests, production bundle and real Chrome MV3 smoke all pass. Rejected the initial fake Vitest/scratch type paths; fixed Vite/Vitest dependency peers, CSP connections, malformed worker payload and pending-browser exit behavior. Sign-in remains disabled; no acquisition/export implementation is claimed. Next: T08a domain, T08b ports/errors, T08c worker contracts, T09 schema and T10 fake ports.

T07 was pushed as `9903e81`. T08a domain types from Flash job `89a059ed-7b00-4191-a306-c4c9852accc7` are reviewed and accepted after report/schema-alignment corrections: strict typecheck (13 compile-only negative cases) and 22 existing runtime tests pass. Metadata-only report and successful JSON document are distinct; compact exclusion intervals, explicit format/visibility and actual CSV transform counts are normative. Next: T08b ports/errors, then T08c worker messages; parent T08 is not yet complete. The machine-local launcher is `.local/start-agy-job.mjs` with `.local/agy-runtime.json`; preserve explicit Flash selection and inspect the current job state before editing owned files.

T08a was pushed as `071dec5`. T08b ports/errors are reviewed after strengthening writer metadata/final report inputs, cancellation, source observation, safe download error codes and sanitized error reconstruction. Reviewer typecheck and 12 targeted error tests pass. Parent T08 awaits T08c message contracts.

T08b was pushed as `9841809`. T08c message contracts from job `c261a207-3b66-4dd4-b031-e7fac1525c49` are reviewed PASS: required version/job/generation, no auth fields or arbitrary error bodies, staged artifacts carry no publication authority. Reviewer reran typecheck and full 34-test suite successfully. Parent T08 is complete for offline contracts. Next: T09 JSON schemas/examples, then T10 fake ports and pure source/domain tasks.

T08c was pushed as `200978f`. T09 files survived an Antigravity backend HTTP502; reviewed independently and corrected formula-text semantics, nonempty successful exports, and exclusive endpoint constraints. Formula metadata is now allowed only on inert string cells (FR-04/AC-08 contract clarification). Reviewer typecheck and 60 targeted schema tests pass. Ajv8.20.0/ajv-formats3.0.1 are exact dev-only dependencies; no runtime schema compiler is imported.

T09 phase exit: strict typecheck, full 94-test suite (6 files), production build and diff whitespace check PASS. Next: T10a shared synthetic fixture/oracle catalog, T10b deterministic async/HTTP helpers, T10c scripted domain ports. Each substep is reviewed and committed independently; do not implement all three in one agent context.

T09 pushed as `a985bc1`. T10a Flash job `d2f16368-3293-4228-ba2e-d79767890a0f` reviewed with corrections to measured byte counts and catalog copy isolation. Canonical three-tab fixture retains sparse A1/D50/Z90000, visible empty tab and hidden tab with non-consecutive IDs. Reviewer strict typecheck and 36 targeted tests PASS. T10b/T10c remain before parent T10 acceptance.

T10a pushed as `7e44af5`. T10b reviewed after correction job `458a5ae4-9e12-49c7-8689-60e6fc3ded79`: safe manual time, finite random sequence, cancellation at pre-abort/pending/microtask boundaries, explicit HTTP outcomes, Request signal precedence and secret-free helper diagnostics. Reviewer typecheck and 20 targeted tests PASS. T10c remains. T11/T12 are running independently in ignored detached worktrees: their only T10 prerequisite is the accepted T10a fixture catalog, not async helpers. No same-file concurrent edits; accepted results will be integrated individually on main.

T10b pushed as `63d6d09`. T12 job `2df5c973-5543-4e70-ae53-e9c304d6b1aa` reviewed and integrated from its isolated checkout after correcting negative IDs, terminal-newline acceptance and safe-integer endpoint limits. Reviewer isolated typecheck and 61 targeted tests PASS. Main full-suite integration waits for T10c's owned files to finish. T11 remains independent; T13 will await both parsers.

T12 pushed as `24c1f30`. T11 job `c4f756bf-6869-4b83-945d-b2ab7588f44c` reviewed/integrated after correcting malformed HTTPS normalization, Unicode gid terminators and overly broad query-value rejection. Isolated reviewer typecheck and 127 targeted tests PASS. T13 may proceed with both parsers accepted. T15a cell projection is running in a separate checkout using accepted T03/T09/T10a contracts/fixtures only; T15b GridData mapping follows its review.

T11 pushed as `84078de`. T10c job `dca50558-3d1d-4b72-8329-5043369aa361` reviewed after removing an inconsistent auto-wiring example and replacing any-typed deferreds. Added explicit denial/version-change/lifecycle and transport forwarding checks. Main integration typecheck + full 345 tests across 11 files PASS (T11/T12 included); diff check PASS. Parent T10 complete for offline helpers, G2 foundation/contracts accepted. T13 proceeds; G1/G7 live evidence still pending.

T10c pushed as `9453d27`. T15a job `96d6124d-d9ae-4445-be65-7da6113e6e1a` reviewed/integrated with corrections for display-only data loss, unknown value variants/non-JSON objects, and guessed user-format fallback. Reviewer isolated typecheck and 9 targeted table-driven tests PASS. T15b GridData offsets/chunk assembly remains; T13 owns scope files on main, T25 names runs isolated. No live omission/default behavior is claimed verified.

T15a pushed as `015930d`. T13 job `952b6382-4be2-4588-a0b3-be30706c75f6` reviewed with one range-input shape, explicit hidden-tab/API-visible conflict and shuffled source metadata regression. Reviewer main typecheck + 379/379 tests across 13 files PASS, integrating T15a. T14a tiling/splitting then T14b coverage ledger follow. T15b normalization and T25 naming remain isolated jobs.

T13 pushed as `6aeb283`. T15b job `e06271a8-05e2-453c-a640-b926a743553c` reviewed/integrated: scalar projection reused, exact absolute offsets/sorted sparse cells, unchanged scope on trailing omissions, explicit single-sheet/source binding and safe rejection of malformed/outside/duplicate positions. Reviewer isolated typecheck + 7 targeted tests PASS. Parent T15 accepted for conservative offline subset: missing data/offsets intentionally unsupported until live T03 evidence; no production acquisition claim. T25 timed out without handoff; review identified a reserved-filename collision loop and correction is required before acceptance.

T15b pushed as `3d85dcc`. T14a job `4f3b31be-bb45-466e-865f-28b25c4def1c` reviewed with safe clipped endpoint arithmetic, exact position-product validation and canonical split-parent IDs. Reviewer main typecheck + full 397/397 tests across 15 files PASS (T15b included). T14b ledger is next; resource limits still must precede materializing huge plans. T16 visibility and T25 correction run independently; no new interactive approval pending.

T14a pushed as `c4b9fbb`. T25 correction job `586c44e8-bd01-4bf6-973a-a81ffbfd4e4d` reviewed after fixing the reserved-with-extension infinite loop. Naming rules preserve exact source mappings, enforce worksheet/portable filename caps, handle NFC/case/natural suffix collisions and replace invalid output-name code units. Reviewer isolated typecheck + bounded 13-test suite PASS. No lingering owned T25 Vitest processes were found; the original stop was a print timeout, not a denied approval. T14b/T16 remain active; main integration waits for T14b files to finish.

T25 pushed as `a3f356d`. T14b job `c043b962-eb2c-4889-80e4-dddb4bef1b3d` reviewed without implementation corrections: partition constructed internally, split ancestry separate from active leaves, retry/idempotency/failure transitions and immutable snapshots match contracts. Reviewer main typecheck + full 422/422 tests across 17 files PASS (T25 included). Parent T14 complete for pure geometry/coverage. T16 is under final review; T24a static schema generation is running isolated.

T14b pushed as `5c825d6`. T16 job `93c0e3fe-77df-471d-b679-771d3a5ed062` reviewed with added incoming-coordinate bounds, nested error copy isolation, single-sheet/hidden-tab guards and equivalent column flags on overlaps. Reviewer isolated 12 tests PASS; main phase-exit typecheck + full 434/434 tests across 18 files + production build PASS. G3 pure tasks T11-T16 accepted for the documented conservative offline subset; missing API offset/visibility defaults remain G1 follow-up, not presumed verified. T24a static validators run isolated before JSON writer implementation; G4 local retry/adapter work may proceed without enabling unverified live acquisition.

T16 pushed as `104dfb5`. T24a job `9faea0c3-d286-45e2-8e72-0220f035d87b` reviewed/integrated: build-time standalone schema code, safe predicates, no runtime compiler/imports, versioned deterministic hash, full helper license notices, first-error runtime diagnostics and owned non-recursive test cleanup. Reviewer root/worktree schema regeneration agrees; 20 targeted tests including locked-down VM PASS. Main typecheck + 491 tests across 20 files + schema prebuild/build PASS; T19a source/tests are present but await separate review. Parent T24 still awaits relational validation and real JSON writer; no new export/UI capability is claimed.

T24a pushed as `97a3f01`. T19a job `a0ce32d0-2128-41e9-bf99-f97858d182c6` reviewed with strict integer Retry-After parsing, safe clocks/budgets, no RNG consumption for exhausted/impossible waits and contained diagnostic exceptions. Reviewer strict typecheck + targeted 39 tests PASS. T19b runner/timers follow. CSV parser 5.6.0 dev dependency has been installed for isolated T26; package/lock changes belong to that upcoming step and are intentionally excluded from T19a's commit.

T26 correction job 27fd8a36-4dad-44bf-99c9-2f462a6a9406 reviewed: single-rectangle CSV preserves relative gaps, typed scalar formatting and exact text, applies apostrophe_prefix_v1, rejects invalid UTF-8 source text and enforces bounded output. Wide blank-row template and oversized escaped-field allocation defects fixed. Reviewer isolated strict typecheck + 13 independent-parser tests PASS, including A1/D50/Z90000, 30000-column blank row, escaped UTF-8 byte caps and cancellation polling. csv-parse 5.6.0 is test-only. WriterPort/ZIP/UI and real desktop importer checks remain pending; no publication capability is claimed.

T26 pushed as 8c1f0d9. T24a2 final job 6a828e85-abde-4c85-8ee1-389782ad4651 reviewed: Cell guard shares the precompiled schema, clears errors and preserves source strings/types. Reviewer resolved temporary-file EPERM using existing granted Node execution; isolated strict typecheck + 25 static tests + schema check PASS. Main schema generation agrees on hash 7c4143a7d76f9252. Cell shape validation alone does not prove bounds, projection agreement, uniqueness or coverage. Live/browser validator verification remains pending.

T24a2 pushed separately after main static tests/schema check PASS. T24b1a correction job 1620f8a7-42dd-49fa-84a4-9ae14a1df06a reviewed: strict sanitized context, source-order scope alignment, bounded arbitrary chunk partitions, BigInt areas plus pairwise non-overlap prove full geometry even for blank sheets. Fixed enumerable-key whitelist escape and rebuilt caught DomainErrors; options captured once, cancellation polled. Reviewer isolated strict typecheck + 10 targeted tests PASS. Cell/exclusion/report validation remains separate, and provisional 4096-chunk guard is not calibrated.

T24b1a pushed as df54670; T24a2 as 308ff8d. T19b final correction job 68374174-4027-4d5f-97d1-9a23f36f6e4e reviewed with a final config DomainError reconstruction fix. Retry runner bounds attempts, clock/deadline, native/custom backoff and cancellation, ignores late hostile outcomes, observes promise handlers and cleans timers/listeners. Reviewer main strict typecheck + 71 retry/policy tests PASS. No adapter/auth/publication authority is implied. T24b1b exclusions and T24b1c Cell collection now run independently in isolated checkouts.

T19b pushed as 8aec39f. Main integration after T24a2/T24b1a/T19b: strict typecheck, 553/553 tests across 23 files, schema check and production build PASS. T24b1c job f958439c-4898-4a9a-a477-caa37c638468 reviewed: bounded schema-based Cell collection, projection agreement, chunk-local safe coords, duplicate rejection, sorted immutable copies with exact source content. Reviewer strengthened full value/type/origin/copy tests; isolated/main typecheck + 8 targeted tests PASS. Geometry/exclusion/report validation remains outside this helper; no writer/UI integration claimed.
