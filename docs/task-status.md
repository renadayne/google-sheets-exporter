# Current implementation status

Updated: 2026-11-02 (Asia/Saigon). Detailed chronology: [execution-history.md](execution-history.md). Read this current state and the assigned task card; open only relevant handoffs/contracts.

## Execution agreement

- Antigravity implements one bounded task with explicit `gemini-3.8-flash-medium`; no nested delegation or implementer commits/pushes.
- Codex reviews actual changes AFTER the job finishes, verifies appropriate checks, then commits/pushes accepted leaves separately to `origin/main`.
- User has no Google Cloud/OAuth setup and authorized local work first. G1/G7 live evidence remains pending; fixtures do not approve production acquisition, permission claims or release.
- User is offline: reuse existing granted permissions; record genuinely new interactive approvals pending and continue independent work. Do not bypass controls.
- Remote: `https://github.com/renadayne/google-sheets-exporter.git`. Git: `D:\Software\Git\Git\cmd\git.exe`.
- Ignored `.local/start-agy-job.mjs` and `.local/agy-runtime.json` pin the Flash model without global configuration. Recover running jobs with bridge_list before relaunch; one active job per project. Separate tasks may use ignored detached worktrees. Never edit an active agent's owned files.
- Root writer dependencies are pinned: ExcelJS4.4.0/fflate0.8.3; dev-only XML/SheetJS readers. Dependency release review remains pending as documented below.

## Accepted offline foundation

All commits below were reviewed and pushed. Acceptance is for their bounded offline scope.

| Scope | Commits / evidence |
|---|---|
| Planning/contracts | baseline `a713dea`; T01 `d7f9c60`; T08a/b/c `071dec5` / `9841809` / `200978f`; T09 `a985bc1` |
| T02/T03/T04/T05 partial offline evidence | `9d50193` / `ecc7318` / `1d6f532` / `8ced583`; live tenant/OAuth, desktop readers and calibration remain pending |
| T07 MV3 scaffold | `9903e81`; CONFIG_REQUIRED UI, sign-in disabled; real local Chrome smoke passed |
| T10 fixtures/async/fake ports | `7e44af5` / `63d6d09` / `9453d27` |
| T11 source URL / T12 A1 / T13 scopes | `84078de` / `24c1f30` / `6aeb283` |
| T14 chunk geometry/coverage | `c4b9fbb` / `5c825d6` |
| T15 scalar/normalization | `015930d` / `3d85dcc`; missing GridData offsets intentionally unsupported pending live evidence |
| T16 visibility | `104dfb5`; conservative explicit metadata; source coordinates preserved |
| T19 retry policy/runner | `f077cd0` / `8aec39f`; no auth or publication authority |
| T21a1 bounded JSON body reader | `4657666`; transport utility only, no production acquisition adapter |

See corresponding `docs/handoffs/Txx.md` for exact APIs and checks. Limits are provisional and uncalibrated.

## Accepted writer leaves

| Scope | Commits |
|---|---|
| T24a static validators + Cell guard | `97a3f01` / `308ff8d` |
| T24b coverage / cells / exclusions / preparation | `df54670` / `f27a4cf` / `3c23453` / `5fd30c5` |
| T24b2 JSON document/report binding | `ccb6b58` |
| T24c exact string byte count / frozen JSON encoding | `32b47ab` / `b9e5a89` |
| T24c context / chunk snapshots | `ada7129` / `f5b2f0a` |
| T24c JSON WriterPort lifecycle/private artifacts | `b53fc2e`; generation/phase fences and aggregate budgets |
| T24b3a common metadata report extraction | `2015c98`; wrapper captures options once; expanded for CSV/XLSX by T27b |
| T25 names / companion metadata names | `a3f356d` / `c61c516` |
| T26 CSV rectangle encoder | `8c1f0d9`; quote-all/BOM/CRLF, formula prefix policy, exact relative rectangle |
| T27a CSV sheet batch | `0dc3c6a`; aggregate bytes and actual per-sheet transform counts |
| T28a XLSX primitive | `adce308`; scalar-only workbook, OOXML text fidelity, safe cancellation/errors; packaged by T29c |
| T27b common CSV/XLSX report binding | `5b58698`; actual encoder counts and controlled CSV warning |
| T27c1 ZIP transport primitive | `6fc59dd`; bounded exact entry bytes, independent ZIP32/native inflate oracle |
| T29c XLSX companion packaging | `51dd456`; bound report, aggregate pair byte cap and actual workbook mapping |
| T24d1 shared writer lifecycle | `ea725ff`; async serializer support, generation/phase fences, unchanged JSON behavior |
| T27c2 CSV artifact assembly | `6d4158e`; complete bound manifest, single CSV/optional metadata or multi-tab ZIP |
| T24d2 CSV/XLSX WriterPort adapters | `bf3038c`; captured format budgets, shared lifecycle and real packagers |
| T36a real MV3 writer harness | `a6f443e`; isolated/main Chrome156 checks PASS; production bridge remains pending |
| T29a/b pure XLSX representability guards | `85b83d2` / `959147a`; conservative precision screen, not desktop proof |

