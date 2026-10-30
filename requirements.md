# Product Requirements — Google Sheets Data Export Chrome Extension

**Document type:** Product & functional requirements (input for a planning agent)  
**Status:** Draft for technical planning — not an implementation plan  
**Target platform:** Google Chrome desktop, Manifest V3  
**Last updated:** 2026-10-30  
**Language:** English, to make the document directly usable by technical agents

> **Instructions to the planning agent**  
> Treat this document as the description of **what must be achieved and how success will be measured**, not a decision about **how to build it**. You own architecture selection, extraction feasibility assessment, implementation sequencing, libraries, interfaces, and technical design. Do not start coding until those choices and their risks have been explained. Do not silently weaken requirements or represent an unsupported capability as implemented.

---

## 1. Background and problem statement

The intended product is a standalone Chrome extension that helps users turn Google Sheets workbooks they are permitted to export into structured, machine-readable datasets for analytics and LLM workflows.

Relevant characteristics of the environment supplied by the requester:

- A workbook can contain multiple worksheets/tabs (`gid`/sheet IDs), large ranges, sparse data, and hidden rows, columns, or tabs.
- Values shown to humans may differ from raw values or formula expressions.
- Standard HTML cell selectors and clipboard methods are not dependable sources of complete sheet data; the browser UI may use canvas rendering and viewport virtualization.
- In enterprise Google Workspace, file-level or organization-level Information Rights Management (IRM) may explicitly disable download, print, and copy for viewers/commenters.
- Standard export links and UI actions may fail in those restricted contexts.

**Important:** The above are problem-context observations, not verified guarantees about every Sheets version, browser configuration, account, or API behavior. The planning agent must validate material assumptions before committing to a design.

### 1.1 Requested outcome and authorization boundary

The original use case includes view-only Sheets with active download/copy restrictions. This is a **known conflict to resolve during feasibility and authorization review**, not an instruction to circumvent those restrictions.

The product must distinguish:

1. **Authorized export:** The user and the applicable owner/organization policies permit obtaining an exported copy or an approved machine-readable data feed. This is the supported success path.
2. **Access without export permission:** The user can view a workbook, but IRM/DLP or owner/admin restrictions disallow download/copy/export. The extension must report the limitation and direct the user to an authorized route; it must not evade the restriction through private application interfaces, alternate identities, UI reconstruction, or other workarounds.
3. **Permission or capability unknown:** The extension must not claim that export is authorized or possible without sufficient evidence. It should explain the uncertainty and fail safely.

**Planning decision required:** Identify which verified, documented data access methods are usable for the authorized case, what access/account prerequisites they impose, and which original scenarios cannot be satisfied under effective IRM controls.

## 2. Goals and success criteria

| ID | Goal | Priority |
|---|---|---|
| G-01 | User can export a permitted multi-tab workbook in one operation | Must |
| G-02 | Data remains positionally correct, including sparse and distant nonempty cells | Must |
| G-03 | Produce useful `.xlsx`, `.csv`, and structured `.json` outputs | Must |
| G-04 | Make output completeness, data mode, and limitations explicit | Must |
| G-05 | Be operable as a standalone, installable Chrome MV3 extension | Must |
| G-06 | Do not require users to manually copy cells, scroll entire sheets, or reconstruct tabs | Must |
| G-07 | Respect effective Google Workspace/Drive permissions and relevant enterprise policies | Must |
| G-08 | Handle ordinary network faults, large datasets, cancellation, and actionable errors | Must |
| G-09 | Let users choose selected tabs/ranges and understand the scope of the export | Should |
| G-10 | Handle hidden rows/columns/tabs transparently and correctly where supported | Should |
| G-11 | Make exported JSON especially convenient for downstream scripts and LLM tools | Should |

A successful export is **complete within its explicitly selected scope**. A partial export must never be silently presented as complete.

## 3. Target users and common workflows

**Persona A — Analyst:** Has approved access to the workbook and needs all or selected tabs as XLSX/CSV/JSON for analytics.

**Persona B — Engineer / LLM workflow builder:** Needs structured, reproducible data with stable coordinates, metadata, and predictable types.

**Persona C — Enterprise viewer:** Can open a restricted sheet but lacks rights to export. Needs a clear explanation and an approved next step, not an apparent success that bypasses policy.

### 3.1 Primary user journey

