import * as zlib from 'node:zlib';

export interface ParsedZipEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  data: Uint8Array;
}

/** Independent bounded ZIP32 central directory parser using Node zlib inflateRawSync */
export function parseZipArchive(zipBytes: Uint8Array): ParsedZipEntry[] {
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
