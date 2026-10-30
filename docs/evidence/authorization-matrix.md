# Evidence: T02 — Candidate Export-Authorization Decision Table and Verification Protocol

**Status:** PARTIAL (Offline candidate decision table, synthetic fixtures, and checker passed; live verification `NOT RUN` / `PENDING`).
**Gate G1 Status:** UNPASSED (Production gate remains blocked awaiting live Google Cloud and enterprise tenant verification).

Reviewer rerun: `node spikes/authorization/check-matrix.mjs` passes 16/16 checks over 24 cases. Review corrected invented API fields, separated admin/login/expiry/revocation states, and required explicit `trashed: false` for candidate success. The checker also returns a failing exit status if any recorded check fails.

## 1. Candidate Policy Principles and Prohibited Assumptions
- **Candidate Policy vs API Facts vs Live Verification:** Google API field schemas reflect official documentation ([S1, S2]); offline evaluation is purely synthetic; live tenant integration remains `NOT RUN`.
- **Official Field Structure ([S2]):** `downloadRestrictions: { effectiveDownloadRestrictionWithContext: { restrictedForReaders: boolean, restrictedForWriters: boolean } }`. There are NO generic `restricted`, `type`, or `reason` fields in this object; any invented fields are strictly rejected.
- **DLP / Shared-Drive Origin:** Policy origins (such as Shared Drive settings or enterprise DLP rules) are modeled as synthetic scenario context outside `driveResponse`, not fabricated server diagnostics.
- **No Inferred Authorization:** User OAuth consent, UI role labels, or successful Sheets data reads do *not* establish export authorization ([S1]).
- **Never Inspect Data to Prove Denial:** Restricted files must never have grid cells or ranges read to infer or confirm restriction boundaries.
- **No Alternate Fallbacks:** Permission denial, missing fields, or account mismatch immediately halts acquisition; no fallback URLs, private RPCs, or alternate accounts.
- **Same-Token Principal & Source Binding:** Verified token principal and requested spreadsheet ID must bind across all metadata and data requests; absent verified principal/source cannot be allowed. Source must be `application/vnd.google-apps.spreadsheet`.

## 2. Decision Predicate Definitions & Taxonomy
- **`allowed` (Basic Candidate Success):** Bound principal === token principal, requested file ID === metadata ID, mimeType is spreadsheet, `trashed === false`, `capabilities.canDownload` strictly `true`, `effectiveDownloadRestrictionWithContext` has explicit booleans `restrictedForReaders: false` and `restrictedForWriters: false`, and `copyRequiresWriterPermission !== true`.
- **`restricted`:** `capabilities.canDownload === false` (safe conservative denial regardless of caller claims).
- **`uncertain`:** Missing/ambiguous fields, omitted/non-boolean restriction flags (omission semantics unverified offline, not false by default), principal/source mismatch, contradictory legacy evidence, unknown 403, or spreadsheet with true readers/writers restriction but `canDownload: true` (conservative candidate does not guess caller roles without role-aware proof).
- **`admin_approval_required`:** Explicit admin OAuth restriction evidence (HTTP 403 `admin_policy_enforced`); classified as admin block requiring approval, not a file policy restriction.
- **`missing_or_inaccessible`:** HTTP 404, trashed workbook (`trashed: true`), or unsupported non-spreadsheet mimeType; classified as missing/inaccessible/unsupported source, not a claimed policy restriction.
- **`retry_candidate`:** HTTP 403 with identified rate-limit reason (`rateLimitExceeded`, `userRateLimitExceeded`); candidate for bounded backoff retry.
- **`auth_renewal_candidate` vs `login_required`:** Generic HTTP 401 alone does not prove revocation (may be token expiry) and allows architecture's single bounded auth renewal (`auth_renewal_candidate`); if renewal was already attempted, requires user sign-in (`login_required`). These are synthetic transport/job diagnostics, not Google error schema.
- **`revoked`:** Confirmed revocation scenario requires an explicit separate synthetic context flag (`isConfirmedRevocation === true`) representing independently confirmed revocation evidence; terminal abort and buffer wipe with zero artifact download.

## 3. Candidate Decision Table & Synthetic Matrix Summary

