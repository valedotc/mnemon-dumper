import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MetadataExtractor } from "../../extractors/metadata.js";

describe("MetadataExtractor", () => {
  test("finalize with no instances returns non-empty buffer (header only)", () => {
    const ext = new MetadataExtractor();
    ext.setSessionInfo("https://example.com", 1000, 2000);
    const buf = ext.finalize();
    assert.ok(buf.length > 0);
  });

  test("encodes url length and url bytes", () => {
    const ext = new MetadataExtractor();
    ext.setSessionInfo("https://example.com", 1000, 2000);
    const buf = ext.finalize();
    const urlLen = buf.readUInt16LE(0);
    const urlStr = buf.slice(2, 2 + urlLen).toString("utf8");
    assert.equal(urlStr, "https://example.com");
  });

  test("encodes instance count correctly", () => {
    const ext = new MetadataExtractor();
    ext.setSessionInfo("http://localhost", 0, 1);
    ext.onMetadata({ exports: ["memory", "add"], imports: ["env.log"], initialPages: 1, maxPages: null });
    ext.onMetadata({ exports: ["run"], imports: [], initialPages: 2, maxPages: 4 });
    const buf = ext.finalize();
    const urlLen = buf.readUInt16LE(0);
    const instanceCountOffset = 2 + urlLen + 16; // urlLen + url + startTs(8) + endTs(8)
    assert.equal(buf.readUInt32LE(instanceCountOffset), 2);
  });

  test("onSnapshot is a no-op", () => {
    const ext = new MetadataExtractor();
    ext.onSnapshot({
      seq: 0, timestamp: 1000, totalByteLength: 65536, isBase: true,
      chunks: [],
    });
    const buf = ext.finalize();
    assert.ok(buf.length > 0);
  });

  test("maxPages encoded as -1 when null", () => {
    const ext = new MetadataExtractor();
    ext.setSessionInfo("http://x", 0, 1);
    ext.onMetadata({ exports: [], imports: [], initialPages: 1, maxPages: null });
    const buf = ext.finalize();
    // Navigate to maxPages field:
    // urlLen(2) + url + startTs(8) + endTs(8) + instanceCount(4) + exportCount(4) + importCount(4) + initialPages(4)
    const urlLen = buf.readUInt16LE(0);
    const base = 2 + urlLen + 16 + 4; // after instanceCount
    const maxPagesOffset = base + 4 + 4 + 4; // exportCount + importCount + initialPages
    assert.equal(buf.readInt32LE(maxPagesOffset), -1);
  });
});
