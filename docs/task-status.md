# Current implementation status

Updated: 2026-11-03 (Asia/Saigon). Detailed chronology: [execution-history.md](execution-history.md). Read this current state and the assigned task card; open only relevant handoffs/contracts.

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

Latest integration checkpoint: strict typecheck, **1107/1107 tests across 62 files** and schema check PASS. Schema hash prefix `7c4143a7d76f9252`. Scaffold production build last passed at the 1001-test checkpoint. Actual writer-client and raw production-protocol Chrome harnesses PASS, including native client cancellation/crash checks; product controller/UI wiring remains pending. The legacy synthetic writer harness also passes.

## Accepted runtime prerequisites

| Leaf | Accepted evidence / boundary |
|---|---|
| T36b1 request envelope | 34 focused tests; payloads remain unknown. See `docs/handoffs/T36b1.md`. |
| T36b3 reply envelope | 51 focused tests; artifact validation is separate. See `docs/handoffs/T36b3.md`. |
| T36b4 local writer factory | Six actual-writer tests; fresh ports and provisional 64MiB output cap. See `docs/handoffs/T36b4.md`. |
| T36b2 session dispatcher | 22 focused tests after callback/reentry corrections; current generation fences and private artifacts. See `docs/handoffs/T36b2.md`. |
| T36b5 staged artifacts | 36 focused tests; frozen metadata, genuine binary identity and fixed full-buffer profile. See `docs/handoffs/T36b5.md`. |
| T36c1 host | Six actual writer/structuredClone tests; transfer lists and sender detachment. See `docs/handoffs/T36c1.md`. |
| T36c2 dedicated entry | Six entry tests plus seven legacy PING tests; measured worker-only installation and cleanup. See `docs/handoffs/T36c2.md`. |
| T36c3a/b browser evidence | Fixture extraction preserved data/execution. Actual production protocol passes Chrome156 independent JSON/CSV/OOXML oracles; 20 commands, 16ACK, 4PROGRESS, 3STAGED, 1ERROR, 0unexpected. Both Chrome modes pass; no direct production sender-detachment telemetry. See `docs/handoffs/T36c3b.md` and [browser evidence](evidence/root-writer-browser.md). |
| T36d1/2a/2b one-job client | 33 focused tests after review corrections; safe snapshots, permanent terminal latch and per-op cleanup. Actual Chrome client JSON/CSV/XLSX oracles PASS. Native pending begin/append/finalize cancellations and intentional crash PASS: exact command traces, static errors, four separate lifecycle worker terminations, zero accepted artifacts after abort. See `docs/handoffs/T36d1.md`, `T36d2a.md`, `T36d2b.md`. |
| T30a phase graph | Six grouped tests; terminal jobs cannot reactivate, completed only after downloading. Full controller/browser completion proof still pending. See `docs/handoffs/T30a.md`. |
| T30b page job owner | Eight focused tests after cleanup adoption correction; generation fences, supersession and idempotent best-effort cleanup. Full controller remains pending. See `docs/handoffs/T30b.md`. |
| T30c request snapshot | 23 focused tests; immutable page-only request, preserved source order/absolute scopes, principal deliberately kept out of worker projection. See `docs/handoffs/T30c.md`. |
| T30d writer context projection | 35 focused tests after lead oracle corrections; exact selected metadata/request binding, source order, no principal/observation/unselected data, bounded descriptor snapshots. See `docs/handoffs/T30d.md`. |
| T23a scope estimate | Nine focused tests; exact BigInt positions/2D tile counts without materialized plans, unknown bytes. See `docs/handoffs/T23a.md`. |
| T23b cumulative budget | Seven focused tests; atomic counters and permanent failure latch. Controller/stream accounting and calibration pending. See `docs/handoffs/T23b.md`. |
| T24b3b report snapshot | Original source-binding getter regression red then green; 29 snapshot tests plus regression. Captured metadata precedes all format binding. Non-enumerable data-only extras are omitted for existing projection compatibility; accessors rejected. See `docs/handoffs/T24b3b.md`. |
| T31a artifact action selection | 25 focused tests; default single CSV primary only, explicit metadata companion only, multi-CSV ZIP, XLSX pair. Selection grants no publication authority. See `docs/handoffs/T31a.md`. |
| T31b1 completion observer | 40 focused tests after descriptor/query-adoption corrections; observes only owned ID/state, first terminal wins, timeout/missing evidence remains unverified. Native download/publisher evidence pending. See `docs/handoffs/T31b1.md`. |

## Current work and next boundaries

- **Accepted checkpoint**: root strict typecheck, **1107/1107 tests across 62 files**, schema check and all three actual Chrome harness modes PASS. No product download or live acquisition is exercised.
- **Latest accepted leaves**: T30d sanitized WriterContext projection and T36d2b native cancellation/crash checks. Both Antigravity jobs are terminal and independently reviewed; no active delegated job remains.
- T36d1 implementation and correction jobs ended with backend DNS errors after saving completed files; lead reviewed actual code, corrected remaining constructor/signal/context ownership issues and independently verified the checkpoint above. No model fallback or new user approval was used.
- Next bounded work: controller/download integration and UI. The product UI still uses the unconfigured T07 PING scaffold. Fixture protocols are not production acquisition gates.
- Clarified account setup with the user: eventual end users sign in and grant access; Cloud API/OAuth client registration is one-time application configuration by the developer, not a project each user must create. No Cloud resource/account change has been authorized or performed.
- Google adapters/permission gates, limit calibration, lifecycle/privacy audit and release checks remain pending. G1/G7 still require the user's Google/OAuth/live tenant setup; fixtures do not approve live permission or release claims.
- Open only the assigned task card and relevant helper signatures/handoff. Detailed corrections remain in handoffs and Git history, not mandatory context for every small task.

## Evidence boundaries

- Source text/types and absolute positions must remain exact; no sparse compaction, truncation or formula evaluation.
- XLSX SheetJS reader normalizes CRLF: exact OOXML semantics require independent XML/ST_Xstring assertions; desktop compatibility remains pending.
- Root `npm audit --omit=dev` after fflate0.8.3: **9 moderate, 0 high/critical**, exit1; browser reachability/remediation review pending. See [writer-dependencies.md](evidence/writer-dependencies.md). The older spike has a separate lockfile.
- See AGENTS.md for authoritative Google restriction shape, safe diagnostics, snapshot/exact-key safeguards and handoff rules.
