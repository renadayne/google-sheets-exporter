# Evidence: T05 — OAuth, Account Identity, and Scope Setup Protocol

**Status:** OFFLINE DRAFT REVIEWED; JSON template checked. Live token exchanges and tenant tests: `NOT RUN` / `PENDING`.

## 1. GCP Project, Consent Screen, and API Enablement
- **Prerequisites:** Google Cloud Platform (GCP) project with Google Sheets API v4 and Google Drive API v3 enabled.
- **Consent Screen:**
  - *Internal:* Available for an organization-owned Workspace project, subject to its admin policies. A development/testing configuration with explicit test users is another possible setup; neither has been configured here.
  - *Public:* Review scope classifications, verification requirements and applicable exceptions before rollout. Do not assume an internal exemption or a particular audit/demonstration requirement applies without checking the actual deployment. [Google verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- **OAuth Client Type:** Application type `Chrome extension` in GCP Credentials. Requires an Extension Item ID matching the local or published extension ID.

## 2. Stable Extension ID and Manifest Public Key
- A fixed public manifest `key` preserves the extension ID across development environments. Ordinary reload is not evidence that the ID changes randomly; always inspect the actual ID in `chrome://extensions` after loading the build.
- [Chrome's documented procedure](https://developer.chrome.com/docs/extensions/reference/manifest/key): obtain the public key from the Developer Dashboard package page, remove the PEM delimiters/newlines, and use its base64 public-key content as manifest `key`. Register the resulting actual extension ID with the OAuth client. The key is public; do not embed a private key or a hash in place of it.
- No dashboard upload, key generation or OAuth registration was performed in this offline task.

## 3. Scopes, Permissions, and API Allowlist
- **Candidate Read-Only Scopes:**
  - `https://www.googleapis.com/auth/spreadsheets.readonly`: Read sheet structures, cell data, and display values.
  - `https://www.googleapis.com/auth/drive.metadata.readonly`: Read file metadata and `capabilities.canDownload` for IRM/DLP export gate without broad drive content access.
  - `https://www.googleapis.com/auth/userinfo.email`: Determine authenticated principal email for UI display and audit binding.
- **MV3 Permissions:** `identity` (OAuth token retrieval), `downloads` (export file dispatch), `activeTab` (URL extraction on user click).
- **Host Permissions:** `https://sheets.googleapis.com/*`, `https://www.googleapis.com/*`. No cookies, tabs-wide, scripting, or webRequest.

## 4. Security Model: Public Client, Same-Token Identity, and Isolation
- **Public Client (No Client Secret):** This extension design uses `chrome.identity.getAuthToken` and a public OAuth client configuration. It must not store or bundle a client secret.
- **No Cookie/Session Reuse:** Ambient web cookies or Google session tokens from the open spreadsheet tab are never accessed or trusted. All API calls use dedicated Bearer tokens obtained via `chrome.identity`.
- **Same-Token Principal Lookup:** Candidate endpoint: `https://www.googleapis.com/oauth2/v3/userinfo`, queried with the exact Bearer token used for Drive/Sheets. Required returned stable ID/email and scope compatibility remain live-test prerequisites; missing identity evidence must not be invented. Token remains in application memory only, apart from Chrome's own identity token cache.
- **Account Context:** Display the verified token principal before export and explain that it may differ from the Sheets page's account. A URL alone cannot reliably reveal the page's signed-in principal; this design does not promise automatic mismatch detection or inspect page cookies.

## 5. Authorization Error Taxonomy
- **Denied Consent:** Recognized user cancellation/consent denial ends the attempt cleanly. Exact Chrome error strings are not yet verified; unknown errors must remain unclassified/uncertain.
- **Expired/Revoked Token:** `removeCachedAuthToken` removes a cached token; it does not revoke it at Google. Handle 401 with the architecture's single bounded token renewal plus fresh permission check. Confirmed access revocation cancels the job and clears application-owned buffers. [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity).
- **Admin Approval Required:** Classify only with explicit admin-policy evidence. A generic 403 is insufficient (it may be a quota or other error); unknown permission errors fail uncertain without alternate extraction.

## 6. Offline Build Specification
- Unconfigured builds (like local developer builds lacking GCP keys) omit OAuth metadata in `manifest.json` or disable sign-in UI with error code `CONFIG_REQUIRED`.
- Placeholder values in `config/extension.example.json` (`clientId: null`, `manifestPublicKey: null`) ensure builds compile offline without inventing bogus credentials.

## 7. Manual Verification Matrix for Reviewer (Live Status: PENDING / NOT RUN)

| Scenario | Steps & Verification | Expected Outcome | Live Status |
|---|---|---|---|
| Single Account Consent | Launch `getAuthToken`, grant consent | Token acquired, principal displayed, no secret used | NOT RUN (Pending GCP) |
| Denied Consent | Launch interactive prompt, click Cancel/Deny | Clear user-cancelled status; zero network retry | NOT RUN (Pending GCP) |
| Multi-Account Profile | Operator uses different known accounts for the tab and Chrome token | Verified token principal displayed clearly; no promise to detect the tab account; no session reuse | NOT RUN (Pending GCP) |
| Mid-Job Token Revocation | Invalidate token via account permissions during export | Final permission check catches 401/revocation; zero download | NOT RUN (Pending GCP) |
| Workspace Admin Block | Run under tenant blocking 3rd-party OAuth apps | Actionable admin approval required error; no raw crash | NOT RUN (Pending Tenant) |
