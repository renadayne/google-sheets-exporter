import { describe, it, expect } from 'vitest';
import { formatMetadataArtifactFilename } from '../../src/export/names.ts';
import { DomainError } from '../../src/contracts/errors.ts';

describe('T25b Metadata Companion Filename Helper', () => {
  it('formats literal, reserved safe, dots, and unicode/emoji filenames', () => {
    expect(formatMetadataArtifactFilename('Invoice.xlsx')).toBe('Invoice.metadata.json');
    expect(formatMetadataArtifactFilename('Single.csv')).toBe('Single.metadata.json');
    expect(formatMetadataArtifactFilename('_CON.csv')).toBe('_CON.metadata.json');
    expect(formatMetadataArtifactFilename('audit.2026.Q1.xlsx')).toBe('audit.2026.Q1.metadata.json');
    expect(formatMetadataArtifactFilename('報告_📊.csv')).toBe('報告_📊.metadata.json');
  });

  it('shortens long ASCII, CJK, and emoji stems at codepoint boundaries with suffix intact', () => {
    const encoder = new TextEncoder();
    const cases = [
      'A'.repeat(115) + '.xlsx',
      '數據'.repeat(19) + '.xlsx',
      '🌟'.repeat(28) + '.csv'
    ];
    for (const file of cases) {
      const companion = formatMetadataArtifactFilename(file);
      expect(encoder.encode(companion).length).toBeLessThanOrEqual(120);
      expect(companion.endsWith('.metadata.json')).toBe(true);
      const wellFormedCheck = companion as { toWellFormed?: () => string };
      if (typeof wellFormedCheck.toWellFormed === 'function') {
        expect(companion).toBe(wellFormedCheck.toWellFormed());
      }
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(companion)).toBe(false);
    }
  });

  it('is deterministic and avoids duplicate extension removal bugs', () => {
    expect(formatMetadataArtifactFilename('data.xlsx.xlsx')).toBe('data.xlsx.metadata.json');
    expect(formatMetadataArtifactFilename('sheet.csv.csv')).toBe('sheet.csv.metadata.json');
    const first = formatMetadataArtifactFilename('Invoice.xlsx');
    const second = formatMetadataArtifactFilename('Invoice.xlsx');
    expect(first).toBe(second);
  });

  it('fails with FORMAT_UNSUPPORTED without raw diagnostic on unsafe/invalid inputs', () => {
    const invalidInputs: unknown[] = [
      '../Invoice.xlsx', 'dir/Single.csv', 'C:\\Book.xlsx',
      'Inv\u0000.xlsx', 'Inv\n.csv',
      'CON.xlsx', 'con.txt.csv', 'aux.csv', 'NUL.xlsx',
      'Bad\uD800.xlsx', 'Bad\uDFFF.csv',
      'A'.repeat(120) + '.xlsx',
      '', undefined, null,
      'Book.zip', 'Book.json', 'Book.txt', 'Book.XLSX', 'Book.CSV', 'Book',
      123, {}, true
    ];
    for (const bad of invalidInputs) {
      try {
        formatMetadataArtifactFilename(bad as string);
        expect.unreachable(`Expected ${String(bad)} to throw`);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DomainError);
        const domErr = err as DomainError;
        expect(domErr.code).toBe('FORMAT_UNSUPPORTED');
        if (typeof bad === 'string' && bad.length > 0) {
          expect(domErr.message).not.toContain(bad);
        }
      }
    }
  });
});
