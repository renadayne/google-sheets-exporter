/**
 * T11 Pure Source Identification
 * Validates Google Sheets document URLs and bare spreadsheet IDs.
 *
 * Supported Grammar:
 * 1. Bare Spreadsheet ID:
 *    - Trimmed string containing only ASCII alphanumeric characters, hyphens, and underscores: /^[A-Za-z0-9_-]+$/
 *    - Non-empty, without fixed-length assumptions (supports short, canonical, standard 44-char, and long IDs).
 *    - Rejects whitespace within token, punctuation, dots, slashes, control characters, and arbitrary URLs.
 *
 * 2. Supported Google Sheets URLs:
 *    - Protocol: HTTPS strictly required (http, ftp, javascript, file, etc. are rejected).
 *    - Host: exact case-insensitive 'docs.google.com' (normalized to lower-case by URL parser).
 *      Hostile suffixes (docs.google.com.evil.com), subdomains (evil.docs.google.com),
 *      IP addresses, and host-spoofing userinfo tricks (@attacker.com) are rejected.
 *    - Port: default port only (port 443 or omitted; non-default ports like 80, 8080 are rejected).
 *    - Credentials: username and password must be empty.
 *    - Path structure (exact supported patterns):
 *      a. Standard:
 *         /spreadsheets/d/{id}
 *         /spreadsheets/d/{id}/
 *         /spreadsheets/d/{id}/(edit|view|preview)
 *         /spreadsheets/d/{id}/(edit|view|preview)/
 *      b. Multi-account indexed:
 *         /spreadsheets/u/{decimal-account-index}/d/{id}
 *         /spreadsheets/u/{decimal-account-index}/d/{id}/
 *         /spreadsheets/u/{decimal-account-index}/d/{id}/(edit|view|preview)
 *         /spreadsheets/u/{decimal-account-index}/d/{id}/(edit|view|preview)/
 *      Where {id} is /^[A-Za-z0-9_-]+$/ (opaque token, no percent-encoding, no slashes).
 *      Where {decimal-account-index} is /^[0-9]+$/ (decimal digits).
 *
 * Explicitly Rejected Paths & Features:
 * - Published links (/spreadsheets/d/e/... or /spreadsheets/u/{u}/d/e/...)
 * - Unsupported path suffixes (/copy, /export, /htmlview, /gviz, etc.)
 * - Other Google document paths (/document/d/..., /presentation/d/..., /forms/d/..., /drive/...)
 * - Missing spreadsheet IDs (/spreadsheets/d, /spreadsheets/d/, etc.)
 * - Double slashes or path normalization evasion (/spreadsheets/d/{id}//, /../, /./)
 * - Embedded control characters (\x00-\x1F, \x7F) and newlines (\r, \n, \t)
 * - Percent-encoded slashes/backslashes/dots in paths; encoded control characters anywhere
 *
 * Sheet ID (gid) Extraction:
 * - Extracted from 'gid' query parameter or 'gid' fragment parameter.
 * - Value must be a non-negative safe decimal integer: /^(?:0|[1-9][0-9]*)$/ and <= Number.MAX_SAFE_INTEGER.
 *   Allows 0 (the standard default sheet) and positive integers without leading zeros.
 * - If present in both query and fragment, or duplicated within query or fragment: rejected as validation error.
 * - If negative, malformed, non-numeric, or integer overflow: rejected as validation error.
 * - Unknown harmless query/fragment parameters (e.g. authuser, usp, range) are ignored and never echoed.
 *
 * Security & Isolation Invariants:
 * - Pure synchronous parser: no network requests, no Chrome extension APIs, no DOM, no auth.
 * - Never checks live Google API existence or document permissions.
 * - Account path (/u/{index}) and authuser query params are NEVER converted to AccountContext.
 * - Returns only { spreadsheetId, highlightedSheetId? } as SourceRef; never caller-controlled URLs.
 * - Throws DomainError('SOURCE_UNSUPPORTED') without reflecting user input in error messages.
 */

import type { SourceRef } from '../contracts/domain.ts';
import { DomainError } from '../contracts/errors.ts';

/** Exact allowed hostname for Google Sheets documents. */
const ALLOWED_HOSTNAME = 'docs.google.com';

/** Opaque ID token regex: ASCII letters, digits, hyphen, underscore only. */
const OPAQUE_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/** Standard Google Sheets path regex: /spreadsheets/d/{id}(/(edit|view|preview))?(/)? */
const STANDARD_PATH_REGEX = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/(edit|view|preview))?\/?$/;

/** Multi-account indexed path regex: /spreadsheets/u/{accountIndex}/d/{id}(/(edit|view|preview))?(/)? */
const ACCOUNT_PATH_REGEX = /^\/spreadsheets\/u\/([0-9]+)\/d\/([A-Za-z0-9_-]+)(?:\/(edit|view|preview))?\/?$/;

/** Non-negative safe decimal integer regex: 0 or 1-9 followed by digits (no leading zeros). */
const SAFE_DECIMAL_INTEGER_REGEX = /^(?:0|[1-9][0-9]*)$/;

