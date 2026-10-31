import { describe, it, expect } from 'vitest';
import { identifySource } from '../../src/source/identify.ts';
import {
  DomainError,
  SAFE_ERROR_MESSAGES,
  isDomainError
} from '../../src/contracts/errors.ts';
import {
  CANONICAL_SPREADSHEET_ID,
  CANONICAL_SPARSE_SHEET_ID,
  CANONICAL_EMPTY_SHEET_ID,
  CANONICAL_HIDDEN_SHEET_ID
} from '../helpers/fixtures.ts';
import type { SourceRef } from '../../src/contracts/domain.ts';

describe('T11 Pure Source Identification', () => {
  it('rejects normalized malformed URL authorities and encoded terminal gid whitespace', () => {
    for (const input of [
      'https:docs.google.com/spreadsheets/d/abc/edit',
      'https:///docs.google.com/spreadsheets/d/abc/edit',
      'https:////docs.google.com/spreadsheets/d/abc/edit',
      'https://docs.google.com/spreadsheets/d/abc/edit#gid=1%E2%80%A8',
      'https://docs.google.com/spreadsheets/d/abc/edit?gid=1%E2%80%A9'
    ]) {
      expect(() => identifySource(input)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNSUPPORTED' }));
    }
  });

  it('ignores encoded harmless query values without weakening path checks', () => {
    expect(identifySource('https://docs.google.com/spreadsheets/d/abc/edit?ignored=https%3A%2F%2Fexample.com%2Fa%2F..%2Fb#gid=0')).toEqual({ spreadsheetId: 'abc', highlightedSheetId: 0 });
    expect(identifySource('https://docs.google.com/spreadsheets/d/abc/edit?ignored=/../')).toEqual({ spreadsheetId: 'abc' });
  });
  describe('1. Bare Spreadsheet IDs and trimming', () => {
    it('accepts canonical synthetic ID from T10', () => {
      const res: SourceRef = identifySource(CANONICAL_SPREADSHEET_ID);
      expect(res).toEqual({
        spreadsheetId: 'synthetic-canonical-wb-001'
      });
      expect(res.highlightedSheetId).toBeUndefined();
      expect(Object.keys(res)).toEqual(['spreadsheetId']);
    });

    it('accepts standard Google 44-character base64-like spreadsheet ID', () => {
      const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
      const res = identifySource(id);
      expect(res).toEqual({
        spreadsheetId: id
      });
      expect(Object.keys(res)).toEqual(['spreadsheetId']);
    });

    it('accepts valid ID containing both hyphens and underscores', () => {
      const id = 'alpha-123_456-beta_789';
      const res = identifySource(id);
      expect(res).toEqual({
        spreadsheetId: id
      });
    });

    it('does not assume fixed Google ID length (accepts short ID)', () => {
      const id = 'short-id-1';
      const res = identifySource(id);
      expect(res).toEqual({
        spreadsheetId: id
      });
    });

    it('does not assume fixed Google ID length (accepts very long ID)', () => {
      const id = 'a_very_long_spreadsheet_identifier_that_exceeds_the_standard_google_sheets_id_length_1234567890';
      const res = identifySource(id);
      expect(res).toEqual({
        spreadsheetId: id
      });
    });

    it('trims leading and trailing whitespace from bare ID', () => {
      const raw = '   synthetic-canonical-wb-001   ';
      const res = identifySource(raw);
      expect(res).toEqual({
        spreadsheetId: 'synthetic-canonical-wb-001'
      });
    });

    it('trims surrounding tabs and newlines from bare ID', () => {
      const raw = '\t\nsynthetic-canonical-wb-001\r\n';
      const res = identifySource(raw);
      expect(res).toEqual({
        spreadsheetId: 'synthetic-canonical-wb-001'
      });
    });
  });

  describe('2. Supported URL Variants and Path Grammar', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    it('accepts standard URL without trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts standard URL with trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /edit suffix without trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /edit suffix with trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit/`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /view suffix without trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/view`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /view suffix with trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/view/`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /preview suffix without trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/preview`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts /preview suffix with trailing slash', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/preview/`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts multi-account URL with decimal index 0', () => {
      const url = `https://docs.google.com/spreadsheets/u/0/d/${id}/edit`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts multi-account URL with nonzero decimal index', () => {
      const url = `https://docs.google.com/spreadsheets/u/2/d/${id}/view/`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts multi-account URL without suffix', () => {
      const url = `https://docs.google.com/spreadsheets/u/10/d/${id}`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('trims leading and trailing whitespace from URL input', () => {
      const url = `   https://docs.google.com/spreadsheets/d/${id}/edit   `;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });
  });

  describe('3. Host Normalization and Port Handling', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    it('normalizes uppercase hostname to lower-case', () => {
      const url = `https://DOCS.GOOGLE.COM/spreadsheets/d/${id}/edit`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('normalizes mixed-case hostname', () => {
      const url = `https://Docs.Google.Com/spreadsheets/d/${id}`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });

    it('accepts default HTTPS port 443 explicitly stated (normalized by URL parser)', () => {
      const url = `https://docs.google.com:443/spreadsheets/d/${id}/edit`;
      expect(identifySource(url)).toEqual({
        spreadsheetId: id
      });
    });
  });

  describe('4. GID Extraction (Highlight Hint Only)', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    it('extracts gid 0 from URL fragment', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 0
      });
      expect(res.highlightedSheetId).toBe(0);
    });

    it('extracts nonzero gid from URL fragment', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${CANONICAL_SPARSE_SHEET_ID}`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 101
      });
    });

    it('extracts gid 0 from URL query parameter', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit?gid=0`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 0
      });
    });

    it('extracts nonzero gid from URL query parameter', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${CANONICAL_EMPTY_SHEET_ID}`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 205
      });
    });

    it('extracts Number.MAX_SAFE_INTEGER gid without truncation', () => {
      const maxSafe = Number.MAX_SAFE_INTEGER; // 9007199254740991
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${maxSafe}`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 9007199254740991
      });
    });

    it('extracts gid when fragment contains other parameters like range', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${CANONICAL_HIDDEN_SHEET_ID}&range=A1:B10`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 309
      });
    });

    it('extracts gid when query contains harmless parameters like authuser and usp', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing&authuser=0&gid=101`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id,
        highlightedSheetId: 101
      });
    });

    it('gid does not narrow scope: returns exact SourceRef with no scope or range fields', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit#gid=101&range=A1:Z100`;
      const res = identifySource(url);
      expect(Object.keys(res).sort()).toEqual(['highlightedSheetId', 'spreadsheetId']);
      expect(res).not.toHaveProperty('range');
      expect(res).not.toHaveProperty('scope');
      expect(res).not.toHaveProperty('selection');
    });
  });

  describe('5. Principal Suppression and Query Value Isolation', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    it('account URL path does not create AccountContext or principal', () => {
      const url = `https://docs.google.com/spreadsheets/u/3/d/${id}/edit`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id
      });
      expect(res).not.toHaveProperty('principalKey');
      expect(res).not.toHaveProperty('displayEmail');
      expect(res).not.toHaveProperty('accountIndex');
    });

    it('authuser query parameter does not create AccountContext or principal', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit?authuser=user@example.com`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id
      });
      expect(res).not.toHaveProperty('principalKey');
      expect(res).not.toHaveProperty('displayEmail');
    });

    it('query parameters never become endpoint URLs or custom destinations', () => {
      const url = `https://docs.google.com/spreadsheets/d/${id}/edit?endpoint=https://evil.com/api&callback=http://attacker.com`;
      const res = identifySource(url);
      expect(res).toEqual({
        spreadsheetId: id
      });
      expect(res).not.toHaveProperty('endpoint');
      expect(res).not.toHaveProperty('callback');
      expect(res).not.toHaveProperty('url');
    });
  });

  describe('6. Hostile Host Suffix, Subdomain, IP, and Credential Rejections', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    function assertUnsupported(input: unknown) {
      expect(() => identifySource(input as string)).toThrow(DomainError);
      try {
        identifySource(input as string);
      } catch (err: unknown) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('SOURCE_UNSUPPORTED');
          expect(err.safeMessage).toBe(SAFE_ERROR_MESSAGES.SOURCE_UNSUPPORTED);
          expect(err.message).toBe(SAFE_ERROR_MESSAGES.SOURCE_UNSUPPORTED);
          if (typeof input === 'string' && input.length > 0) {
            expect(err.message).not.toContain(input);
          }
        }
      }
    }

    it('rejects hostile host suffix (docs.google.com.evil.com)', () => {
      assertUnsupported(`https://docs.google.com.evil.com/spreadsheets/d/${id}`);
    });

    it('rejects hostile host suffix with path tricks (docs.google.com-attacker.com)', () => {
      assertUnsupported(`https://docs.google.com-attacker.com/spreadsheets/d/${id}`);
    });

    it('rejects unauthorized subdomain (evil.docs.google.com)', () => {
      assertUnsupported(`https://evil.docs.google.com/spreadsheets/d/${id}`);
    });

    it('rejects unauthorized subdomain (drive.google.com)', () => {
      assertUnsupported(`https://drive.google.com/file/d/${id}/view`);
    });

    it('rejects unauthorized subdomain (sheets.google.com)', () => {
      assertUnsupported(`https://sheets.google.com/spreadsheets/d/${id}`);
    });

    it('rejects raw IP address host', () => {
      assertUnsupported(`https://142.250.190.46/spreadsheets/d/${id}`);
    });

    it('rejects localhost IP address host', () => {
      assertUnsupported(`https://127.0.0.1/spreadsheets/d/${id}`);
    });

    it('rejects non-HTTPS HTTP protocol', () => {
      assertUnsupported(`http://docs.google.com/spreadsheets/d/${id}/edit`);
    });

    it('rejects non-HTTPS FTP protocol', () => {
      assertUnsupported(`ftp://docs.google.com/spreadsheets/d/${id}`);
    });

    it('rejects javascript: pseudo-protocol', () => {
      assertUnsupported(`javascript:alert("exploit")`);
    });

    it('rejects non-default port (8080)', () => {
      assertUnsupported(`https://docs.google.com:8080/spreadsheets/d/${id}/edit`);
    });

    it('rejects non-default port (80)', () => {
      assertUnsupported(`https://docs.google.com:80/spreadsheets/d/${id}/edit`);
    });

    it('rejects non-default port (8443)', () => {
      assertUnsupported(`https://docs.google.com:8443/spreadsheets/d/${id}/edit`);
    });

    it('rejects URL with username and password credentials', () => {
      assertUnsupported(`https://admin:secret@docs.google.com/spreadsheets/d/${id}/edit`);
    });

    it('rejects URL with username credential only', () => {
      assertUnsupported(`https://admin@docs.google.com/spreadsheets/d/${id}/edit`);
    });

    it('rejects userinfo host spoofing with @', () => {
      assertUnsupported(`https://docs.google.com@attacker.com/spreadsheets/d/${id}`);
    });
  });

  describe('7. Backslashes, Encoded Separators, Dot-Segments, and Control Characters', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    function assertUnsupported(input: unknown) {
      expect(() => identifySource(input as string)).toThrow(DomainError);
      try {
        identifySource(input as string);
      } catch (err: unknown) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('SOURCE_UNSUPPORTED');
          expect(err.safeMessage).toBe(SAFE_ERROR_MESSAGES.SOURCE_UNSUPPORTED);
        }
      }
    }

    it('rejects literal backslash in URL', () => {
      assertUnsupported(`https://docs.google.com\\spreadsheets/d/${id}`);
    });

    it('rejects literal backslash in bare ID', () => {
      assertUnsupported(`spread\\sheet\\id`);
    });

    it('rejects percent-encoded backslash (%5c)', () => {
      assertUnsupported(`https://docs.google.com%5cspreadsheets/d/${id}`);
    });

    it('rejects percent-encoded backslash uppercase (%5C)', () => {
      assertUnsupported(`https://docs.google.com%5Cspreadsheets/d/${id}`);
    });

    it('rejects percent-encoded slash in path (%2f)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets%2fd/${id}`);
    });

    it('rejects percent-encoded slash in ID token (%2F)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/abc%2Fdef`);
    });

    it('rejects percent-encoded dot in path (%2e)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/%2e%2e/view`);
    });

    it('rejects percent-encoded dot uppercase (%2E)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/%2E%2E/view`);
    });

    it('rejects literal dot-segment path traversal (/../)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/../evil`);
    });

    it('rejects literal dot-segment in middle of path (/./)', () => {
      assertUnsupported(`https://docs.google.com/./spreadsheets/d/${id}`);
    });

    it('rejects literal dot-segment path traversal (/spreadsheets/../)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/../spreadsheets/d/${id}`);
    });

    it('rejects trailing dot-segment (/..)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/..`);
    });

    it('rejects trailing single dot (/.)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/.`);
    });

    it('rejects bare dot segment ..', () => {
      assertUnsupported(`..`);
    });

    it('rejects bare single dot .', () => {
      assertUnsupported(`.`);
    });

    it('rejects dot segment with path ../foo', () => {
      assertUnsupported(`../foo`);
    });

    it('rejects embedded newline in URL path', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}\n/edit`);
    });

    it('rejects embedded carriage return in URL path', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}\r/edit`);
    });

    it('rejects embedded tab within URL path', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}\t/edit`);
    });

    it('rejects percent-encoded newline (%0a)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}%0a`);
    });

    it('rejects percent-encoded carriage return (%0d)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}%0d`);
    });

    it('rejects percent-encoded null byte (%00)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}%00`);
    });
  });

  describe('8. Published Links and Unsupported Paths', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    function assertUnsupported(input: unknown) {
      expect(() => identifySource(input as string)).toThrow(DomainError);
      try {
        identifySource(input as string);
      } catch (err: unknown) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('SOURCE_UNSUPPORTED');
        }
      }
    }

    it('rejects published /d/e web link (/pubhtml)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/e/2PACX-1vT3n_k6WJ6/pubhtml`);
    });

    it('rejects published /d/e link without suffix', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/e/2PACX-1vT3n_k6WJ6`);
    });

    it('rejects published /d/e link with multi-account path', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u/0/d/e/2PACX-1vT3n_k6WJ6/pubhtml`);
    });

    it('rejects /copy suffix', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/copy`);
    });

    it('rejects /export suffix', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/export`);
    });

    it('rejects /htmlview suffix', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/htmlview`);
    });

    it('rejects /gviz/tq query endpoint', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq`);
    });

    it('rejects subpath after allowed suffix (/edit/other)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit/other`);
    });

    it('rejects double trailing slash (//)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}//`);
    });

    it('rejects double slash after edit (/edit//)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit//`);
    });

    it('rejects missing ID (/spreadsheets/d)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d`);
    });

    it('rejects missing ID with trailing slash (/spreadsheets/d/)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/`);
    });

    it('rejects missing ID in multi-account path (/spreadsheets/u/0/d)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u/0/d`);
    });

    it('rejects missing ID in multi-account path with trailing slash (/spreadsheets/u/0/d/)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u/0/d/`);
    });

    it('rejects non-decimal account index (/spreadsheets/u/abc/d/{id})', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u/abc/d/${id}`);
    });

    it('rejects negative account index (/spreadsheets/u/-1/d/{id})', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u/-1/d/${id}`);
    });

    it('rejects empty account index (/spreadsheets/u//d/{id})', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/u//d/${id}`);
    });

    it('rejects Google Docs document path (/document/d/{id})', () => {
      assertUnsupported(`https://docs.google.com/document/d/${id}/edit`);
    });

    it('rejects Google Slides presentation path (/presentation/d/{id})', () => {
      assertUnsupported(`https://docs.google.com/presentation/d/${id}/edit`);
    });

    it('rejects Google Forms path (/forms/d/{id})', () => {
      assertUnsupported(`https://docs.google.com/forms/d/${id}/viewform`);
    });

    it('rejects bare spreadsheets root path (/spreadsheets)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets`);
    });

    it('rejects unknown subpath on docs.google.com (/spreadsheets/view)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/view`);
    });
  });

  describe('9. GID Validation Errors (Duplicate, Conflicting, Malformed, Overflow, Negative)', () => {
    const id = CANONICAL_SPREADSHEET_ID;

    function assertUnsupported(input: unknown) {
      expect(() => identifySource(input as string)).toThrow(DomainError);
      try {
        identifySource(input as string);
      } catch (err: unknown) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('SOURCE_UNSUPPORTED');
        }
      }
    }

    it('rejects duplicated gid in query with different values', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0&gid=101`);
    });

    it('rejects duplicated gid in query with identical values', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=101&gid=101`);
    });

    it('rejects duplicated gid in fragment with different values', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0&gid=205`);
    });

    it('rejects duplicated gid in fragment with identical values', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0&gid=0`);
    });

    it('rejects conflicting gid across query and fragment (different values)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=101`);
    });

    it('rejects duplicate gid across query and fragment (same values)', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`);
    });

    it('rejects negative gid in query', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=-1`);
    });

    it('rejects negative gid in fragment', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=-1`);
    });

    it('rejects non-numeric alphabetical gid in query', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=abc`);
    });

    it('rejects non-numeric alphabetical gid in fragment', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=sheet1`);
    });

    it('rejects empty gid in query', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=`);
    });

    it('rejects empty gid in fragment', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=`);
    });

    it('rejects bare gid key without equals sign in fragment', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid`);
    });

    it('rejects decimal non-integer gid', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=1.5`);
    });

    it('rejects leading zeros on nonzero gid', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0123`);
    });

    it('rejects multiple zeros gid', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=00`);
    });

    it('rejects gid integer overflow beyond Number.MAX_SAFE_INTEGER', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=9007199254740992`);
    });

    it('rejects massive integer overflow in fragment', () => {
      assertUnsupported(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=99999999999999999999999999999`);
    });
  });

  describe('10. Invalid Bare Tokens and Untyped Inputs', () => {
    function assertUnsupported(input: unknown) {
      expect(() => identifySource(input as string)).toThrow(DomainError);
      try {
        identifySource(input as string);
      } catch (err: unknown) {
        expect(isDomainError(err)).toBe(true);
        if (isDomainError(err)) {
          expect(err.code).toBe('SOURCE_UNSUPPORTED');
          expect(err.safeMessage).toBe(SAFE_ERROR_MESSAGES.SOURCE_UNSUPPORTED);
          expect(err.message).toBe(SAFE_ERROR_MESSAGES.SOURCE_UNSUPPORTED);
          if (typeof input === 'string' && input.length > 0) {
            expect(err.message).not.toContain(input);
          }
        }
      }
    }

    it('rejects empty string', () => {
      assertUnsupported('');
    });

    it('rejects whitespace-only string', () => {
      assertUnsupported('   ');
    });

    it('rejects whitespace within bare token', () => {
      assertUnsupported('token with spaces');
    });

    it('rejects bare token with @ punctuation', () => {
      assertUnsupported('token@domain');
    });

    it('rejects bare token with exclamation mark', () => {
      assertUnsupported('token!id');
    });

    it('rejects bare token with dollar sign', () => {
      assertUnsupported('$token');
    });

    it('rejects bare token with dot', () => {
      assertUnsupported('token.id');
    });

    it('rejects bare token with forward slash', () => {
      assertUnsupported('token/id');
    });

    it('rejects arbitrary URL (example.com)', () => {
      assertUnsupported('https://example.com/spreadsheets/d/123');
    });

    it('rejects non-string input (null)', () => {
      assertUnsupported(null);
    });

    it('rejects non-string input (undefined)', () => {
      assertUnsupported(undefined);
    });

    it('rejects non-string input (number)', () => {
      assertUnsupported(12345);
    });

    it('rejects non-string input (object)', () => {
      assertUnsupported({ id: 'abc' });
    });
  });

  describe('11. Parser Pure Isolation and No Existence Claim', () => {
    it('operates synchronously and parses synthetic identifiers without network calls', () => {
      const result = identifySource('synthetic-standalone-pure-test-wb-999');
      expect(result).toEqual({
        spreadsheetId: 'synthetic-standalone-pure-test-wb-999'
      });
      // The parser makes no claim of existence or live permission.
    });
  });
});
