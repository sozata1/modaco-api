import { describe, expect, it } from 'vitest';
import { iterateOwnedLines, parseVendorLine, splitCsvLine } from '../src/csv.js';
import { computeByteRanges } from '../src/splitter.js';
import { dedupeBySku } from '../src/upsert.js';

/**
 * The correctness argument for the whole byte-range split lives here.
 *
 * The splitter divides the file without reading it, so boundaries land mid-line. The
 * rule that makes that lossless — a worker owns every line that STARTS in its range —
 * is only worth anything if it is actually implemented. These tests reconstruct whole
 * files from independently-parsed chunks and assert that every line appears exactly once.
 */

const HEADER = 'sku,name,category,vendor_price,stock\n';

function buildCsv(rowCount: number): string {
  let csv = HEADER;
  for (let i = 0; i < rowCount; i += 1) {
    csv += `SKU-${String(i).padStart(5, '0')},Product ${String(i)},Accessories,${String(10 + i)}.00,${String(i)}\n`;
  }
  return csv;
}

/**
 * Parses a file the way N independent workers would, mirroring exactly what each worker
 * fetches from S3: one byte of lookbehind, the range itself, and a trailing overlap.
 */
function parseViaChunks(csv: string, chunkBytes: number): string[] {
  const buffer = Buffer.from(csv, 'utf8');
  const overlap = 4_096;
  const lines: string[] = [];

  for (const range of computeByteRanges(buffer.length, chunkBytes)) {
    const includesPrecedingByte = range.start > 0;
    const sliceStart = includesPrecedingByte ? range.start - 1 : 0;
    const slice = buffer.subarray(sliceStart, Math.min(buffer.length, range.end + overlap));

    for (const line of iterateOwnedLines({
      buffer: slice,
      includesPrecedingByte,
      ownedLength: range.end - range.start,
      isFirstChunk: range.start === 0,
    })) {
      lines.push(line.text);
    }
  }
  return lines;
}

describe('byte-range chunking is lossless', () => {
  it.each([16, 37, 64, 100, 128, 256, 512, 1_024, 4_096])(
    'reconstructs every row exactly once with a %i-byte chunk',
    (chunkBytes) => {
      const rowCount = 200;
      const csv = buildCsv(rowCount);
      const parsed = parseViaChunks(csv, chunkBytes);

      // The header is consumed, every data row survives, none is duplicated.
      expect(parsed).toHaveLength(rowCount);
      expect(new Set(parsed).size).toBe(rowCount);
      expect(parsed[0]).toContain('SKU-00000');
      expect(parsed.at(-1)).toContain(`SKU-${String(rowCount - 1).padStart(5, '0')}`);
    },
  );

  it('never emits the header as data, at any chunk size', () => {
    for (const chunkBytes of [8, 33, 71, 200]) {
      const parsed = parseViaChunks(buildCsv(50), chunkBytes);
      expect(parsed.some((line) => line.startsWith('sku,name'))).toBe(false);
    }
  });

  it('handles a file with no trailing newline', () => {
    const csv = `${HEADER}SKU-1,A,Shoes,10.00,1\nSKU-2,B,Shoes,20.00,2`;
    expect(parseViaChunks(csv, 16)).toEqual(['SKU-1,A,Shoes,10.00,1', 'SKU-2,B,Shoes,20.00,2']);
  });

  it('strips CRLF line endings', () => {
    const csv = `sku,name,category,vendor_price,stock\r\nSKU-1,A,Shoes,10.00,1\r\n`;
    const parsed = parseViaChunks(csv, 1_024);
    expect(parsed).toEqual(['SKU-1,A,Shoes,10.00,1']);
  });

  it('yields nothing for a chunk that contains no line start', () => {
    // A slice landing entirely inside one very long line belongs to the previous chunk.
    const buffer = Buffer.from('x'.repeat(500));
    expect([
      ...iterateOwnedLines({
        buffer,
        includesPrecedingByte: true,
        ownedLength: 100,
        isFirstChunk: false,
      }),
    ]).toEqual([]);
  });

  /**
   * The exact case that was broken before the lookbehind byte existed: a boundary landing
   * precisely on a line start. Every chunk size that divides the row width hits it.
   */
  it('owns the line when the boundary lands exactly on a line start', () => {
    const rowWidth = 'SKU-00000,Product 0,Accessories,10.00,0\n'.length;
    const csv = buildCsv(20);
    const parsed = parseViaChunks(csv, rowWidth);
    expect(parsed).toHaveLength(20);
    expect(new Set(parsed).size).toBe(20);
  });
});

describe('splitCsvLine', () => {
  it.each([
    ['a,b,c', ['a', 'b', 'c']],
    ['a,,c', ['a', '', 'c']],
    ['"a,b",c', ['a,b', 'c']],
    ['"say ""hi""",b', ['say "hi"', 'b']],
    ['', ['']],
  ])('%s', (input, expected) => {
    expect(splitCsvLine(input)).toEqual(expected);
  });
});

describe('parseVendorLine', () => {
  it('accepts a well-formed row', () => {
    expect(parseVendorLine('SKU-1, Leather Belt ,Accessories,100.00,5')).toEqual({
      sku: 'SKU-1',
      name: 'Leather Belt',
      category: 'Accessories',
      vendorPrice: '100.00',
      stock: '5',
    });
  });

  it.each([['too,few,fields'], ['a,b,c,d,e,f'], ['']])('rejects %s', (line) => {
    expect(parseVendorLine(line)).toBeNull();
  });
});

describe('dedupeBySku', () => {
  /**
   * Without this, a duplicate SKU inside one batch makes PostgreSQL raise
   * "ON CONFLICT DO UPDATE command cannot affect row a second time" and roll back the
   * ENTIRE batch — a thousand good rows lost to one repeated SKU.
   */
  it('keeps the last occurrence of each SKU', () => {
    const rows = [
      { sku: 'A', name: 'first', category: 'X', basePriceCents: 100, stockQuantity: 1 },
      { sku: 'B', name: 'other', category: 'X', basePriceCents: 200, stockQuantity: 2 },
      { sku: 'A', name: 'last', category: 'X', basePriceCents: 300, stockQuantity: 3 },
    ];
    const deduped = dedupeBySku(rows);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((r) => r.sku === 'A')?.name).toBe('last');
  });
});

describe('computeByteRanges', () => {
  it('covers the file exactly, with no gap and no overlap', () => {
    const ranges = computeByteRanges(10_000, 3_000);
    expect(ranges).toEqual([
      { start: 0, end: 3_000 },
      { start: 3_000, end: 6_000 },
      { start: 6_000, end: 9_000 },
      { start: 9_000, end: 10_000 },
    ]);
  });

  it('is O(1) in the file size — the property that removes the timeout risk', () => {
    // 50 GB: still just arithmetic, no I/O, no allocation per byte.
    const ranges = computeByteRanges(50 * 1024 ** 3, 2 * 1024 ** 2);
    expect(ranges).toHaveLength(25_600);
    expect(ranges.at(-1)?.end).toBe(50 * 1024 ** 3);
  });
});
