import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TimelineExtractor } from "../../extractors/timeline.js";
import type { Snapshot } from "../../extractors/types.js";

function makeSnapshot(seq: number, changedPages: number): Snapshot {
  return {
    seq,
    timestamp: 1000 + seq * 500,
    totalByteLength: 131072,
    isBase: seq === 0,
    chunks: Array.from({ length: changedPages }, (_, i) => ({
      offset: i * 65536,
      data: Buffer.alloc(65536, seq),
    })),
  };
}

describe("TimelineExtractor", () => {
  test("finalize with no snapshots returns 4-byte zero count", () => {
    const ext = new TimelineExtractor();
    const buf = ext.finalize();
    assert.equal(buf.length, 4);
    assert.equal(buf.readUInt32LE(0), 0);
  });

  test("encodes correct tick count", () => {
    const ext = new TimelineExtractor();
    ext.onSnapshot(makeSnapshot(0, 2));
    ext.onSnapshot(makeSnapshot(1, 1));
    ext.onSnapshot(makeSnapshot(2, 0));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 3);
  });

  test("each entry is 20 bytes (seq+ts+changed+total)", () => {
    const ext = new TimelineExtractor();
    ext.onSnapshot(makeSnapshot(0, 1));
    const buf = ext.finalize();
    // header(4) + 1 entry(20) = 24 bytes
    assert.equal(buf.length, 24);
  });

  test("seq and changedPages are recorded correctly", () => {
    const ext = new TimelineExtractor();
    ext.onSnapshot(makeSnapshot(5, 3));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(4), 5);   // seq
    // timestamp at offset 8 (uint64 LE) — skip
    assert.equal(buf.readUInt32LE(16), 3);  // changedPages
  });

  test("totalByteLength is recorded correctly", () => {
    const ext = new TimelineExtractor();
    ext.onSnapshot(makeSnapshot(0, 1));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(20), 131072); // totalByteLength
  });
});
