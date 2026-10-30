# T01 — Planning Review and Prerequisites Record

- **Task ID:** T01
- **Date:** 2026-10-31
- **Stage Gate:** G0 (Review Planning)
- **Overall T01 Status:** **PASS** (Planning baseline recorded; routine architectural proposals accepted to start implementation; missing external OAuth/Workspace tenant prerequisites explicitly tracked as **PENDING** / **BLOCKED** for live verification gates)
- **Traceability:** `FR-02`, `NFR-05`, `NFR-08`, `NFR-10`, `AC-10`, `AC-11`, `AC-20`

---

## 1. Planning Artifacts & Definition of Ready Check (`requirements.md` §9–10)

All six required planning documents from `requirements.md` §9 exist in the workspace and have been cross-checked:

| Artifact | Workspace Path | Inspection Status | Notes |
|---|---|---|---|
| Product Requirements | `requirements.md` | **PASS** | Defines `G-01..G-11`, `FR-01..FR-13`, `NFR-01..NFR-10`, `AC-01..AC-20`, and §9–10 readiness criteria. |
| Feasibility Assessment | `feasibility-assessment.md` | **PASS** | Evaluates official APIs vs. restricted contexts and identifies spikes `S01..S05`. |
| Architecture | `architecture.md` | **PASS** | Defines MV3 extension tab + dedicated Web Worker + official OAuth/Drive/Sheets API design. |
| Implementation Plan | `implementation-plan.md` | **PASS** | Defines release scope, gates `G0..G7`, operational prerequisites, and critical-path dependencies. |
| Task Backlog | `tasks.md` | **PASS** | Defines `T01..T44` with explicit dependencies, allowed files, pass criteria, and requirement traces. |
| Test Plan | `test-plan.md` | **PASS** | Defines unit, integration, E2E, benchmark, reader-compatibility, and live tenant protocols. |
| Decisions & Open Questions | `decisions-and-open-questions.md` | **PASS** | Lists proposed decisions `D01..D14`, blockers `B01..B05`, and stakeholder questions `Q01..Q06`. |
| Agent Instructions | `AGENTS.md` | **N/A (Absent)** | Checked `D:\Pet\Tool\google-sheets-exporter\AGENTS.md`; file does not exist in workspace. |

---

## 2. Authorization & Permission Boundary Review (`FR-02`, `NFR-05`, `AC-10`, `AC-11`, `AC-20`)

Per `requirements.md` §1.1, §4.3, `FR-02`, `NFR-05`, and `decisions-and-open-questions.md` (`D02`), the following security and policy boundaries are fixed as non-negotiable constraints for all subsequent tasks:

1. **Authorized Export Path Only:** Export succeeds only when the authenticated Google principal is verified as permitted to export via documented Google APIs (`Drive API` metadata/capabilities check + `Sheets API` `GridData` read using the same OAuth access token).
2. **Restricted / IRM / Copy-Disabled Contexts (`AC-10`):** When a user has view/comment access to a workbook whose owner or Workspace policy disables download/print/copy, export is **unsupported by policy and design**. The extension must return a clear `restricted` status, produce **zero files** and **zero partial data**, and must **never** fall back to DOM/canvas scraping, viewport scrolling, clipboard capture, screenshot/OCR, page cookies, or undocumented internal RPCs.
3. **Enterprise OAuth / Admin Approval Required (`AC-11`):** When Google OAuth consent or Workspace admin policy blocks token issuance or scope access, the extension must surface a distinct, actionable `admin_approval_required` or `login_required` status without silent fallback.
4. **Uncertain or Unverifiable Permission Context (`AC-20`):** If required capability fields are omitted, ambiguous, or inconsistent, the gate must **fail closed** (`permission_uncertain` / `unsupported_capability`). Successful `Sheets API` cell reads alone do not prove download/export permission.
5. **Mid-Job Revocation & Account Isolation (`FR-02`, `AC-12`, `AC-14`):** Permission must be bound to the active token principal and re-verified before final artifact publication (`T31`). Any revocation, account switch, or cancellation invalidates the in-flight job generation and discards buffered data without triggering a browser download.

---

## 3. Architecture & Product Decisions Record (`D01`–`D14`)

Routine proposed architecture and product baseline choices are **ACCEPTED** as the working implementation baseline per stakeholder authorization to begin step-by-step implementation. Items requiring empirical spike confirmation (`G1`) remain subject to spike pass criteria before live claims are made.

