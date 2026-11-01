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
| T28a XLSX primitive | `adce308`; scalar-only workbook, OOXML text fidelity, safe cancellation/errors; packaging pending |
| T27b common CSV/XLSX report binding | `5b58698`; actual encoder counts and controlled CSV warning |
| T27c1 ZIP transport primitive | `6fc59dd`; bounded exact entry bytes, independent ZIP32/native inflate oracle |
| T29c XLSX companion packaging | `51dd456`; bound report, aggregate pair byte cap and actual workbook mapping |
| T24d1 shared writer lifecycle | Reviewed job `b21767eb-6949-4f8b-9470-ef9efa212d43`; async serializer support, generation/phase fences, unchanged JSON behavior |
| T29a/b pure XLSX representability guards | `85b83d2` / `959147a`; conservative precision screen, not desktop proof |

Latest integration checkpoint after T24d1: strict typecheck, **716/716 tests across 42 files** and schema check PASS. Schema hash prefix `7c4143a7d76f9252`. Scaffold production build last passed at 682-test checkpoint. New writer modules are not wired into the runtime/UI, so that build is not browser writer evidence.

## In progress / next boundaries

- **T28a accepted offline** after two correction rounds: source-order scalar assignments, original coordinates, representability preflight, literal OOXML escape protection and exact CR wire text, guarded provider errors, listener cleanup/cancellation. Lead added transient post-registration getter failure regression; isolated/main strict typecheck and 26 targeted tests PASS. Names now sanitize escaped-looking worksheet patterns before collision/truncation while preserving originalTitle. See handoff and dependency evidence. No WriterPort/companion/UI or desktop compatibility claim.
- **T27b accepted offline**: format/name/scopes/source consistency bound for all three formats; CSV requires actual encoder facts, validates count bounds/order/sum and binds optional report counts, emits one controlled safety warning when needed. Lead strengthened real-encoder zero/mutation fixtures and malformed order/ID cases, and added count-loop cancellation polling. Main strict typecheck +44 report/document/writer tests PASS. No packaging/download authority.
- **T27c1 accepted offline**: byte-preserving entries plus manifest last, canonical single-component names, exact aggregate preflight and compressed output caps. Lead fixed valid consecutive-dot filenames and strengthened native ZIP32 reader bounds/local-CD/CRC checks, post-compression abort and malformed provider output tests. Isolated strict typecheck +8 tests and main targeted8 PASS. Report validation and complete CSV artifact assembly remain next; this helper only transports bytes.
- **T29c accepted offline**: private workbook + companion JSON, report binding before serialization, actual mapping comparison and aggregate byte cap. Lead removed duplicate whole-file buffers, tightened config failure/zero remainder handling, improved independent oracle fields and added real pending serialization abort/late rejection. Main strict typecheck +43 related tests PASS (9 package cases). No WriterPort/UI/desktop or download completion claim.
- **T27c2 CSV artifact assembly**, isolated `.local/worktrees/t27c2`: job `95b4471e-3f63-42a5-aca0-1cff2db69db7`. Single CSV stages optional separate metadata for explicit action; multi-tab ZIP includes bound complete manifest. Review only after terminal.
- **T24d1 accepted offline** after independent review despite bridge backend DNS failure: common buffering/coverage/lifecycle extracted, JSON is a small adapter; trusted serializers own format/report checks. Lead added ownership fence after preparation and stale-serializer regression. Strict typecheck +23 targeted tests PASS, including unchanged 14 JSON tests. Full 716-test integration PASS. CSV/XLSX adapters are next, then worker/controller wiring.
- Next after those reviews: CSV ZIP/manifest/single-tab metadata packaging; XLSX companion report; bounded WriterPort lifecycle; worker bridge/controller/download integration. Do not mark parent T27/T29 complete prematurely.
- Production Google adapters/gates, UI composition, lifecycle/privacy audit, benchmarks and release gates remain pending. Offline pure work may continue with reviewed ports; missing prerequisites never authorize a weaker permission gate.

## Evidence boundaries

- Source text/types and absolute positions must remain exact; no sparse compaction, truncation or formula evaluation.
- XLSX SheetJS reader normalizes CRLF: exact OOXML semantics require independent XML/ST_Xstring assertions; desktop compatibility remains pending.
- Root `npm audit --omit=dev` after fflate0.8.3: **9 moderate, 0 high/critical**, exit1; browser reachability/remediation review pending. See [writer-dependencies.md](evidence/writer-dependencies.md). The older spike has a separate lockfile.
- See AGENTS.md for authoritative Google restriction shape, safe diagnostics, snapshot/exact-key safeguards and handoff rules.
