import { describe, it, expect, vi, afterEach } from 'vitest';
import * as zlib from 'node:zlib';
import * as fflate from 'fflate';
import { parse } from 'csv-parse/sync';

vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  return {
    ...actual,
    zipSync: vi.fn((...args: Parameters<typeof actual.zipSync>) => actual.zipSync(...args)),
  };
});
import {
  encodeCsvZip,
  PROVISIONAL_MAX_CSV_ZIP_BYTES,
  PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
} from '../../src/export/csv-zip.ts';
import { encodeCsvSheets, type CsvSheetBytes } from '../../src/export/csv-sheets.ts';
import { prepareWriterData } from '../../src/export/prepare.ts';
import { encodeFrozenJson } from '../../src/export/json-encoding.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import type { Cell, ExcludedIntervals, NormalizedChunk, Rect, SheetMeta, VisibilityMode } from '../../src/contracts/domain.ts';
import type { WriterContext } from '../../src/contracts/ports.ts';

const parseCsv = (b: Uint8Array) =>
  parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength), { bom: true, record_delimiter: '\r\n' });

const mkChunk = (
  sheetId: number,
  r: [number, number, number, number],
  cells: Cell[],
  excl: ExcludedIntervals = { rows: [], columns: [] }
): NormalizedChunk => ({
  jobId: 'j',
  chunkId: `c_${sheetId}`,
  rect: { sheetId, r0: r[0], c0: r[1], r1: r[2], c1: r[3] },
  cells,
  excludedIntervals: excl,
  byteCount: 1,
});

const mkMeta = (id: number, title: string, index: number, rows = 10, columns = 10): SheetMeta => ({
  id,
  title,
  index,
  type: 'GRID',
  hidden: false,
  rows,
  columns,
});

const mkCtx = (
  sheetOrder: number[],
  scopes: { sheetId: number; rect: Rect }[],
  sheets: SheetMeta[],
  vis: VisibilityMode = 'include_all'
): WriterContext => ({
  sourceId: 'src',
  title: 'Workbook',
  locale: 'en',
  timeZone: 'UTC',
  mode: 'raw',
  format: 'csv',
  visibility: vis,
  limitsVersion: '1.0',
  sheetOrder,
  scopes,
  sheets,
});

const defOpts = { maxChunks: 100, maxIntervals: 100, maxCells: 100, signal: new AbortController().signal };

interface ParsedZipEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  data: Uint8Array;
}

