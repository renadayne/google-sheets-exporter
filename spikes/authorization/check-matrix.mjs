import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

/**
 * ============================================================================
 * OFFLINE SPIKE: T02 Authorization Decision Table and Fixture Checker
 *
 * NOTE: This is a SYNTHETIC CANDIDATE EVALUATOR and offline invariant checker.
 * It is NOT a production authorization gate (which belongs to T18 / src/source)
 * and NOT an independent proof of Google API permissions.
 * ============================================================================
 */

const FIXTURES_PATH = path.resolve('tests/fixtures/authorization/matrix.json');

console.log('=== T02 Candidate Authorization Decision Table & Fixture Checker ===\n');

// 1. Load Fixtures
assert.ok(fs.existsSync(FIXTURES_PATH), `Fixture file must exist at ${FIXTURES_PATH}`);
const rawData = fs.readFileSync(FIXTURES_PATH, 'utf8');
const fixtureData = JSON.parse(rawData);

const results = [];
function recordCheck(name, pass, details = {}) {
  results.push({ name, pass, details });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}`);
  if (!pass) {
    console.error('Details:', details);
  }
}

// ---------------------------------------------------------------------------
// 2. Global Fixture Metadata & Invariants
// ---------------------------------------------------------------------------
assert.equal(fixtureData.schemaVersion, '1.1.0', 'Schema version must be 1.1.0');
assert.equal(fixtureData.task, 'T02', 'Task must be T02');
assert.equal(fixtureData.status, 'OFFLINE_SYNTHETIC', 'Status must be OFFLINE_SYNTHETIC');
assert.equal(fixtureData.liveVerified, false, 'Global liveVerified must be strictly false');

recordCheck('Global metadata valid and liveVerified strictly false', true, {
  task: fixtureData.task,
  status: fixtureData.status,
  liveVerified: fixtureData.liveVerified,
});

// Invariant: No real email addresses or credential secrets in fixtures
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const credentialTokensRegex = /bearer|client_secret|access_token|refresh_token/i;

let credentialLeakDetected = false;
fixtureData.cases.forEach(c => {
  if (emailRegex.test(c.boundPrincipalId) || emailRegex.test(c.tokenPrincipalId)) {
    credentialLeakDetected = true;
  }
  const serialized = JSON.stringify(c);
  if (credentialTokensRegex.test(serialized)) {
    credentialLeakDetected = true;
  }
});
assert.equal(credentialLeakDetected, false, 'Fixtures must not contain email addresses or credentials');
recordCheck('Sanitized pseudonyms verified; zero emails or credentials leaked', true);

// ---------------------------------------------------------------------------
// 3. Strict Schema Validation for effectiveDownloadRestrictionWithContext
// ---------------------------------------------------------------------------
const ALLOWED_RESTRICTION_KEYS = new Set(['restrictedForReaders', 'restrictedForWriters']);

function validateRestrictionContextKeys(effectiveContext, caseId) {
  if (!effectiveContext || typeof effectiveContext !== 'object') return;
  for (const key of Object.keys(effectiveContext)) {
    if (!ALLOWED_RESTRICTION_KEYS.has(key)) {
      throw new Error(
        `Disallowed invented key '${key}' in effectiveDownloadRestrictionWithContext for ${caseId}. ` +
        `Only official fields ${Array.from(ALLOWED_RESTRICTION_KEYS).join(', ')} are permitted.`
      );
    }
  }
}

fixtureData.cases.forEach(c => {
  const ctx = c.driveResponse?.downloadRestrictions?.effectiveDownloadRestrictionWithContext;
  validateRestrictionContextKeys(ctx, c.caseId);
});
recordCheck('Strict schema: zero invented keys in effectiveDownloadRestrictionWithContext across all fixtures', true);

// Completeness check across mandatory policy categories
const expectedCategories = new Set([
  'allowed_candidates',
  'reader_writer_irm',
  'dlp_shared_drive',
  'missing_fields',
  'contradictory_legacy',
  'principal_source_binding',
  'admin_oauth_denial',
  'error_taxonomy',
  'revocation_lifecycle',
]);

const observedCategories = new Set(fixtureData.cases.map(c => c.category));
for (const cat of expectedCategories) {
  assert.ok(observedCategories.has(cat), `Category '${cat}' must be represented in fixture matrix`);
}
recordCheck(`All ${expectedCategories.size} mandatory policy categories represented`, true);

// Invariant: Each case has handwritten reason, documented source reference, and liveVerified === false
const casesValid = fixtureData.cases.every(c => {
  return (
    typeof c.caseId === 'string' &&
    typeof c.description === 'string' &&
    typeof c.expectedReason === 'string' &&
    c.expectedReason.trim().length > 10 &&
    typeof c.sourceDocRef === 'string' &&
    c.sourceDocRef.trim().length > 0 &&
    c.liveVerified === false
  );
});
assert.ok(casesValid, 'All cases must have descriptive reason, source doc reference, and liveVerified === false');
recordCheck(`Case completeness verified across all ${fixtureData.cases.length} fixtures`, true);

// ---------------------------------------------------------------------------
// 4. Synthetic Candidate Decision Evaluator
// ---------------------------------------------------------------------------
/**
 * Evaluates candidate export authorization according to the conservative offline policy.
 *
 * Candidate Basic Success requires:
 *  - Same verified principal (tokenPrincipalId === boundPrincipalId)
 *  - Same verified source (driveResponse.id === requestSourceId)
 *  - Source is a Google spreadsheet (mimeType === 'application/vnd.google-apps.spreadsheet')
 *  - trashed === false
 *  - capabilities.canDownload strictly true
 *  - effectiveDownloadRestrictionWithContext has explicit booleans:
 *      restrictedForReaders === false
 *      restrictedForWriters === false
 *  - copyRequiresWriterPermission !== true
 *
 * Uncertain:
 *  - Missing/ambiguous fields (omitted/non-boolean restriction flags)
 *  - Mismatched principal/source
 *  - Contradictory legacy evidence
 *  - True readers or writers restriction with canDownload: true (pending principal-aware proof)
 *  - Unknown 403 error
 *
 * Restricted:
 *  - canDownload false (safe conservative denial)
 *
 * Admin Approval Required:
 *  - Explicit admin OAuth evidence (HTTP 403 admin_policy_enforced)
 *
 * Missing or Inaccessible:
 *  - HTTP 404
 *  - Trashed source
 *  - Non-spreadsheet source
 *
 * Retry Candidate:
 *  - Bounded rate limit 403 (rateLimitExceeded, userRateLimitExceeded)
 *
 * Auth Renewal Candidate vs Login Required:
 *  - Generic HTTP 401 with authRenewalAttempts === 0 -> auth_renewal_candidate
 *  - HTTP 401 with authRenewalAttempts >= 1 -> login_required
 *
 * Revoked:
 *  - Confirmed revocation via explicit synthetic evidence flag -> terminal revoked
 */
function evaluateCandidateAuthorization(caseItem) {
  const {
    requestSourceId,
    boundPrincipalId,
    tokenPrincipalId,
    httpStatus,
    apiErrorReason,
    authRenewalAttempts = 0,
    isConfirmedRevocation = false,
    driveResponse,
  } = caseItem;

  // 1. Confirmed revocation: explicit independent evidence required
  if (isConfirmedRevocation === true) {
    return 'revoked';
  }

  // 2. Generic HTTP 401 alone represents token expiry / renewal candidate, not proven revocation
  if (httpStatus === 401) {
    return authRenewalAttempts === 0 ? 'auth_renewal_candidate' : 'login_required';
  }

  // 3. HTTP 404 missing or inaccessible
  if (httpStatus === 404 || apiErrorReason === 'notFound') {
    return 'missing_or_inaccessible';
  }

  // 4. HTTP 403 taxonomy: rate-limit retry candidate vs admin approval required vs unknown
  if (httpStatus === 403) {
    if (apiErrorReason === 'rateLimitExceeded' || apiErrorReason === 'userRateLimitExceeded') {
      return 'retry_candidate';
    }
    if (apiErrorReason === 'admin_policy_enforced' || apiErrorReason === 'org_internal') {
      return 'admin_approval_required';
    }
    return 'uncertain';
  }

  // Non-200 unhandled HTTP statuses fail uncertain
  if (httpStatus !== 200) {
    return 'uncertain';
  }

  // 5. Principal and source binding verification (absent verified principal/source cannot be allowed)
  if (!tokenPrincipalId || !boundPrincipalId || tokenPrincipalId !== boundPrincipalId) {
    return 'uncertain';
  }

  if (!driveResponse || typeof driveResponse !== 'object') {
    return 'uncertain';
  }

  if (!requestSourceId || driveResponse.id !== requestSourceId) {
    return 'uncertain';
  }

  // 6. Source type and trashed status: missing_or_inaccessible / unsupported source
  if (driveResponse.trashed === true) {
    return 'missing_or_inaccessible';
  }
  if (driveResponse.trashed !== false) {
    return 'uncertain';
  }

  if (driveResponse.mimeType !== 'application/vnd.google-apps.spreadsheet') {
    return 'missing_or_inaccessible';
  }

  // 7. Capability canDownload evaluation
  const capabilities = driveResponse.capabilities;
  if (!capabilities || typeof capabilities.canDownload !== 'boolean') {
    return 'uncertain';
  }

  // canDownload strictly false is a safe conservative denial
  if (capabilities.canDownload === false) {
    return 'restricted';
  }

  // 8. Download restrictions object & effectiveDownloadRestrictionWithContext
  const downloadRestrictions = driveResponse.downloadRestrictions;
  if (!downloadRestrictions || typeof downloadRestrictions !== 'object') {
    return 'uncertain';
  }

  const effectiveContext = downloadRestrictions.effectiveDownloadRestrictionWithContext;
  if (!effectiveContext || typeof effectiveContext !== 'object') {
    return 'uncertain';
  }

  // Validate strict official schema
  validateRestrictionContextKeys(effectiveContext, caseItem.caseId || 'synthetic');

  // Both flags must be explicit booleans; omitted or non-boolean flags evaluate to uncertain
  if (
    typeof effectiveContext.restrictedForReaders !== 'boolean' ||
    typeof effectiveContext.restrictedForWriters !== 'boolean'
  ) {
    return 'uncertain';
  }

  // True readers or writers with canDownload true remains uncertain under conservative role-unproven candidate
  if (
    effectiveContext.restrictedForReaders === true ||
    effectiveContext.restrictedForWriters === true
  ) {
    return 'uncertain';
  }

  // 9. Contradictory legacy IRM check
  if (driveResponse.copyRequiresWriterPermission === true) {
    return 'uncertain';
  }

  // 10. Unrestricted candidate basic success
  if (
    capabilities.canDownload === true &&
    effectiveContext.restrictedForReaders === false &&
    effectiveContext.restrictedForWriters === false
  ) {
    return 'allowed';
  }

  return 'uncertain';
}

// ---------------------------------------------------------------------------
// 5. Oracle Comparison Against Candidate Decision Evaluator
// ---------------------------------------------------------------------------
let oracleMismatches = 0;
fixtureData.cases.forEach(caseItem => {
  const evaluatedStatus = evaluateCandidateAuthorization(caseItem);
  const matches = evaluatedStatus === caseItem.expectedStatus;
  if (!matches) {
    oracleMismatches++;
    console.error(`Mismatch on ${caseItem.caseId}: evaluated='${evaluatedStatus}', expected='${caseItem.expectedStatus}'`);
  }
  assert.equal(
    evaluatedStatus,
    caseItem.expectedStatus,
    `Evaluated status must match oracle for ${caseItem.caseId}`
  );
});

recordCheck(
  `Candidate evaluator matches oracle on all ${fixtureData.cases.length} cases`,
  oracleMismatches === 0,
  { evaluatedCount: fixtureData.cases.length, mismatches: oracleMismatches }
);

// ---------------------------------------------------------------------------
// 6. Verification of Specific Policy Invariants
// ---------------------------------------------------------------------------
// Invariant A: No 'allowed' case has mismatched principal or source
const allowedCases = fixtureData.cases.filter(c => c.expectedStatus === 'allowed');
const allowedBindingsValid = allowedCases.every(c => {
  const eff = c.driveResponse?.downloadRestrictions?.effectiveDownloadRestrictionWithContext;
  return (
    c.tokenPrincipalId === c.boundPrincipalId &&
    c.requestSourceId === c.driveResponse?.id &&
    c.driveResponse?.mimeType === 'application/vnd.google-apps.spreadsheet' &&
    c.driveResponse?.capabilities?.canDownload === true &&
    eff?.restrictedForReaders === false &&
    eff?.restrictedForWriters === false &&
    c.driveResponse?.copyRequiresWriterPermission === false &&
    c.driveResponse?.trashed === false
  );
});
assert.ok(allowedBindingsValid, 'All allowed cases must satisfy full binding, spreadsheet type, and false/false flags');
recordCheck(`All ${allowedCases.length} 'allowed' cases strictly conform to candidate success predicate`, true);

// Invariant B: Editor on readers-restricted file with canDownload:true is 'uncertain'
const editorCase = fixtureData.cases.find(c => c.caseId === 'case-05-editor-readers-irm-uncertain');
assert.ok(editorCase, 'case-05-editor-readers-irm-uncertain must exist');
assert.equal(editorCase.expectedStatus, 'uncertain');
recordCheck('Editor on readers-restricted file evaluated as uncertain pending role-aware proof', true);

// Invariant C: Omitted or non-boolean restriction flags evaluate to 'uncertain'
const omittedRestrictionCase = fixtureData.cases.find(c => c.caseId === 'case-10-omitted-restriction-field');
const missingFlagCase = fixtureData.cases.find(c => c.caseId === 'case-11-missing-reader-flag');
const nonBooleanCase = fixtureData.cases.find(c => c.caseId === 'case-12-nonboolean-writer-flag');
assert.equal(omittedRestrictionCase.expectedStatus, 'uncertain');
assert.equal(missingFlagCase.expectedStatus, 'uncertain');
assert.equal(nonBooleanCase.expectedStatus, 'uncertain');
recordCheck('Omitted/non-boolean restriction flags evaluate to uncertain offline', true);

// Invariant D: Error taxonomy distinguishes admin approval, rate limit, generic 401, and confirmed revocation
const adminCase = fixtureData.cases.find(c => c.caseId === 'case-16-admin-oauth-denial');
const rateLimitCase = fixtureData.cases.find(c => c.caseId === 'case-17-ratelimit-403-retry');
const generic401Case = fixtureData.cases.find(c => c.caseId === 'case-21-generic-401-auth-renewal');
const confirmedRevocationCase = fixtureData.cases.find(c => c.caseId === 'case-23-confirmed-revocation-terminal');
const trashedCase = fixtureData.cases.find(c => c.caseId === 'case-20-trashed-workbook-inaccessible');

assert.equal(adminCase.expectedStatus, 'admin_approval_required');
assert.equal(rateLimitCase.expectedStatus, 'retry_candidate');
assert.equal(generic401Case.expectedStatus, 'auth_renewal_candidate');
assert.equal(confirmedRevocationCase.expectedStatus, 'revoked');
assert.equal(trashedCase.expectedStatus, 'missing_or_inaccessible');
recordCheck('Updated error taxonomy verified across admin denial, rate-limit, 401 renewal, confirmed revocation, and trashed source', true);

// ---------------------------------------------------------------------------
// 7. In-Memory Mutation Checks (Proving validator rejects policy violations)
// ---------------------------------------------------------------------------
console.log('\n--- Running In-Memory Mutation Self-Tests ---');

// Mutation 1: Invented field under effectiveDownloadRestrictionWithContext must throw schema error
assert.throws(
  () => {
    const mutated = JSON.parse(JSON.stringify(allowedCases[0]));
    mutated.driveResponse.downloadRestrictions.effectiveDownloadRestrictionWithContext.type = 'none';
    evaluateCandidateAuthorization(mutated);
  },
  /Disallowed invented key 'type'/,
  'Invented key under effectiveDownloadRestrictionWithContext must be rejected'
);
recordCheck('Mutation 1: Checker rejects invented field under effectiveDownloadRestrictionWithContext', true);

// Mutation 2: Missing or non-boolean flag must evaluate to uncertain, never allowed
const mutatedNonBoolean = JSON.parse(JSON.stringify(allowedCases[0]));
mutatedNonBoolean.driveResponse.downloadRestrictions.effectiveDownloadRestrictionWithContext.restrictedForReaders = null;
assert.equal(
  evaluateCandidateAuthorization(mutatedNonBoolean),
  'uncertain',
  'Non-boolean restriction flag must evaluate to uncertain'
);
recordCheck('Mutation 2: Non-boolean restriction flag evaluated as uncertain', true);

// Mutation 3: canDownload true with restrictedForReaders true evaluates to uncertain under role-unproven candidate
const mutatedReaderRestricted = JSON.parse(JSON.stringify(allowedCases[0]));
mutatedReaderRestricted.driveResponse.downloadRestrictions.effectiveDownloadRestrictionWithContext.restrictedForReaders = true;
assert.equal(
  evaluateCandidateAuthorization(mutatedReaderRestricted),
  'uncertain',
  'restrictedForReaders true with canDownload true must evaluate to uncertain'
);
recordCheck('Mutation 3: Reader restriction with canDownload true evaluated as uncertain', true);

// Mutation 4: canDownload false takes precedence as restricted
const mutatedCanDownloadFalse = JSON.parse(JSON.stringify(allowedCases[0]));
mutatedCanDownloadFalse.driveResponse.capabilities.canDownload = false;
assert.equal(
  evaluateCandidateAuthorization(mutatedCanDownloadFalse),
  'restricted',
  'canDownload false must evaluate to restricted'
);
recordCheck('Mutation 4: canDownload false evaluates to restricted', true);

// Mutation 5: Generic 401 evaluates to auth_renewal_candidate, NOT revoked
const mutatedGeneric401 = JSON.parse(JSON.stringify(allowedCases[0]));
mutatedGeneric401.httpStatus = 401;
assert.equal(
  evaluateCandidateAuthorization(mutatedGeneric401),
  'auth_renewal_candidate',
  'Generic HTTP 401 must evaluate to auth_renewal_candidate'
);
recordCheck('Mutation 5: Generic HTTP 401 evaluated as auth_renewal_candidate, not inferred revocation', true);

const mutatedMissingTrashed = structuredClone(allowedCases[0]);
delete mutatedMissingTrashed.driveResponse.trashed;
assert.equal(evaluateCandidateAuthorization(mutatedMissingTrashed), 'uncertain');
recordCheck('Mutation 6: Missing trashed evidence cannot satisfy the strict candidate success predicate', true);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totalChecks = results.length;
const passedChecks = results.filter(r => r.pass).length;
if (passedChecks !== totalChecks) process.exitCode = 1;
console.log(`\n=======================================================`);
console.log(`Results: ${passedChecks}/${totalChecks} checks passed.`);
console.log(`Live Status: NOT RUN (Awaiting live Google Cloud & tenant testing)`);
console.log(`=======================================================\n`);