| ID | Decision Summary | Review Status | Gate / Verification Dependency |
|---|---|---|---|
| **D01** | Official OAuth + Drive eligibility gate + Sheets API `GridData` acquisition | **ACCEPTED (Baseline)** | Live API behavior subject to `G1` (`T02`, `T03`, `T05`) |
| **D02** | Denied or uncertain permission produces zero data read/download and no fallback | **ACCEPTED (Mandatory Constraint)** | Enforced in `T02`, `T18`, `T22`, `T31`, `T40` |
| **D03** | Extension tab UI + dedicated Web Worker for heavy serialization; MV3 Service Worker bootstrap only | **ACCEPTED** | Validated in `T07`, `T30`, `T36`, `T37`, `T38` |
| **D04** | TypeScript strict mode + vanilla DOM UI + Vite build | **ACCEPTED** | Configured in `T07` |
| **D05** | Default scope is full allocated worksheet grid (`gridProperties.rowCount` × `columnCount`), 1 rectangle per selected tab | **ACCEPTED** | Implemented in `T12`, `T13`, `T34` |
| **D06** | Default visibility is API-visible (`hiddenByUser` / `hiddenByFilter`) when metadata is complete; preserve coordinate gaps; never claim personal filter-view parity | **ACCEPTED (Baseline)** | Metadata fidelity verified in `T03`, implemented in `T16` |
| **D07** | Sparse JSON v1 schema with absolute zero-based coordinates and half-open `[start, end)` scopes | **ACCEPTED** | Frozen in `T08`, `T09`, `T24` |
| **D08** | Raw dates emitted as numeric serial + metadata; `formula` mode emitted as inert text strings | **ACCEPTED** | Verified in `T03`, `T15`, `T28` |
| **D09** | Bundled local `ExcelJS` + `fflate` inside extension worker with bounded memory guard | **ACCEPTED (Candidate Baseline)** | Subject to MV3 worker/memory spike in `T04` & `T06` |
| **D10** | Single-tab CSV downloads `.csv`; multi-tab CSV downloads `.zip` with `manifest.json`; XLSX downloads `.xlsx` plus companion metadata `.json` | **ACCEPTED** | Implemented in `T27`, `T28`, `T29`, `T31` |
| **D11** | No persistent exported datasets or tokens in `localStorage`/`IndexedDB`/`chrome.storage`; closing tab aborts in-flight job and requires explicit restart | **ACCEPTED** | Enforced in `T17`, `T30`, `T36`, `T38` |
| **D12** | Detectable source workbook modification during multi-request acquisition aborts publication (no mixed-version artifact); always disclose non-atomic read limitation | **ACCEPTED** | Implemented in `T32`, verified in `T40` |
| **D13** | Initial OAuth uses read-only `spreadsheets.readonly` + `drive.metadata.readonly` scopes for manual URL/ID workflow | **ACCEPTED (Internal Baseline)** | Subject to `T05` OAuth spike & `B03` distribution review |
| **D14** | Mitigate CSV spreadsheet formula injection by prefixing dangerous leading characters (`=`, `+`, `-`, `@`, tab/CR/LF variants) on text cells, reporting transformation counts, and directing exact-value users to JSON | **ACCEPTED** | Implemented in `T26`, verified in `T42` |

---

## 4. Blockers and Open Questions Status (`B01`–`B05`, `Q01`–`Q06`)

No unverified external approval or tenant experiment is marked as completed. Each blocker (`B*`) and question (`Q*`) has an assigned owner, truthful current status, working baseline, and gating task:

| ID | Description | Owner | Current Status | Working Baseline / Action Required | Gating Task / Stage |
|---|---|---|---|---|---|
| **B01** | Is Drive API effective permission evidence sufficient across IRM, DLP, and Shared Drive contexts? | Security Reviewer + Workspace Admin | **PENDING (Unverified in live tenant)** | Fail closed (`permission_uncertain`) whenever capability evidence is missing or ambiguous; never infer permission from successful Sheets read alone. Requires live matrix probe in `T02`. | `T02` (`G1`), `T18` (`G4`) |
| **B02** | Are Workspace test tenant, DLP/IRM policies, and owner/editor/viewer test accounts available to prove denied and allowed cases? | Maintainer + Workspace Admin | **BLOCKED (External prerequisite missing)** | No Google Cloud credentials or Workspace tenant are configured in this environment yet. Offline unit/integration tests use synthetic fixtures; live enterprise release remains **BLOCKED** at `G1`/`G7` until tenant evidence is captured. | `T02` (`G1`), `T40` (`G7`) |
| **B03** | Target distribution: internal unpacked/enterprise pilot vs. public Chrome Web Store with broad read-only scopes? | Product Owner | **PENDING (External policy decision; baseline accepted for dev)** | Proceed with internal unpacked extension pilot baseline (`D13`). Public Chrome Web Store release is **not** promised without OAuth verification or an ADR switching to Google Picker (`drive.file`). | `T05` (`G1`), `T44` (`G7`) |
| **B04** | OAuth principal/account display and stable extension ID (`key` in manifest) configuration | Maintainer | **PENDING (Awaiting GCP OAuth client setup)** | Use `chrome.identity` token flow + same-token principal lookup; never reuse page cookies. Stable extension key and redacted config template to be established in `T05`/`T07`. | `T05` (`G1`), `T07` (`G2`), `T17` (`G4`) |
| **B05** | Do `ExcelJS` and `fflate` pass MV3 worker bundling, memory limits, formula-inertness, and cancellation cleanup? | Tech Lead / Reviewer | **PENDING (Awaiting local spike)** | Evaluate in isolated spike `T04` and calibrate budgets in `T06` before freezing production writer tasks (`T27`–`T29`). | `T04`, `T06` (`G1`) |
| **Q01** | Accept API-visible semantics (`hiddenByUser`/`hiddenByFilter`) instead of active personal filter view? | Product Owner | **ACCEPTED BASELINE (Verify in T03)** | Label option explicitly as API-visible content and disclose that temporary personal filter views are not reflected (`FR-07`, `AC-18`). | `T03` (`G1`), `T16` (`G3`), `T34` (`G6`) |
| **Q02** | Accept XLSX download paired with companion metadata JSON download (instead of injecting a metadata worksheet)? | Product Owner | **ACCEPTED BASELINE** | Keep `.xlsx` worksheet count strictly equal to selected source tabs (`FR-08`, `AC-01`); emit companion `.json` report and surface actionable warning if secondary download is blocked. | `T28`, `T29` (`G5`), `T31` (`G6`) |
| **Q03** | Accept one rectangular range per selected tab and requiring the extension tab to stay open during export? | Product Owner | **ACCEPTED BASELINE** | Meets v1 Must requirements (`FR-06`, `FR-11`); disjoint multi-range per tab and post-restart resume remain post-v1 (`implementation-plan.md` §1). | `T13` (`G3`), `T30`, `T38` (`G6`) |
| **Q04** | Accept full allocated-grid default scope with pre-export size warning and explicit A1 range narrowing? | Product Owner | **ACCEPTED BASELINE (Calibrate in T06)** | Never silently shrink to a guessed "used range" (`FR-05`, `AC-04`); display cell/chunk estimate and require explicit user narrowing if over cap (`FR-06`, `AC-16`). | `T06` (`G1`), `T13` (`G3`), `T23` (`G4`) |
| **Q05** | Reject XLSX exports on unsafe numeric precision (>15 significant digits), strings >32,767 chars, or invalid XML characters and guide user to JSON? | Product Owner | **ACCEPTED BASELINE** | Fail closed before producing a silently truncated or coerced `.xlsx` (`FR-05`, `FR-08`, `AC-16`). | `T04` (`G1`), `T29` (`G5`) |
| **Q06** | Must v1 support exporting by an Editor when reader download restrictions apply, if Drive capability fields are ambiguous? | Product Owner + Security Reviewer | **PENDING (Depends on T02 empirical evidence)** | Conservative gate (`D02`) fails closed until `T02` proves a reliable principal-aware download permission decision. Sharing capability is not evidence of export permission. | `T02` (`G1`), `T18` (`G4`) |

---

## 5. Stage Gates and Gate Ownership (`implementation-plan.md` §2)

