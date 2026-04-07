// extractors/rawpages.ts

import type { Extractor, Snapshot } from "./types.js";

const PAGE_SIZE = 65536;

export class RawPagesExtractor implements Extractor {
  private snapshots: Array<{ seq: number; chunks: Array<{ offset: number; data: Buffer }> }> = [];

  onSnapshot(snapshot: Snapshot): void {
    this.snapshots.push({ seq: snapshot.seq, chunks: snapshot.chunks });
  }

  // snapshotCount (uint32)
  // per snapshot: seq (uint32) + chunkCount (uint32)
  //   per chunk:  offset (uint32) + bytes[65536]
  // WASM pages are always exactly 65536 bytes per spec — no padding.
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
        if (chunk.data.length !== PAGE_SIZE) {
          console.warn(
            `[mnemon] rawpages: unexpected chunk size ${chunk.data.length} at offset 0x${chunk.offset.toString(16)}` +
            ` in seq ${snap.seq} (expected ${PAGE_SIZE}); skipping chunk`,
          );
          continue;
        }
        const offsetBuf = Buffer.allocUnsafe(4);
        offsetBuf.writeUInt32LE(chunk.offset, 0);
        parts.push(offsetBuf, chunk.data);
      }
    }

    return Buffer.concat(parts);
  }
}