1. Install and open the extension while viewing a Sheets workbook, or provide a valid Sheets URL/ID.
2. Identify the workbook and the account/authorization context used for access.
3. Confirm whether a permitted export is possible; surface restrictions before initiating a data job.
4. Display available workbook tabs and basic scope information.
5. Choose tabs, optional ranges, value representation, and file format.
6. See an estimate/warning when scope is exceptionally large or cannot be determined.
7. Explicitly initiate the export and view understandable progress.
8. Receive the generated local file(s) and a clear completion summary, or an actionable error.

There must be **no automatic extraction merely because a user visits a sheet**.

## 4. Scope boundaries

### 4.1 In scope

- Chrome desktop extension using Manifest V3.
- Current-Sheets-tab recognition and manual URL/ID entry.
- Workbook/tab discovery and multi-tab export where authorized.
- User-selected output formats: XLSX, CSV, JSON.
- Selection of displayed/formatted, raw/typed, or formula-text values, when the selected access method supports them.
- Explicit support for sparse positions, empty ranges/tabs, and large datasets.
- Authorization/error handling, progress, cancellation, and honest completion reporting.
- Local file creation/download, without mandatory transfer to a third-party data collection service.
- Test fixtures and documented setup/run instructions.

### 4.2 Not required for the initial release

- Exact visual reproduction of Google Sheets themes, fonts, borders, colors, charts, filters, pivots, macros, drawings, or collaboration UI.
- Recreating Sheets editing, formulas execution, permission administration, or historical version management.
- Scheduled bulk collection, headless scraping, remote synchronization, or unattended collection.
- Mobile Chrome compatibility, cross-browser packaging, or a hosted SaaS product.

### 4.3 Security and policy constraints

The extension must not attempt to defeat explicit export restrictions, acquire another user's credentials, reuse page cookies/tokens without authorization, access undocumented private RPCs as an IRM workaround, or reconstruct protected content through screenshot/scroll/OCR techniques. An owner/admin-provided approved copy, policy change, or authorized data feed is the required path for restricted files.

The agent may compare legitimate technical approaches, including documented Google APIs and browser-side mechanisms, but **policy compliance is an acceptance requirement rather than an architectural preference**.

## 5. Functional requirements

Use the IDs below to trace design choices and tests.

### FR-01 — Source identification (Must)

- Accept a Google Sheets workbook URL or spreadsheet identifier.
- When the current Chrome tab is a supported Sheets URL, offer to prefill its workbook identifier.
- A URL containing `gid` may highlight that tab but must not silently exclude other tabs.
- Reject malformed or unsupported inputs with clear validation errors.
- Do not treat arbitrary pasted URLs as trusted network endpoints.

### FR-02 — Account context and eligibility (Must)

- Make clear which Google account/access context the extension is using; avoid silent account mismatch when multiple accounts are signed in.
- Determine whether the requested export is authorized using an appropriate verifiable permission process selected by the planning agent.
- Distinguish at least: permitted, restricted, login required, administrator approval required, missing/inaccessible source, and permission status uncertain.
- For policy-denied operations, produce **no file and no extractable partial data**.
- Permission errors must not trigger an alternate extraction path intended to evade the denial.
- Any authorization changes detected during a job must be handled safely; do not publish output after a confirmed revocation.

### FR-03 — Workbook and tab discovery (Must)

- Retrieve and display workbook title and available tab names in their original order where permitted.
- Preserve stable sheet identifiers alongside human-readable names when available.
- Let users select one tab, several tabs, or all available tabs.
- Clearly identify whether a tab is hidden when that metadata is available.
- Handle empty tabs and names containing spaces, apostrophes, Unicode, or special characters.
- Do not infer the total tab list from only the currently visible tab or browser viewport.

### FR-04 — Value representation (Must)

The user must be able to request the following **semantic** output modes when the selected authorized source supports them:

| Mode | Required meaning |
|---|---|
| Formatted/display | The human-readable representation of the cell value, including available display formatting |
| Raw/typed | The underlying numeric, boolean, or string value where retrievable, without unnecessary type coercion |
| Formula as text | The formula expression as inert text, not an automatically executing formula in the export |