| Gate | Tasks | Gate Owner | Current Status | Exit Criteria Summary |
|---|---|---|---|---|
| **G0: Review Planning** | `T01` | Tech Lead / Reviewer | **PASS** | Scope, authorization boundaries, decisions `D01..D14`, blockers `B01..B05`, questions `Q01..Q06`, and actual environment prerequisites recorded honestly. |
| **G1: Evidence & Feasibility** | `T02`–`T06` | Tech Lead + Security Reviewer + Admin | **PENDING / PARTIALLY BLOCKED** | `T03`/`T04`/`T06` local synthetic & writer/benchmark spikes can run locally; `T02`/`T05` live API/OAuth/tenant matrices are **BLOCKED** until GCP OAuth client & Workspace test accounts/tenant are supplied. |
| **G2: Foundation & Contracts** | `T07`–`T10` | Tech Lead / Reviewer | **PENDING** | MV3 build/test harness (`T07`), frozen TypeScript contracts (`T08`), JSON schemas (`T09`), and deterministic fake ports/oracles (`T10`). Can proceed for offline/pure tasks upon Tech Lead go-ahead. |
| **G3: Pure Correctness** | `T11`–`T16` | Tech Lead / Reviewer | **PENDING** | Pure URL/ID validation, A1 parser, immutable scope plan, 2D chunk coverage ledger, `GridData` normalizer, and API visibility filter pass unit tests. |
| **G4: Authorized Acquisition** | `T17`–`T23` | Tech Lead + Security Reviewer | **PENDING** | Same-principal identity, Drive eligibility gate (`T18` requires reviewed `T02` predicate), bounded retry, metadata/grid adapters, chunk acquisition, and budget guards. |
| **G5: Serializers** | `T24`–`T29` | Tech Lead / Reviewer | **PENDING** | JSON, deterministic names, safe CSV encoder, CSV ZIP + manifest, XLSX scalar writer, and XLSX representability guards pass round-trip & safety checks. |
| **G6: Orchestration & UI** | `T30`–`T38` | Tech Lead / Reviewer | **PENDING** | Job controller state machine, final permission barrier before download, consistency observer, accessible UI views, worker bridge, and lifecycle/privacy audit. |
| **G7: Verification & Release** | `T39`–`T44` | Tech Lead + Product Owner + Admin + QA | **PENDING / BLOCKED on Tenant** | Full offline suite (`T39`), real Workspace tenant acceptance (`T40`), production benchmarks (`T41`), desktop reader audit (`T42`), reproducible setup docs (`T43`), and final release sign-off (`T44`). |

---

## 6. Operational & Local Environment Prerequisites (`implementation-plan.md` §3)

### 6.1 Directly Inspected Local Environment & Tooling

The following prerequisites were directly inspected on the workstation (`Windows`) in read-only mode during `T01`:

Git observations below are a historical snapshot from the start of T01. During the delegated task the tech lead independently created and pushed planning commit `a713dea` to `origin/main`; the current repository is no longer unborn. Absence of local OAuth configuration does not establish that the user lacks Google accounts or a tenant: their availability/access is unverified until supplied or connected.

| Prerequisite | Inspected Value / Path | Status | Impact / Notes |
|---|---|---|---|
| **Node.js Runtime** | `v24.14.0` (on PowerShell `PATH`) | **PASS** | Available for spikes (`T03`, `T04`, `T06`) and build/test harness (`T07`). Version to be pinned in `T07`/`T43`. |
| **npm CLI** | `11.9.0` (on PowerShell `PATH`) | **PASS** | Available for dependency installation in `T04`/`T07`. |
| **Google Chrome Desktop** | `C:\Users\huytu\AppData\Local\Google\Chrome\Application\chrome.exe` (`156.0.8078.48`) | **PASS** | Available for unpacked MV3 extension loading (`T07`) and E2E/lifecycle tests (`T38`, `T39`). |
| **Desktop Spreadsheet Reader** | Microsoft Excel: `C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE` (`16.0.20527.20112`) | **PASS** | Available for desktop reader compatibility and formula-injection verification (`T04`, `T42`). LibreOffice (`soffice.exe`) is not installed at standard paths. |
| **Git Executable** | `D:\Software\Git\Git\cmd\git.exe` (also `D:\Software\Git\Git\bin\git.exe`), `git version 2.53.0.windows.2` | **PASS (Via Absolute Path)** | Not on default PowerShell `PATH`, but fully functional when invoked via absolute path `D:\Software\Git\Git\cmd\git.exe`. |
| **Git Repository State** | Branch `main` (unborn HEAD — no commits yet); remote `origin` = `https://github.com/renadayne/google-sheets-exporter.git`; untracked files: `architecture.md`, `decisions-and-open-questions.md`, `feasibility-assessment.md`, `implementation-plan.md`, `requirements.md`, `tasks.md`, `test-plan.md` | **PASS (Inspected Read-Only)** | Repository is initialized and clean of modified tracked files; ready for Tech Lead commit workflow. |
| **Node Project Manifest / Lockfile** | No `package.json` or `package-lock.json` in workspace yet | **PENDING (`T04`/`T07`)** | Expected at planning stage; created in `T07` (and isolated spike harness in `T04`). |

