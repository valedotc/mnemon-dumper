// extractors/strings.ts

import type { Extractor, Snapshot } from "./types.js";

interface StringEntry {
  firstSeenSeq: number;
  memoryOffset: number;
  value: string;
}

function extractStrings(buf: Buffer, minLen = 8): Array<{ offset: number; value: string }> {
  const results: Array<{ offset: number; value: string }> = [];
  let run = "";
  let runStart = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b >= 0x20 && b <= 0x7e) {
      if (run.length === 0) runStart = i;
      run += String.fromCharCode(b);
    } else {
      if (run.length >= minLen) results.push({ offset: runStart, value: run });
      run = "";
    }
  }
  if (run.length >= minLen) results.push({ offset: runStart, value: run });
  return results;
}

export class StringsExtractor implements Extractor {
  private seen = new Map<string, StringEntry>();

  onSnapshot(snapshot: Snapshot): void {
    for (const chunk of snapshot.chunks) {
      for (const { offset, value } of extractStrings(chunk.data)) {
        if (!this.seen.has(value)) {
          this.seen.set(value, {
            firstSeenSeq: snapshot.seq,
            memoryOffset: chunk.offset + offset,
            value,
          });
        }
      }
    }
  }

  // stringCount (uint32)
  // per string: firstSeenSeq (uint32) + memoryOffset (uint32) + length (uint16) + utf8 bytes
  finalize(): Buffer {
    const encoded: Array<{ entry: StringEntry; bytes: Buffer }> = [];
    let size = 4; // stringCount
    for (const entry of this.seen.values()) {
      const bytes = Buffer.from(entry.value, "utf8");
      size += 4 + 4 + 2 + bytes.length;
      encoded.push({ entry, bytes });
    }
    const buf = Buffer.allocUnsafe(size);
    let pos = 0;
    buf.writeUInt32LE(encoded.length, pos); pos += 4;
    for (const { entry, bytes } of encoded) {
      buf.writeUInt32LE(entry.firstSeenSeq, pos); pos += 4;
      buf.writeUInt32LE(entry.memoryOffset, pos); pos += 4;
      buf.writeUInt16LE(bytes.length, pos); pos += 2;
      bytes.copy(buf, pos); pos += bytes.length;
    }
    return buf;
  }
}
