import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EntropyExtractor } from "../../extractors/entropy.js";
import type { Snapshot } from "../../extractors/types.js";

function makeSnapshot(fillByte: number, seq = 0): Snapshot {
  return {
    seq,
    timestamp: 1000 + seq,
    totalByteLength: 65536,
    isBase: seq === 0,
    chunks: [{ offset: 0, data: Buffer.alloc(64, fillByte) }],
  };
}

describe("EntropyExtractor", () => {
  test("finalize with no snapshots returns 4-byte zero count", () => {
    const ext = new EntropyExtractor();
    const buf = ext.finalize();
    assert.equal(buf.length, 4);
    assert.equal(buf.readUInt32LE(0), 0);
  });

  test("finalize with one snapshot encodes snapshotCount=1", () => {
    const ext = new EntropyExtractor();
    ext.onSnapshot(makeSnapshot(0xaa));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 1); // snapshotCount
  });

  test("uniform byte buffer has entropy ~0", () => {
    const ext = new EntropyExtractor();
    ext.onSnapshot(makeSnapshot(0xff)); // all same byte → H=0
    const buf = ext.finalize();
    // layout: snapshotCount(4) + seq(4) + timestamp(8) + pageCount(4) + page[offset(4) + entropy(4)]
    const entropyOffset = 4 + 4 + 8 + 4 + 4; // skip to entropy float
    const entropy = buf.readFloatLE(entropyOffset);
    assert.ok(Math.abs(entropy) < 0.001, `expected ~0, got ${entropy}`);
  });

  test("buffer with 2 distinct bytes has entropy > 0 and <= 8", () => {
    const data = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) data[i] = i % 2 === 0 ? 0x00 : 0xff;
    const ext = new EntropyExtractor();
    ext.onSnapshot({
      seq: 0, timestamp: 1000, totalByteLength: 65536, isBase: true,
      chunks: [{ offset: 0, data }],
    });
    const buf = ext.finalize();
    const entropyOffset = 4 + 4 + 8 + 4 + 4;
    const entropy = buf.readFloatLE(entropyOffset);
    assert.ok(entropy > 0 && entropy <= 8, `entropy=${entropy} out of range`);
  });

  test("multiple snapshots all encoded in output", () => {
    const ext = new EntropyExtractor();
    ext.onSnapshot(makeSnapshot(0x11, 0));
    ext.onSnapshot(makeSnapshot(0x22, 1));
    ext.onSnapshot(makeSnapshot(0x33, 2));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 3);
  });
});
