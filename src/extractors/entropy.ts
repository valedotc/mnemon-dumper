// extractors/entropy.ts

import type { Extractor, Snapshot } from "./types.js";

interface EntropyEntry {
  seq: number;
  timestamp: number;
  pages: Array<{ offset: number; entropy: number }>;
}

function shannonEntropy(buf: Buffer): number {
  const freq = new Float64Array(256);
  for (const b of buf) freq[b] = (freq[b] ?? 0) + 1;
  let h = 0;
  const n = buf.length;
  for (const f of freq) {
    if (f > 0) {
      const p = f / n;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

export class EntropyExtractor implements Extractor {
  private entries: EntropyEntry[] = [];

  onSnapshot(snapshot: Snapshot): void {
    const pages: Array<{ offset: number; entropy: number }> = [];
    for (const chunk of snapshot.chunks) {
      pages.push({ offset: chunk.offset, entropy: shannonEntropy(chunk.data) });
    }
    this.entries.push({ seq: snapshot.seq, timestamp: snapshot.timestamp, pages });
  }

  // snapshotCount (uint32)
  // per snapshot: seq (uint32) + timestamp (uint64) + pageCount (uint32)
  //               then per page: offset (uint32) + entropy (float32)
  finalize(): Buffer {
    let size = 4; // snapshotCount
    for (const e of this.entries) size += 4 + 8 + 4 + e.pages.length * 8;
    const buf = Buffer.allocUnsafe(size);
    let pos = 0;
    buf.writeUInt32LE(this.entries.length, pos); pos += 4;
    for (const e of this.entries) {
      buf.writeUInt32LE(e.seq, pos); pos += 4;
      buf.writeBigUInt64LE(BigInt(e.timestamp), pos); pos += 8;
      buf.writeUInt32LE(e.pages.length, pos); pos += 4;
      for (const p of e.pages) {
        buf.writeUInt32LE(p.offset, pos); pos += 4;
        buf.writeFloatLE(p.entropy, pos); pos += 4;
      }
    }
    return buf;
  }
}