interface GidExtraction {
  readonly present: boolean;
  readonly count: number;
  readonly rawValue?: string;
}

function extractGidFromQuery(searchParams: URLSearchParams): GidExtraction {
  const values = searchParams.getAll('gid');
  if (values.length === 0) {
    return { present: false, count: 0 };
  }
  return {
    present: true,
    count: values.length,
    rawValue: values[0]
  };
}

function extractGidFromFragment(hash: string): GidExtraction {
  if (!hash || !hash.startsWith('#')) {
    return { present: false, count: 0 };
  }
  const rawHash = hash.slice(1);
  if (!rawHash) {
    return { present: false, count: 0 };
  }
  const params = new URLSearchParams(rawHash);
  const values = params.getAll('gid');
  if (values.length === 0) {
    return { present: false, count: 0 };
  }
  return {
    present: true,
    count: values.length,
    rawValue: values[0]
  };
}

function parseAndValidateGid(rawValue: string): number {
  if (rawValue.length > 16 || rawValue.trim() !== rawValue || !SAFE_DECIMAL_INTEGER_REGEX.test(rawValue)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  try {
    const big = BigInt(rawValue);
    if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    const num = Number(big);
    if (!Number.isSafeInteger(num) || num < 0) {
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
    return num;
  } catch {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
}

/**
 * Validates a user-supplied source input (bare spreadsheet ID or docs.google.com URL)
 * and returns a normalized SourceRef without verifying live existence or access.
 *
 * @param input Raw user string (spreadsheet ID or full Google Sheets URL)
 * @returns Validated SourceRef containing spreadsheetId and optional highlightedSheetId
 * @throws DomainError with code SOURCE_UNSUPPORTED on any invalid, malformed, or untrusted input
 */
export function identifySource(input: string): SourceRef {
  if (typeof input !== 'string') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // 1. Pre-validation checks for control characters, newlines, and adversarial escape tricks
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  if (trimmed.includes('\\')) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  // Encoded controls are unsupported even in URL parameters.
  if (/%(?:0[0-9a-fA-F]|1[0-9a-fA-F]|7[fF])/i.test(trimmed)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // 2. Bare Spreadsheet ID check
  // Bare ID is composed strictly of ASCII letters, digits, hyphen, underscore
  // (Cannot contain ':', '/', '.', '?', '#', whitespace, etc.)
  if (OPAQUE_ID_REGEX.test(trimmed)) {
    return {
      spreadsheetId: trimmed
    };
  }

  // 3. Must be a supported Google Sheets URL
  if (!/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(trimmed)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  const rawPath = trimmed.replace(/^https:\/\/[^/?#]+/i, '').split(/[?#]/, 1)[0];
  if (/%(?:5c|2f|2e)/i.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Protocol must be strictly HTTPS
  if (parsedUrl.protocol !== 'https:') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Host must be exactly docs.google.com (normalized to lower case by WHATWG URL)
  if (parsedUrl.hostname !== ALLOWED_HOSTNAME) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // No credentials permitted (username or password)
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // No non-default port permitted (for HTTPS, 443 is default and normalized to '')
  if (parsedUrl.port !== '') {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Reject published links explicitly (/spreadsheets/d/e/... or /spreadsheets/u/{u}/d/e/...)
  if (/\/spreadsheets\/(?:u\/[0-9]+\/)?d\/e(?:\/|$)/.test(parsedUrl.pathname)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Validate path against exact supported patterns
  let spreadsheetId: string;
  const standardMatch = STANDARD_PATH_REGEX.exec(parsedUrl.pathname);
  if (standardMatch) {
    spreadsheetId = standardMatch[1];
  } else {
    const accountMatch = ACCOUNT_PATH_REGEX.exec(parsedUrl.pathname);
    if (accountMatch) {
      spreadsheetId = accountMatch[2];
    } else {
      // Unsupported path or suffix
      throw new DomainError('SOURCE_UNSUPPORTED');
    }
  }

  // Validate path spreadsheetId is a valid opaque ASCII token
  if (!OPAQUE_ID_REGEX.test(spreadsheetId)) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // 4. Extract and validate sheet ID (gid) from query or fragment
  const queryGid = extractGidFromQuery(parsedUrl.searchParams);
  const fragmentGid = extractGidFromFragment(parsedUrl.hash);

  // Reject duplicated gid within query or fragment
  if (queryGid.count > 1 || fragmentGid.count > 1) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  // Reject conflicting or duplicated gid across query and fragment
  if (queryGid.present && fragmentGid.present) {
    throw new DomainError('SOURCE_UNSUPPORTED');
  }

  let highlightedSheetId: number | undefined;
  if (queryGid.present && queryGid.rawValue !== undefined) {
    highlightedSheetId = parseAndValidateGid(queryGid.rawValue);
  } else if (fragmentGid.present && fragmentGid.rawValue !== undefined) {
    highlightedSheetId = parseAndValidateGid(fragmentGid.rawValue);
  }

  if (highlightedSheetId !== undefined) {
    return {
      spreadsheetId,
      highlightedSheetId
    };
  }

  return {
    spreadsheetId
  };
}
