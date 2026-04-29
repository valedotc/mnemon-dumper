// extractors/rawpages.ts

import type { FileHandle } from "node:fs/promises";
import type { Extractor, Snapshot } from "./types.js";
import { type Logger, SILENT } from "../logger.js";

const PAGE_SIZE = 65536;
const WARN_THRESHOLD_MB = 512;

interface StoredSnapshot {
  seq: number;
  chunks: Array<{ offset: number; data: Buffer }>;
}

export interface RawPagesOptions {
  maxMB?: number;
  duration: number;   // ms
  interval: number;   // ms
  logger?: Logger;
}

export class RawPagesExtractor implements Extractor {
  private readonly snapshots: StoredSnapshot[] = [];
  private readonly maxBytes: number | null;
  private readonly duration: number;
  private readonly interval: number;
  private readonly logger: Logger;
  private bytesAccepted = 0;
  private limitReached = false;
  private baseWarned = false;
  private deltaWarned = false;

  constructor(opts: RawPagesOptions = { duration: 60_000, interval: 1_000 }) {
    this.maxBytes = opts.maxMB != null ? opts.maxMB * 1024 * 1024 : null;
    this.duration = opts.duration;
    this.interval = opts.interval;
    this.logger = opts.logger ?? SILENT;
  }

  onSnapshot(snapshot: Snapshot): void {
    if (this.limitReached) return;

    const validChunks = snapshot.chunks.filter((c) => c.data.length === PAGE_SIZE);

    if (snapshot.isBase && !this.baseWarned) {
      this.baseWarned = true;
      const memMB = Math.round(snapshot.totalByteLength / 1024 / 1024);
      // Worst-case estimate: base + 1 % of base per delta snapshot
      const snapshotCount = Math.ceil(this.duration / this.interval);
      const estimatedMB = memMB + Math.round(memMB * 0.01 * snapshotCount);
      const capMsg = this.maxBytes != null
        ? ` (capped at --max-rawpages-mb ${Math.round(this.maxBytes / 1024 / 1024)}MB)`
        : ` — use --max-rawpages-mb to limit`;
      if (memMB >= WARN_THRESHOLD_MB) {
        this.logger.warn(
          `[rawpages] Large WASM memory: ${memMB}MB. ` +
          `Estimated output: ~${estimatedMB}MB${capMsg}`,
        );
      }
    }

    if (!snapshot.isBase && !this.deltaWarned) {
      this.deltaWarned = true;
      const deltaMB = validChunks.reduce((s, c) => s + c.data.length, 0) / 1024 / 1024;
      const snapshotsLeft = Math.ceil(this.duration / this.interval) - this.snapshots.length;
      const revisedMB = this.bytesAccepted / 1024 / 1024 + deltaMB * snapshotsLeft;
      this.logger.v(
        `[rawpages] First delta: ${deltaMB.toFixed(1)}MB. Revised estimate: ~${Math.round(revisedMB)}MB total`,
      );
    }

    // Per-snapshot byte budget: 8-byte header + (4-byte offset + PAGE_SIZE) per chunk
    const snapshotBytes = 8 + validChunks.length * (4 + PAGE_SIZE);

    if (this.maxBytes != null && this.bytesAccepted + snapshotBytes > this.maxBytes) {
      this.limitReached = true;
      const capMB = Math.round(this.maxBytes / 1024 / 1024);
      this.logger.warn(`[rawpages] Size limit reached (${capMB}MB). Stopping rawpages capture.`);
      return;
    }

    this.bytesAccepted += snapshotBytes;
    this.snapshots.push({ seq: snapshot.seq, chunks: validChunks });
  }

  // Format:
  //   snapshotCount (uint32)
  //   per snapshot: seq (uint32) + chunkCount (uint32)
  //     per chunk:  offset (uint32) + bytes[PAGE_SIZE]
  //
  // Writes directly to a file handle to avoid the 2GB Buffer.concat limit.
  async finalizeToHandle(fh: FileHandle): Promise<number> {
    let written = 0;

    const countBuf = Buffer.allocUnsafe(4);
    countBuf.writeUInt32LE(this.snapshots.length, 0);
    await fh.write(countBuf, 0, 4, null);
    written += 4;

    for (const snap of this.snapshots) {
      const header = Buffer.allocUnsafe(8);
      header.writeUInt32LE(snap.seq, 0);
      header.writeUInt32LE(snap.chunks.length, 4);
      await fh.write(header, 0, 8, null);
      written += 8;

      for (const chunk of snap.chunks) {
        const offsetBuf = Buffer.allocUnsafe(4);
        offsetBuf.writeUInt32LE(chunk.offset, 0);
        await fh.write(offsetBuf, 0, 4, null);
        await fh.write(chunk.data, 0, chunk.data.length, null);
        written += 4 + chunk.data.length;
      }
    }

    return written;
  }

  // Kept for interface compatibility. For small captures finalizeToHandle is preferred.
  finalize(): Buffer {
    const parts: Buffer[] = [];

    const countBuf = Buffer.allocUnsafe(4);
    countBuf.writeUInt32LE(this.snapshots.length, 0);
    parts.push(countBuf);

    for (const snap of this.snapshots) {
      const header = Buffer.allocUnsafe(8);
      header.writeUInt32LE(snap.seq, 0);
      header.writeUInt32LE(snap.chunks.length, 4);
      parts.push(header);

      for (const chunk of snap.chunks) {
        const offsetBuf = Buffer.allocUnsafe(4);
        offsetBuf.writeUInt32LE(chunk.offset, 0);
        parts.push(offsetBuf, chunk.data);
      }
    }

    return Buffer.concat(parts);
  }
}