### 6.2 Missing or Unverified External Prerequisites

The following prerequisites from `implementation-plan.md` §3 cannot be fabricated locally and remain **PENDING** or **BLOCKED**:

| Prerequisite | Owner | Current Status | Affected Tasks |
|---|---|---|---|
| **Google Cloud Project + Sheets/Drive APIs enabled + Chrome Extension OAuth Client ID bound to stable Extension ID** | Maintainer | **MISSING / BLOCKED** | `T05`, `T17`, `T40` (Live OAuth & API execution) |
| **Test Google Accounts (Owner, Editor, Viewer, Secondary Account for multi-account testing)** | Maintainer | **MISSING / BLOCKED** | `T02`, `T05`, `T40` |
| **Google Workspace Test Tenant with IRM (`canDownload: false`), Shared Drive, and Admin/DLP Controls** | Workspace Admin + Security Reviewer | **MISSING / BLOCKED** | `T02` (live tenant rows), `T40` (mandatory enterprise acceptance) |
| **Calibrated Memory/Time/Cell Resource Caps on Target Hardware** | Maintainer + Tech Lead | **PENDING** | `T06` (initial calibration), `T23` (runtime guard), `T41` (production verification) |

---

## 7. Actionable Next Tasks and Execution Order

With `T01` (`G0`) recorded, `tasks.md` defines `T02`–`T06` as the next stage (`G1 — Evidence & Feasibility`), followed by `T07` (`G2 — Foundation & Contracts`):

1. **Immediately Actionable Local Spikes (No Live Tenant/OAuth Credentials Required):**
   - **`T04` — Validate browser writer and dependency choice (`docs/evidence/browser-writers.md`):** Can run locally right away using Node/Chrome to test `ExcelJS` and `fflate` in an MV3 worker environment against synthetic 3-tab, sparse `Z90000`, Unicode/invalid sheet name, and formula-injection fixtures.
   - **`T03` — Verify `GridData` fidelity and visibility (`docs/evidence/grid-fidelity.md`, `tests/fixtures/grid/*.json`):** Synthetic fixtures and official `GridData` schema/offset/visibility verification can be built immediately; any live Sheets API verification rows must be marked **PENDING/BLOCKED** until credentials are provided.
   - **`T06` — Calibrate initial resource budgets (`docs/evidence/initial-benchmarks.md`):** Actionable immediately after `T03` and `T04` complete using synthetic dense/sparse/long-string workloads on this machine.
2. **Spikes Requiring External Credentials / Workspace Tenant (Blocked for Live Runs Until Provided):**
   - **`T02` — Prove authorization truth table (`docs/evidence/authorization-matrix.md`):** Official Google Drive/Sheets documentation analysis and synthetic response fixture design can be prepared, but live role/IRM/DLP/shared-drive verification rows are **BLOCKED** until Maintainer/Admin provides test accounts and Workspace tenant access (`B01`, `B02`).
   - **`T05` — Verify OAuth, account identity and scopes (`docs/evidence/oauth-setup.md`):** Redacted configuration template and setup protocol can be documented, but live `chrome.identity` token and multi-account verification rows are **BLOCKED** until Maintainer provides a Google Cloud OAuth Client ID (`B04`).
3. **Foundation & Pure Domain Progression (`implementation-plan.md` §2):**
   - Per `implementation-plan.md` §2, if the Tech Lead authorizes proceeding with offline foundation/contract tasks while live credentials for `T02`/`T05` are pending, **`T07` (Minimal MV3 build and test harness)** and **`T08`–`T16` (Contracts, schemas, fake ports, and pure domain logic)** can proceed after `T04` pins dependency versions, provided no live acquisition path is claimed ready before `G1` closes.