- State when a mode is unavailable or only partially supported.
- Do not automatically infer headers, convert numeric-looking IDs to numbers, convert leading-zero strings, or deduplicate rows.
- Preserve Unicode, embedded line breaks, tabs, commas, quotes, and meaningful whitespace.
- Document any ambiguities in date/time representation and blank-versus-empty-string semantics.

### FR-05 — Positional and sparse-data correctness (Must)

- Preserve the original row/column placement of values within the selected scope.
- A workbook containing values at both `A1` and `Z90000` must not lose the distant cell or compact coordinates.
- Do not terminate based on a run of blank rows or the size of the currently rendered viewport.
- Handle explicit empty cells, absent cells, and blank rows to the fidelity supported by the chosen authorized source.
- Do not silently truncate rows, columns, cells, or tabs because of output-format limits or resource constraints.
- Preserve and report the actual selected/exported range(s).

### FR-06 — Range selection and size controls (Must)

- Default scope must be unambiguous and displayed to the user.
- Support full authorized worksheet scope when feasible; support user-selected A1-style ranges or an equivalent clear selector.
- Surface estimated size/cost and warn about unusually large jobs.
- If a source range is too large or cannot be fully exported, explain the limit and require an explicit narrower scope, alternate format, or cancellation.
- The extension must never silently change a requested full export into a partial one.

### FR-07 — Hidden content semantics (Should)

- Clarify whether hidden tabs, rows, and columns are included or excluded for each export.
- Prefer a visible-only default when visibility can be determined correctly; allow explicit hidden-content selection only for authorized data.
- If visibility metadata is insufficient to honor the selected setting, state that limitation; do not mislabel an output as visible-only.
- File-level export restrictions still take precedence over any hidden-content setting.

### FR-08 — XLSX output (Must)

- Produce a valid `.xlsx` file with one worksheet per selected tab and the original selected-tab order.
- Preserve cell positions and the semantics of the chosen value mode as far as the format supports.
- Resolve Excel-incompatible or duplicate worksheet names deterministically without losing the source-name mapping.
- Values that are source text must not be promoted into executable formulas unexpectedly.
- Do not exceed XLSX row/column limits silently; offer a clear fallback/error.
- The file must open without repair prompts in a mainstream XLSX reader.

### FR-09 — CSV output (Must)

- For one tab, export a single `.csv`.
- For multiple tabs, produce an unambiguous downloadable package containing one CSV per tab plus mapping metadata; packaging choice belongs to the planning agent.
- Use clearly documented encoding, quoting, delimiter, newline conventions, and filename collision handling.
- Preserve meaningful field values and positional empty columns within the declared export range.
- Mitigate spreadsheet formula-injection risk in CSV-opened-as-spreadsheet workflows; document any deliberately transformed text, and provide an exact-value alternative through JSON when possible.

### FR-10 — JSON output (Must)

- Produce machine-readable UTF-8 JSON with a documented, versioned schema.
- Include source workbook metadata, export timestamp, selected value mode, selected scopes, sheet ordering, stable sheet identifiers when available, and completeness/warning indicators.
- Represent cell coordinates without collapsing sparse rows and columns.
- Preserve raw value types to the extent available from the source and requested mode.
- Do not include credentials, access tokens, session secrets, or unrelated private account metadata.
- Schema details (object structure, coordinate indexing convention, sparse vs. dense representation) are **for the planning agent to propose and document**, subject to these outcomes.

### FR-11 — Progress, cancellation, and failure recovery (Must)

- Show clear states before, during, and after an export.
- Indicate progress by tab/portion completed where reasonably measurable; do not fake precision if total size is unknown.
- Support cancellation without producing a misleading complete output.
- Recover appropriately from transient connectivity errors, API quota/rate limits, and interrupted work.
- Distinguish recoverable errors from permanent permission, missing-file, and unsupported-format errors.
- Never run indefinite retries; give a user-actionable end state.
- If a job fails after partial retrieval, do not silently expose a file described as complete.

### FR-12 — Source consistency (Must)

- Recognize that a workbook may change during a long export.
- Do not promise an atomic snapshot unless the chosen access method actually guarantees it.
- If a change is reliably detectable, surface it; otherwise document the consistency limitation.
- Export metadata should identify the time the export was produced and any detected partial/completeness issues.

### FR-13 — Local usability and privacy (Must)