/** Independent bounded ZIP32 central directory parser using Node zlib inflateRawSync */
function parseZipArchive(zipBytes: Uint8Array): ParsedZipEntry[] {
  const buf = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  if (buf.length < 22) throw new Error('Zip too small');

  let eocdOffset = -1;
  const maxSearch = Math.min(buf.length - 22, 65557);
  for (let i = buf.length - 22; i >= buf.length - 22 - maxSearch; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('EOCD signature not found');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntries > 4097) throw new Error('Too many test entries');
  if (cdOffset + cdSize > eocdOffset) throw new Error('Corrupt central directory');

  let pos = cdOffset;
  const entries: ParsedZipEntry[] = [];
  for (let i = 0; i < totalEntries; i++) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) throw new Error(`Bad central directory header signature at ${pos}`);

    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    if (uncompSize > 8 * 1024 * 1024) throw new Error('Test entry too large');
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);

    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnLen);
    pos += 46 + fnLen + extraLen + commentLen;

    const localSig = buf.readUInt32LE(localOffset);
    if (localSig !== 0x04034b50) throw new Error(`Bad local file header signature at ${localOffset}`);
    const lFnLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + lFnLen + lExtraLen;
    if (dataOffset + compSize > cdOffset) throw new Error('Entry overlaps directory');
    if (buf.toString('utf8', localOffset + 30, localOffset + 30 + lFnLen) !== filename) throw new Error('Local filename mismatch');
    if (buf.readUInt16LE(localOffset + 8) !== method) throw new Error('Local method mismatch');
    if (buf.readUInt32LE(localOffset + 14) !== expectedCrc) throw new Error('Local CRC mismatch');
    if (buf.readUInt32LE(localOffset + 18) !== compSize || buf.readUInt32LE(localOffset + 22) !== uncompSize) throw new Error('Local size mismatch');

    const compSlice = buf.subarray(dataOffset, dataOffset + compSize);
    let decompressed: Buffer;
    if (method === 0) {
      decompressed = compSlice;
    } else if (method === 8) {
      decompressed = zlib.inflateRawSync(compSlice, { maxOutputLength: 8 * 1024 * 1024 });
    } else {
      throw new Error(`Unsupported compression method ${method}`);
    }

    if (decompressed.length !== uncompSize) {
      throw new Error(`Decompressed size mismatch for ${filename}: expected ${uncompSize}, got ${decompressed.length}`);
    }

    const actualCrc = zlib.crc32(decompressed);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC32 mismatch for ${filename}: expected ${expectedCrc}, got ${actualCrc}`);
    }

    entries.push({
      filename,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      crc32: expectedCrc,
      data: new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength),
    });
  }

  return entries;
}

function make3SheetsFixture(firstTitle = 'Data') {
  const ctx = mkCtx(
    [30, 10, 20],
    [
      { sheetId: 30, rect: { sheetId: 30, r0: 2, c0: 1, r1: 5, c1: 4 } },
      { sheetId: 10, rect: { sheetId: 10, r0: 0, c0: 0, r1: 2, c1: 2 } },
      { sheetId: 20, rect: { sheetId: 20, r0: 0, c0: 0, r1: 3, c1: 3 } },
    ],
    [mkMeta(30, firstTitle, 0), mkMeta(10, 'data', 2), mkMeta(20, 'Empty', 5)]
  );

  const s30Cells: Cell[] = [
    { r: 2, c: 1, kind: 'string', value: '00123' },
    { r: 2, c: 2, kind: 'string', value: 'café 🌟' },
    { r: 3, c: 1, kind: 'string', value: '=SUM(A1)' },
    { r: 3, c: 2, kind: 'number', value: -42 },
  ];

  const chunks = [
    mkChunk(30, [2, 1, 5, 4], s30Cells),
    mkChunk(10, [0, 0, 2, 2], [{ r: 0, c: 0, kind: 'string', value: 'tab10' }]),
    mkChunk(20, [0, 0, 3, 3], []),
  ];

  const prepared = prepareWriterData(ctx, chunks, defOpts);
  const csvRes = encodeCsvSheets(prepared, {
    maxBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
    signal: new AbortController().signal,
  });

  const manifestBytes = encodeFrozenJson(
    Object.freeze({
      schemaVersion: '1.0',
      format: 'csv',
      testMarker: 't27c1-manifest',
    }),
    { maxBytes: 1024, signal: new AbortController().signal }
  );

  return { sheets: csvRes.sheets, manifestBytes };
}

describe('T27c1 encodeCsvZip', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts portable predecessor names containing internal consecutive dots', () => {
    const { sheets, manifestBytes } = make3SheetsFixture('Q1..2026');
    expect(sheets[0].filename).toBe('Q1..2026.csv');
    const result = encodeCsvZip(sheets, manifestBytes, {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES, signal: new AbortController().signal
    });
    const entries = parseZipArchive(result);
    expect(entries.map(e => e.filename)).toEqual(['Q1..2026.csv', 'data.csv', 'Empty.csv', 'manifest.json']);
    expect(entries[0].data).toEqual(sheets[0].bytes);
  });

  it('encodes 3 CSV sheets + manifest in exact source order, preserving every decompressed byte and CSV payload', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();

    const options = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };

    const zipBytes = encodeCsvZip(sheets, manifestBytes, options);
    expect(zipBytes).toBeInstanceOf(Uint8Array);
    expect(zipBytes.byteLength).toBeGreaterThan(0);

    const parsedEntries = parseZipArchive(zipBytes);
    expect(parsedEntries).toHaveLength(4);

    // Exact names and source order + manifest.json last
    const entryNames = parsedEntries.map((e) => e.filename);
    expect(entryNames).toEqual(['Data.csv', 'data_10.csv', 'Empty.csv', 'manifest.json']);

    // Byte-for-byte exact equality on all decompressed entries
    expect(Buffer.from(parsedEntries[0].data)).toEqual(Buffer.from(sheets[0].bytes));
    expect(Buffer.from(parsedEntries[1].data)).toEqual(Buffer.from(sheets[1].bytes));
    expect(Buffer.from(parsedEntries[2].data)).toEqual(Buffer.from(sheets[2].bytes));
    expect(Buffer.from(parsedEntries[3].data)).toEqual(Buffer.from(manifestBytes));

    // Native CSV parsing: non-zero origin, dangerous formula prefix, utf-8 bom, dense gaps
    const rows0 = parseCsv(parsedEntries[0].data);
    expect(rows0).toEqual([
      ['00123', 'café 🌟', ''],
      ["'=SUM(A1)", '-42', ''],
      ['', '', ''],
    ]);

    const rows1 = parseCsv(parsedEntries[1].data);
    expect(rows1).toEqual([
      ['tab10', ''],
      ['', ''],
    ]);

    // Sheet 2 was empty 3x3 rectangle -> blank rows/cols
    const rows2 = parseCsv(parsedEntries[2].data);
    expect(rows2).toEqual([
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ]);
  });

  it('enforces exact uncompressed cap vs cap - 1 rejection before real zipSync invocation', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();

    const totalUncompressed =
      manifestBytes.byteLength +
      sheets[0].bytes.byteLength +
      sheets[1].bytes.byteLength +
      sheets[2].bytes.byteLength;

    const zipSyncMock = vi.mocked(fflate.zipSync);
    zipSyncMock.mockClear();

    // Exact cap: succeeds and calls zipSync
    const exactOptions = {
      maxUncompressedBytes: totalUncompressed,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };
    const zipBytes = encodeCsvZip(sheets, manifestBytes, exactOptions);
    expect(zipBytes.byteLength).toBeGreaterThan(0);
    expect(zipSyncMock).toHaveBeenCalledTimes(1);

    zipSyncMock.mockClear();

    // Cap - 1: rejects with BYTE_LIMIT_EXCEEDED BEFORE calling zipSync
    const overOptions = {
      maxUncompressedBytes: totalUncompressed - 1,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };

    expect(() => encodeCsvZip(sheets, manifestBytes, overOptions)).toThrowError(
      expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' })
    );
    expect(zipSyncMock).not.toHaveBeenCalled();
  });

  it('enforces maxBytes output boundary on final compressed archive', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();

    const normalOptions = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };
    const validZip = encodeCsvZip(sheets, manifestBytes, normalOptions);
    const archiveSize = validZip.byteLength;

    // Exact maxBytes = archiveSize: succeeds
    const exactRes = encodeCsvZip(sheets, manifestBytes, {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: archiveSize,
      signal: new AbortController().signal,
    });
    expect(exactRes.byteLength).toBe(archiveSize);

    // maxBytes = archiveSize - 1: rejects with BYTE_LIMIT_EXCEEDED
    expect(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
        maxBytes: archiveSize - 1,
        signal: new AbortController().signal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'BYTE_LIMIT_EXCEEDED' }));
  });

  it('rejects invalid paths, collisions, invalid types, and sheet count boundaries with FORMAT_SERIALIZATION_FAILED', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();
    const defaultOpt = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };

    const expectSerializationFail = (fn: () => void) => {
      expect(fn).toThrowError(DomainError);
      expect(fn).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));
    };

    // 1. Path traversal / subdirectories / backslash / invalid extension
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: '../escape.csv' }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'subdir/data.csv' }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'win\\data.csv' }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'data.txt' }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'CON.csv' }, sheets[1]], manifestBytes, defaultOpt)
    );

    // 2. Collision detection: exact and case+NFC
    expectSerializationFail(() =>
      encodeCsvZip([sheets[0], { ...sheets[1], filename: sheets[0].filename }], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([sheets[0], { ...sheets[1], filename: 'DATA.csv' }], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'é.csv' }, { ...sheets[1], filename: 'e\u0301.csv' }], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], filename: 'manifest.json' }, sheets[1]], manifestBytes, defaultOpt)
    );

    // 3. Sheet count boundaries: < 2 or > 4096
    expectSerializationFail(() => encodeCsvZip([], manifestBytes, defaultOpt));
    expectSerializationFail(() => encodeCsvZip([sheets[0]], manifestBytes, defaultOpt));
    const hugeSheets: CsvSheetBytes[] = Array.from({ length: 4097 }, (_, i) => ({
      sheetId: i,
      filename: `Sheet_${i}.csv`,
      bytes: new Uint8Array([1, 2, 3]),
      transformedCells: 0,
    }));
    expectSerializationFail(() => encodeCsvZip(hugeSheets, manifestBytes, defaultOpt));

    // 4. Invalid types / empty manifest
    expectSerializationFail(() => encodeCsvZip(sheets, new Uint8Array(0), defaultOpt));
    expectSerializationFail(() => encodeCsvZip(sheets, null as any, defaultOpt));
    expectSerializationFail(() => encodeCsvZip(null as any, manifestBytes, defaultOpt));
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], bytes: 'not-bytes' as any }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], sheetId: -1 }, sheets[1]], manifestBytes, defaultOpt)
    );
    expectSerializationFail(() =>
      encodeCsvZip([{ ...sheets[0], sheetId: sheets[1].sheetId }, sheets[1]], manifestBytes, defaultOpt)
    );
  });

  it('guarantees no input mutation, fresh ownership, and repeated deterministic archive byte equality', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();

    const options = {
      maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
      maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
      signal: new AbortController().signal,
    };

    const s0Copy = new Uint8Array(sheets[0].bytes);
    const mCopy = new Uint8Array(manifestBytes);

    const out1 = encodeCsvZip(sheets, manifestBytes, options);
    const out2 = encodeCsvZip(sheets, manifestBytes, options);

    // Deterministic fixed DOS timestamp (1980-01-01 00:00:00) and level 6 => exact byte equality
    expect(Buffer.compare(Buffer.from(out1), Buffer.from(out2))).toBe(0);

    // Input immutability
    expect(Buffer.compare(Buffer.from(sheets[0].bytes), Buffer.from(s0Copy))).toBe(0);
    expect(Buffer.compare(Buffer.from(manifestBytes), Buffer.from(mCopy))).toBe(0);

    // Fresh ownership: mutating returned archive does not affect inputs or subsequent calls
    out1[0] = 0xff;
    expect(out1[0]).not.toBe(out2[0]);
  });

  it('aborts on pre-aborted signal without invoking zipSync', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();
    const zipSyncMock = vi.mocked(fflate.zipSync);
    zipSyncMock.mockClear();

    const ac = new AbortController();
    ac.abort();

    expect(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
        maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
        signal: ac.signal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'OPERATION_ABORTED' }));

    expect(zipSyncMock).not.toHaveBeenCalled();
  });

  it('safely handles hostile config, throwing getters, and untrusted provider errors', () => {
    const { sheets, manifestBytes } = make3SheetsFixture();
    const defaultSignal = new AbortController().signal;

    const opts = { maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES, maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES, signal: defaultSignal };
    const actualArchive = encodeCsvZip(sheets, manifestBytes, opts);
    const duringZip = new AbortController();
    vi.mocked(fflate.zipSync).mockImplementationOnce(() => {
      duringZip.abort();
      return new Uint8Array(actualArchive);
    });
    expect(() => encodeCsvZip(sheets, manifestBytes, { ...opts, signal: duringZip.signal }))
      .toThrowError(expect.objectContaining({ code: 'OPERATION_ABORTED' }));
    for (const malformed of [new Uint8Array(0), new Uint8Array(22), Uint8Array.of(1)]) {
      vi.mocked(fflate.zipSync).mockReturnValueOnce(malformed);
      expect(() => encodeCsvZip(sheets, manifestBytes, opts))
        .toThrowError(expect.objectContaining({ code: 'FORMAT_SERIALIZATION_FAILED' }));
    }

    const expectConfigInvalid = (fn: () => void) => {
      expect(fn).toThrowError(DomainError);
      expect(fn).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'CONFIG_INVALID' }));
    };

    // Invalid config shapes
    expectConfigInvalid(() => encodeCsvZip(sheets, manifestBytes, null as any));
    expectConfigInvalid(() => encodeCsvZip(sheets, manifestBytes, [] as any));
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: -1,
        maxBytes: 100,
        signal: defaultSignal,
      })
    );
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: -0,
        maxBytes: 100,
        signal: defaultSignal,
      })
    );
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: 100,
        maxBytes: -0,
        signal: defaultSignal,
      })
    );
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES + 1,
        maxBytes: 100,
        signal: defaultSignal,
      })
    );
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: 100,
        maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES + 1,
        signal: defaultSignal,
      })
    );

    // Hostile throwing getter on config -> static CONFIG_INVALID (no raw diagnostic leakage)
    expectConfigInvalid(() =>
      encodeCsvZip(sheets, manifestBytes, {
        get maxUncompressedBytes(): number {
          throw new Error('Hostile getter diagnostic');
        },
        maxBytes: 100,
        signal: defaultSignal,
      } as any)
    );

    // Hostile throwing getter on sheet record -> static FORMAT_SERIALIZATION_FAILED
    const hostileSheet = {
      sheetId: 99,
      get filename(): string {
        throw new Error('Hostile filename getter');
      },
      bytes: new Uint8Array([1, 2, 3]),
      transformedCells: 0,
    };
    expect(() =>
      encodeCsvZip([hostileSheet as any, sheets[1]], manifestBytes, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
        maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
        signal: defaultSignal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));

    // Hostile provider error from fflate: throwing object with forged .code
    vi.mocked(fflate.zipSync).mockImplementationOnce(() => {
      const forged = new Error('Raw fflate crash');
      (forged as any).code = 'BYTE_LIMIT_EXCEEDED';
      throw forged;
    });

    expect(() =>
      encodeCsvZip(sheets, manifestBytes, {
        maxUncompressedBytes: PROVISIONAL_MAX_CSV_ZIP_UNCOMPRESSED_BYTES,
        maxBytes: PROVISIONAL_MAX_CSV_ZIP_BYTES,
        signal: defaultSignal,
      })
    ).toThrowError(expect.objectContaining({ name: 'DomainError', code: 'FORMAT_SERIALIZATION_FAILED' }));
  });
});