| Case ID | Scenario / Role | Synthetic Context & Drive Payload Fields | Candidate Status | Live Status | Doc Ref |
|---|---|---|---|---|---|
| `case-01` | Owner | `canDownload: true`, `false/false` restrictions, verified binding | `allowed` | NOT RUN | [S1, S2] |
| `case-02` | Viewer | `canDownload: true`, `false/false` restrictions, verified binding | `allowed` | NOT RUN | [S1, S2] |
| `case-03` | Editor | `canDownload: true`, `false/false` restrictions, verified binding | `allowed` | NOT RUN | [S1, S2] |
| `case-04` | Viewer IRM | `canDownload: false`, `restrictedForReaders: true`, `writers: false` | `restricted` | NOT RUN | [S1, S2] |
| `case-05` | Editor with Readers IRM | `canDownload: true`, `restrictedForReaders: true`; role-aware proof pending | `uncertain` | NOT RUN | [S1, S2, Q06] |
| `case-06` | Writer IRM | `canDownload: false`, `restrictedForReaders: true`, `writers: true` | `restricted` | NOT RUN | [S1, S2] |
| `case-07` | Context-Aware / DLP | Context: `enterprise_dlp`; `canDownload: false`, `true/true` restrictions | `restricted` | NOT RUN | [S1, S2] |
| `case-08` | Shared Drive Policy | Context: `shared_drive`; `canDownload: false`, `true/true` restrictions | `restricted` | NOT RUN | [S1, S2] |
| `case-09` | Missing `canDownload` | Response omits `capabilities.canDownload` | `uncertain` | NOT RUN | [S1, S2] |
| `case-10` | Omitted Restrictions | Response omits `downloadRestrictions` object; omission unverified | `uncertain` | NOT RUN | [S2] |
| `case-11` | Missing Reader Flag | `effectiveDownloadRestrictionWithContext` omits `restrictedForReaders` | `uncertain` | NOT RUN | [S2] |
| `case-12` | Non-Boolean Writer Flag | `restrictedForWriters: null` (non-boolean flag) | `uncertain` | NOT RUN | [S2] |
| `case-13` | Contradictory Legacy IRM | `canDownload: true`, `false/false` flags, but legacy field `true` | `uncertain` | NOT RUN | [S1, S2] |
| `case-14` | Account Mismatch | Active token principal differs from bound job principal | `uncertain` | NOT RUN | [S10] |
| `case-15` | Source ID Mismatch | Returned spreadsheet ID differs from requested ID | `uncertain` | NOT RUN | [S1, S3] |
| `case-16` | Admin OAuth Denial | HTTP 403 `admin_policy_enforced` | `admin_approval_required` | NOT RUN | [S1, S12] |
| `case-17` | Rate-Limit Error | HTTP 403 `rateLimitExceeded`; bounded retry candidate | `retry_candidate` | NOT RUN | [S7] |
| `case-18` | Unknown 403 Error | HTTP 403 reason unspecified; fail closed | `uncertain` | NOT RUN | [S1, S7] |
| `case-19` | Inaccessible Resource | HTTP 404 `notFound`; no alternate lookup | `missing_or_inaccessible` | NOT RUN | [S1] |
| `case-20` | Trashed Workbook | `trashed: true` in spreadsheet metadata | `missing_or_inaccessible` | NOT RUN | [S1] |
| `case-21` | Generic 401 Expiry | HTTP 401 without confirmed revocation (attempts: 0) | `auth_renewal_candidate` | NOT RUN | [S9, S10] |
| `case-22` | Exhausted 401 | HTTP 401 after renewal attempt already exhausted | `login_required` | NOT RUN | [S9, S10] |
| `case-23` | Confirmed Revocation | `isConfirmedRevocation: true`; abort job, clear buffers | `revoked` | NOT RUN | [S9, S10] |
| `case-24` | Non-Spreadsheet Source | MimeType is `application/vnd.google-apps.document` | `missing_or_inaccessible` | NOT RUN | [S1, S3] |

## 4. Official API and Architecture References
- [S1 — Drive download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [S2 — Drive content/download restrictions](https://developers.google.com/workspace/drive/api/guides/content-restrictions)
- [S3 — spreadsheets.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)
- [S7 — Sheets API usage limits & quotas](https://developers.google.com/workspace/sheets/api/limits)
- [S9 — Chrome MV3 lifecycle & termination](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [S10 — Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [S12 — Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## 5. Live Verification Protocol and Tenant Prerequisites (Pending Live Tenant)
- **Prerequisites:** GCP Project with Sheets v4 and Drive v3 enabled; OAuth 2.0 Client with extension public key; Google Workspace tenant with admin controls; accounts configured with Owner, Editor, Viewer, and Outside-Org roles; Shared Drive with download restrictions; Context-Aware Access / DLP rule.
- **Verification Protocol:**
  1. *Allow Matrix:* Test Owner, Editor, Viewer on unrestricted files; confirm `canDownload === true` and `restrictedForReaders: false, restrictedForWriters: false`.
  2. *IRM Restrictions:* Apply "Disable options to download, print, and copy for commenters and viewers"; verify Viewer receives `restricted` (`canDownload === false`), verify zero Sheets data calls.
  3. *Editor IRM Assessment:* Test Editor on file with reader restriction; verify candidate policy marks `uncertain` unless proven role-aware.
  4. *Enterprise Policies:* Apply DLP rule and Shared Drive restrictions; confirm rejection as `restricted` prior to data read.
  5. *Lifecycle & Invalidation:* Revoke token in Google Account permissions during active job; confirm pre-publish gate catches confirmed revocation and halts download.
  6. *Field Omission:* Inspect real Drive v3 responses to verify whether omitting `downloadRestrictions` in standard responses signifies unrestricted or unpopulated data.
