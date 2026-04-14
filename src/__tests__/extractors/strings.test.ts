import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { StringsExtractor } from "../../extractors/strings.js";
import type { Snapshot } from "../../extractors/types.js";

function makeSnapshot(data: Buffer, seq = 0): Snapshot {
  return {
    seq,
    timestamp: 1000,
    totalByteLength: 65536,
    isBase: true,
    chunks: [{ offset: 0, data }],
  };
}

describe("StringsExtractor", () => {
  test("finalize with no snapshots returns 4-byte zero count", () => {
    const ext = new StringsExtractor();
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 0);
  });

  test("extracts a string of >= 8 printable ASCII chars", () => {
    const raw = Buffer.from("Hello, World! This is a test string.");
    const padded = Buffer.concat([raw, Buffer.alloc(64 - raw.length)]);
    const ext = new StringsExtractor();
    ext.onSnapshot(makeSnapshot(padded));
    const buf = ext.finalize();
    assert.ok(buf.readUInt32LE(0) >= 1, "expected at least one string");
  });

  test("ignores runs shorter than 8 chars", () => {
    // 7 printable chars followed by a null
    const data = Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x00]);
    const ext = new StringsExtractor();
    ext.onSnapshot(makeSnapshot(data));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 0);
  });

  test("deduplicates the same string across snapshots", () => {
    const str = Buffer.from("Hello World!"); // 12 chars >= 8
    const padded = Buffer.concat([str, Buffer.alloc(64 - str.length)]);
    const ext = new StringsExtractor();
    ext.onSnapshot(makeSnapshot(padded, 0));
    ext.onSnapshot(makeSnapshot(padded, 1));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 1);
  });

  test("records firstSeenSeq correctly", () => {
    const str = Buffer.from("TestString123456"); // 16 chars
    const padded = Buffer.concat([str, Buffer.alloc(64 - str.length)]);
    const ext = new StringsExtractor();
    ext.onSnapshot(makeSnapshot(padded, 7));
    const buf = ext.finalize();
    assert.equal(buf.readUInt32LE(0), 1); // 1 string
    assert.equal(buf.readUInt32LE(4), 7); // firstSeenSeq
  });
});