Latest integration checkpoint after T24d2: strict typecheck, **730/730 tests across 44 files** and schema check PASS. Schema hash prefix `7c4143a7d76f9252`. Scaffold production build last passed at 682-test checkpoint. Production writer modules are not wired into the runtime/UI; separate T36a synthetic writer harness now passes real Chrome execution.

## Current work and next boundaries

- **T36b1 accepted**: request-envelope parser, unknown payloads preserved for later domain validation; strict typecheck and 34 focused tests PASS after lead corrections. See `docs/handoffs/T36b1.md`. Dispatcher/client remain pending.
- **T30a accepted**: pure job phase transitions; strict typecheck and six grouped behavior tests PASS independently. Terminal jobs cannot reactivate; completed is reachable only after downloading. Full controller and browser download evidence remain pending. See `docs/handoffs/T30a.md`.
- **T23a accepted**: exact BigInt scope and 2D tile counts without materializing plans; bytes remain unknown and caps uncalibrated. Isolated strict typecheck and nine focused tests PASS after lead getter/array corrections. See `docs/handoffs/T23a.md`; runtime accounting is pending.
- **T36b3 accepted**: closed reply envelope parser; artifact payload remains unknown for subsequent validation. Isolated strict typecheck and 51 tests PASS after strengthening the descriptor oracle. See `docs/handoffs/T36b3.md`.
- **T36b4 accepted**: fresh local JSON/CSV/XLSX WriterPorts with explicit frozen provisional budgets (64MiB aggregate output ceiling). Isolated strict typecheck and six actual writer tests PASS, with stronger complete CSV and typed XLSX oracles. See `docs/handoffs/T36b4.md`; not memory calibration.
- **T36b2 accepted** after correction job `c90456bc-1069-426f-87c1-49ecf8e415e2` and final lead fixes: current identities precede external callbacks, cancel/replacement fences suppress late artifacts, chunk binding and safe errors enforced. Root strict typecheck and 113 focused tests across four worker modules PASS (22 session tests). See `docs/handoffs/T36b2.md`; no transport/publication claim.
- **Active bounded tasks**: T36b5 staged-artifact validation in `.local/worktrees/t36b5` (`bf1b871f-755b-4eb3-a7b5-a0fba41e34ac`); T23b pure budget counter in `.local/worktrees/t23b` (`53434a14-e245-47ee-bd56-1cf49e69c940`). Review only after completion.
- **T36a reviewed PASS for the synthetic harness** after correction job `11c5a68e-a4cd-4976-8bfb-fe35eb2abe69` ended with backend DNS failure. Lead verified actual source, fixed remaining launcher/oracle/cleanup issues and ran strict typecheck plus real Chrome independently on isolated/main checkouts. See [root browser evidence](evidence/root-writer-browser.md) and `docs/handoffs/T36a.md`.
- All three local WriterPorts, complete report binding and CSV/XLSX packaging are available. Single CSV's staged companion is optional and must require an explicit metadata action; default export remains one CSV.
- Next bounded work: production T36 message validation/worker bridge/client, then controller/download integration and UI. Follow existing versioned contracts; fixture harness messages are not production validation.
- Production Google adapters/gates, central limit calibration, lifecycle/privacy audit and release checks remain pending. G1/G7 still require the user's Google/OAuth/live tenant setup; no production acquisition or permission gate is approved from fixture evidence.
- Open only the assigned task card and relevant helper signatures/handoff. Historical correction details are in per-task handoffs and Git history, not a requirement to load every planning file.

## Evidence boundaries

- Source text/types and absolute positions must remain exact; no sparse compaction, truncation or formula evaluation.
- XLSX SheetJS reader normalizes CRLF: exact OOXML semantics require independent XML/ST_Xstring assertions; desktop compatibility remains pending.
- Root `npm audit --omit=dev` after fflate0.8.3: **9 moderate, 0 high/critical**, exit1; browser reachability/remediation review pending. See [writer-dependencies.md](evidence/writer-dependencies.md). The older spike has a separate lockfile.
- See AGENTS.md for authoritative Google restriction shape, safe diagnostics, snapshot/exact-key safeguards and handoff rules.
