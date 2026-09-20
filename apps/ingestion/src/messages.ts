/** The SQS message contract between the splitter and the workers. */
export interface ChunkMessage {
  readonly jobId: string;
  readonly chunkIndex: number;
  readonly bucket: string;
  readonly key: string;
  readonly startByte: number;
  /** Exclusive. The worker owns every line that STARTS before this offset. */
  readonly endByte: number;
  /** Propagated from the originating HTTP request so one id spans the whole pipeline. */
  readonly requestId?: string;
}

export function parseChunkMessage(body: string): ChunkMessage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Partial<ChunkMessage>;
    if (
      typeof m.jobId !== 'string' ||
      typeof m.chunkIndex !== 'number' ||
      typeof m.bucket !== 'string' ||
      typeof m.key !== 'string' ||
      typeof m.startByte !== 'number' ||
      typeof m.endByte !== 'number'
    ) {
      return null;
    }
    return m as ChunkMessage;
  } catch {
    return null;
  }
}
