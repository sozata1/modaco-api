/**
 * Line-aligned parsing of a byte range.
 *
 * The splitter divides the file by byte offset without ever opening it, which is what
 * makes it O(1) regardless of file size. The cost is that a chunk boundary lands in the
 * middle of a line. The rule that makes the split lossless:
 *
 *   A worker owns every line that STARTS inside its range.
 *
 * So a worker skips the partial line at its start (the previous chunk owns it, because
 * that line started there) and reads past its end to finish the last line it owns. Every
 * line is processed exactly once, by exactly one worker, with no coordination between them.
 *
 * DOCUMENTED CONSTRAINT: this breaks on RFC 4180 fields containing embedded newlines,
 * because a byte offset cannot tell a data newline from a record separator without
 * parsing from the file's start — which is precisely what we are refusing to do. The
 * vendor feed contract forbids embedded newlines and the splitter samples the file to
 * check. A file that fails that check falls back to single-worker streaming. Stating the
 * limit is better than pretending the technique is universal.
 */

export interface ChunkView {
  /**
   * Bytes read from S3. For any chunk after the first this buffer starts ONE BYTE
   * BEFORE the chunk's range — see `includesPrecedingByte`.
   */
  readonly buffer: Buffer;
  /**
   * Whether `buffer[0]` is the byte immediately before `startByte`.
   *
   * This single byte resolves an ambiguity that silently drops rows without it. A chunk
   * boundary can land either mid-line or exactly on a line start, and from inside the
   * range those two cases look identical. Assuming mid-line — skipping to the first
   * newline — discards a whole line whenever the boundary happened to be clean, and the
   * previous chunk does not own it either (its range already ended). One byte of
   * lookbehind tells the two apart: a preceding '\n' means this chunk begins on a line
   * start and owns it.
   */
  readonly includesPrecedingByte: boolean;
  /** endByte - startByte. A line is owned if it STARTS within this many bytes. */
  readonly ownedLength: number;
  /** Chunk 0 begins on a line start too, but that line is the CSV header. */
  readonly isFirstChunk: boolean;
}

export interface ParsedLine {
  readonly text: string;
  /** Byte offset of the line start relative to the chunk's startByte. */
  readonly offset: number;
}

export function* iterateOwnedLines(view: ChunkView): Generator<ParsedLine> {
  const { buffer, ownedLength } = view;
  // Buffer index that corresponds to the chunk's startByte.
  const base = view.includesPrecedingByte ? 1 : 0;

  let cursor: number;
  if (view.isFirstChunk) {
    const headerEnd = buffer.indexOf(0x0a);
    if (headerEnd === -1) return;
    cursor = headerEnd + 1;
  } else if (view.includesPrecedingByte && buffer[0] === 0x0a) {
    // Clean boundary: the chunk starts exactly at a line start and owns that line.
    cursor = base;
  } else {
    // Mid-line boundary: this partial line started in the previous chunk, which owns it.
    const partialEnd = buffer.indexOf(0x0a);
    if (partialEnd === -1) return;
    cursor = partialEnd + 1;
  }

  const ownedEnd = base + ownedLength;
  while (cursor < ownedEnd && cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    const end = newline === -1 ? buffer.length : newline;

    // Trailing \r from CRLF files.
    const trimmedEnd = end > cursor && buffer[end - 1] === 0x0d ? end - 1 : end;
    if (trimmedEnd > cursor) {
      yield { text: buffer.toString('utf8', cursor, trimmedEnd), offset: cursor - base };
    }

    if (newline === -1) return;
    cursor = newline + 1;
  }
}

export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    // noUncheckedIndexedAccess types this as possibly undefined even though the loop
    // bound rules it out; narrowing is cheaper than an assertion we would have to trust.
    if (char === undefined) break;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export interface RawVendorRow {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly vendorPrice: string;
  readonly stock: string;
}

export const EXPECTED_COLUMNS = 5;

export function parseVendorLine(line: string): RawVendorRow | null {
  const fields = splitCsvLine(line);
  if (fields.length !== EXPECTED_COLUMNS) return null;
  return {
    sku: (fields[0] ?? '').trim(),
    name: (fields[1] ?? '').trim(),
    category: (fields[2] ?? '').trim(),
    vendorPrice: (fields[3] ?? '').trim(),
    stock: (fields[4] ?? '').trim(),
  };
}