- The user explicitly initiates each export.
- Generated files should be written locally to a user-visible download destination.
- No mandatory external analytics, telemetry, third-party storage, or transfer of workbook contents.
- Minimize extension permissions and retention of data; identify any unavoidable local temporary storage and define cleanup behavior.
- Authentication details must not be leaked into exported files, logs, or error messages.

## 6. Non-functional requirements

| ID | Quality attribute | Requirement / evidence expected |
|---|---|---|
| NFR-01 | Compatibility | Loads as an unpacked Chrome Manifest V3 extension with no manifest/CSP errors |
| NFR-02 | Fidelity | No silent row/column shifting, dropped tabs, missed distant cells, or automatic value coercion |
| NFR-03 | Scalability | Large and sparse datasets can be processed within documented resource bounds; agent proposes measurable targets and fallback behavior |
| NFR-04 | Reliability | Transient failures are handled with bounded recovery; permanent denials remain denials |
| NFR-05 | Security | Export authorization is respected; no IRM/DLP bypass or unauthorized data collection |
| NFR-06 | Privacy | No compulsory server-side ingestion, no token leakage, and predictable temporary-data cleanup |
| NFR-07 | Transparency | Output format, selected scope, value mode, exclusions, and known limitations are observable |
| NFR-08 | Maintainability | Agent provides a modular, testable architecture and documents dependency/API risks |
| NFR-09 | Accessibility | Core controls have readable labels and keyboard-operable interactions |
| NFR-10 | Reproducibility | A clean checkout can build, load, run tests, and reproduce sample exports with documented steps |

**Performance figures are intentionally not predetermined here.** The planning agent must propose achievable thresholds after exploring API quotas, output libraries, memory constraints, and representative data sizes.

## 7. Acceptance scenarios (black-box)

| ID | Test scenario | Expected observable outcome |
|---|---|---|
| AC-01 | Authorized workbook with three selected tabs → XLSX | Valid XLSX with exactly three matching worksheets in order |
| AC-02 | Authorized workbook with three tabs → CSV | Three distinct CSV datasets with preserved source-tab mapping |
| AC-03 | Authorized workbook with three tabs → JSON | Schema-valid JSON, sheet metadata, stable coordinates, completeness status |
| AC-04 | Sparse cells at `A1`, `D50`, and `Z90000` | Every value retains its original position |
| AC-05 | Empty worksheet and blank rows in the middle | No crash or implicit compaction; semantics documented |
| AC-06 | Workbook containing quoted/Unicode/invalid-for-XLSX tab names | Export succeeds with deterministic safe names and preserved source mapping |
| AC-07 | Text containing commas, quotes, CR/LF, emoji, tabs, leading zeros | Correct round-trip semantics; CSV remains syntactically valid |
| AC-08 | Numeric, Boolean, date-like, formatted, and formula cells | Chosen mode is respected; ambiguities and unsupported semantics disclosed |
| AC-09 | Source text starts with `=`, `+`, `-`, or `@` | No unintended formula execution when output is opened |
| AC-10 | Viewer with IRM download/copy restriction | Clear restricted result; no bypass, no exported artifact |
| AC-11 | Enterprise OAuth/admin approval required | Actionable approval/auth message; no disguised fallback |
| AC-12 | Multiple signed-in Google accounts | Clear active account; no silent cross-account access |
| AC-13 | Rate limit or transient server fault during an authorized export | Controlled recovery or clear failure; no corrupted output |
| AC-14 | Permanent denial or source disappears | Clear terminal error; no deceptive partial export |
| AC-15 | Cancel a long authorized export | Work stops and no complete-looking partial artifact appears |
| AC-16 | Output exceeds XLSX format dimensions | Explicit error or user-approved alternative; never silent truncation |
| AC-17 | Workbook changes during export | Detectable changes surfaced; unavoidable consistency limits documented |
| AC-18 | Hidden tabs/rows/columns | Inclusion semantics match selected settings, or exact limitation shown |
| AC-19 | Source URL has a `gid` | Tab is highlighted without accidentally discarding other tabs |
| AC-20 | No supported acquisition method for a given permission context | Honest unsupported/restricted state, not an invented success path |

For every acceptance scenario, the planning agent must specify the corresponding unit, integration, automated browser, or manual test and identify which require a real Google Workspace test tenant.

## 8. Key assumptions, risks, and unresolved questions

These items **must be investigated during planning** rather than treated as implementation facts:

1. **Authorization:** Which documented interface can prove that the current principal is allowed to export? How do file ownership, shared drives, viewer roles, admin controls, IRM, and DLP interact? What if the permission check is incomplete or inconsistent?
2. **Authorized data access:** Which supported interfaces provide all selected tabs/ranges and their values with the required fidelity? What scopes or enterprise approvals are necessary?
3. **Rendering observations:** Which claims about the Sheets browser UI are true in currently supported Chrome/Sheets versions, and do they matter to the legitimate extraction approach?
4. **Data fidelity:** How will empty cells, sparse offsets, dates, formula text, locale formatting, hidden dimensions, and source changes be represented honestly?
5. **Large workbooks:** What are realistic request quotas, memory bounds, packaging limits, and browser lifecycle risks? Where must users reduce scope?
6. **Format safety:** Which serialization approaches avoid formula execution, preserve types, and produce Excel-compatible results?
7. **Extension permissions:** What is the minimum Chrome and Google permission set to meet the outcomes? What will enterprise admins need to approve?
8. **Long-running UX:** What runtime context handles multi-minute jobs reliably under MV3 lifecycle rules?
9. **Restricted use cases:** Which original viewer/IRM scenarios are technically unsupported by approved APIs, and what owner/admin-enabled alternative workflow should the product display?

No unverified assumption should be converted into a product promise. Any hard conflict must be documented explicitly with evidence and a proposed requirement adjustment for stakeholder review.

## 9. Planning agent responsibilities and expected outputs

The planning agent is responsible for **HOW**. This requirements document deliberately does **not** prescribe React, Vite, Google OAuth mechanics, Google API request sequences, IndexedDB, Web Workers, XLSX libraries, service-worker vs. tab execution, folder layout, or a task-by-task build sequence.

The planning agent must produce:

1. **`feasibility-assessment.md`** — validated assumptions; authorized extraction options; permission/IRM behavior; source/API references; supported/unsupported scenarios; unresolved blockers.
2. **`architecture.md`** — at least two viable authorized design options where alternatives exist, a trade-off comparison, recommended option, data flow, trust boundaries, and reasons for the decision.
3. **`implementation-plan.md`** — staged build plan with dependencies, technical spikes, operational prerequisites, risks, and explicit exit criteria.
4. **`tasks.md`** — small actionable engineering tasks, ordered by dependency, traceable to `FR-*`, `NFR-*`, and `AC-*` IDs.
5. **`test-plan.md`** — unit/integration/E2E/manual strategy; fixtures; representative large-sheet benchmarks; authorization-denial cases.
6. **`decisions-and-open-questions.md`** — decisions, assumptions requiring verification, blockers, and requested stakeholder decisions.

### 9.1 Required decision quality

- Separate **confirmed facts**, **assumptions**, **recommendations**, and **open questions**.
- Compare approaches using correctness, supportability, policy compliance, performance, privacy, extension permission scope, and maintenance burden.
- Explain exactly why a proposed access method is documented/supported and authorized.
- Identify MVP vs. later enhancements; do not quietly remove any Must requirement.
- Give testable evidence for feasibility, especially multi-tab reads, restriction handling, large sparse ranges, and generated XLSX validation.
- Make the authorization boundary explicit and explain how failures are handled.
- If a requirement cannot be met, flag it as a **blocker or proposed scope change**, not as a hidden compromise.

### 9.2 Planning-only stopping point

**Do not implement the extension as part of planning.** The handoff is complete when the six planning artifacts exist, requirements are traced to proposed tasks/tests, major technical risks are surfaced, and the stakeholder can approve or revise the plan.

## 10. Definition of ready for implementation

Planning is ready for approval when:

- The authorized source-data acquisition path has a defensible feasibility result.
- Restricted/view-only/IRM scenarios have an explicit support classification and error behavior.
- Multi-tab, sparse-range, formatted/raw/formula, hidden-content, and large-workbook semantics are defined.
- The architecture decision is justified rather than assumed.
- Format schemas, normalization conventions, and resource limits are planned and testable.
- Every Must requirement has corresponding tasks and acceptance tests.
- Any unmet requirement is documented for stakeholder decision before coding begins.

---

**Priority rule:** Produce correct, permission-compliant, explicitly scoped data exports. Never label a truncated, unauthorized, or unverifiable extraction as a successful complete export.
