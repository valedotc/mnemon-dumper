// extractors/timeline.ts

import type { Extractor, Snapshot } from "./types.js";

interface TimelineEntry {
  seq: number;
  timestamp: number;
  changedPages: number;
  totalByteLength: number;
}

export class TimelineExtractor implements Extractor {
  private entries: TimelineEntry[] = [];

  onSnapshot(snapshot: Snapshot): void {
    this.entries.push({
      seq: snapshot.seq,
      timestamp: snapshot.timestamp,
      changedPages: snapshot.chunks.length,
      totalByteLength: snapshot.totalByteLength,
    });
  }

  // tickCount (uint32)
  // per tick: seq (uint32) + timestamp (uint64) + changedPages (uint32) + totalByteLength (uint32)
  finalize(): Buffer {
    const buf = Buffer.allocUnsafe(4 + this.entries.length * 20);
    let pos = 0;
    buf.writeUInt32LE(this.entries.length, pos); pos += 4;
    for (const e of this.entries) {
      buf.writeUInt32LE(e.seq, pos); pos += 4;
      buf.writeBigUInt64LE(BigInt(e.timestamp), pos); pos += 8;
      buf.writeUInt32LE(e.changedPages, pos); pos += 4;
      buf.writeUInt32LE(e.totalByteLength, pos); pos += 4;
    }
    return buf;
  }
}
