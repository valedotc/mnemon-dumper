import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher } from "../dispatcher.js";
import type { Snapshot } from "../extractors/types.js";
import type { ActiveExtractor } from "../dispatcher.js";
import { SILENT } from "../logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collector extractor — records every snapshot it receives. */
function makeCollector(): { extractor: ActiveExtractor; received: Snapshot[] } {
  const received: Snapshot[] = [];
  const extractor: ActiveExtractor = {
    sectionId: 0,
    extractor: {
      onSnapshot(s: Snapshot) { received.push(s); },
      finalize() { return Buffer.alloc(0); },
    },
  };
  return { extractor, received };
}

function makeDispatcher(received: Snapshot[]): Dispatcher {
  const collector = makeCollector();
  // Replace the inner received array reference to use the caller's array.
  const dispatcher = new Dispatcher(
    [{
      sectionId: 0,
      extractor: {
        onSnapshot(s: Snapshot) { received.push(s); },
        finalize() { return Buffer.alloc(0); },
      },
    }],
    null,
    SILENT,
  );
  return dispatcher;
}

interface ChunkOpts {
  offset?: number;
  /** Fill byte for the first 64 bytes (enough to produce a distinct fingerprint). */
  fillByte?: number;
}

/** Creates a base64-encoded 64-byte chunk with the given fill byte. */
function makeChunk(opts: ChunkOpts = {}): { offset: number; data: string } {
  return {
    offset: opts.offset ?? 0,
    data: Buffer.alloc(64, opts.fillByte ?? 0xaa).toString("base64"),
  };
}

interface RawOpts {
  index?: number;
  timestamp?: number;
  totalByteLength?: number;
  byteLength?: number;
  isBase?: boolean;
  batchIndex?: number;
  batchCount?: number;
  chunks?: Array<{ offset: number; data: string }>;
}

function makeRaw(opts: RawOpts = {}): string {
  return JSON.stringify({
    index: opts.index ?? 0,
    timestamp: opts.timestamp ?? 1_000,
    totalByteLength: opts.totalByteLength ?? 65_536,
    byteLength: opts.byteLength ?? 64,
    isBase: opts.isBase ?? false,
    batchIndex: opts.batchIndex ?? 0,
    batchCount: opts.batchCount ?? 1,
    chunks: opts.chunks ?? [makeChunk()],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Dispatcher", () => {
  describe("basic dispatch", () => {
    test("base snapshot is forwarded to extractor", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      dispatcher.handleSnapshot(makeRaw({ isBase: true, timestamp: 1_000 }));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.isBase, true);
      assert.equal(received[0]!.seq, 0);
    });

    test("delta snapshot is forwarded to extractor", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      dispatcher.handleSnapshot(makeRaw({ isBase: false, timestamp: 1_000 }));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.isBase, false);
    });

    test("seq increments across snapshots", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      dispatcher.handleSnapshot(makeRaw({ timestamp: 1_000, chunks: [makeChunk({ fillByte: 0xaa })] }));
      dispatcher.handleSnapshot(makeRaw({ timestamp: 1_500, chunks: [makeChunk({ fillByte: 0xbb })] }));

      assert.equal(received.length, 2);
      assert.equal(received[0]!.seq, 0);
      assert.equal(received[1]!.seq, 1);
    });

    test("chunk data is correctly decoded from base64", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const raw = Buffer.alloc(64, 0xcd);

      dispatcher.handleSnapshot(makeRaw({
        chunks: [{ offset: 128, data: raw.toString("base64") }],
      }));

      assert.equal(received[0]!.chunks[0]!.offset, 128);
      assert.deepEqual(received[0]!.chunks[0]!.data, raw);
    });
  });

  describe("SharedArrayBuffer dedup — same tick", () => {
    test("two identical payloads at the same timestamp: only one is dispatched", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const raw = makeRaw({ timestamp: 1_000, chunks: [makeChunk({ fillByte: 0xbb })] });

      dispatcher.handleSnapshot(raw);
      dispatcher.handleSnapshot(raw); // simulates second worker sending the exact same data

      assert.equal(received.length, 1);
    });

    test("three workers sharing same memory: two are deduped", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const raw = makeRaw({ timestamp: 2_000, isBase: true, chunks: [makeChunk({ fillByte: 0x01 })] });

      dispatcher.handleSnapshot(raw);
      dispatcher.handleSnapshot(raw);
      dispatcher.handleSnapshot(raw);

      assert.equal(received.length, 1);
    });
  });

  describe("cross-tick dedup regression", () => {
    // REGRESSION: before the timestamp-keyed fingerprint fix, snapshots whose
    // chunk count and first-32-bytes happened to match a previously-seen
    // snapshot would be silently dropped even from a different tick.  This
    // caused a CryptoNight miner capture to save only 3 snapshots over 30 s.

    test("same content at different timestamps: both snapshots are dispatched", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const chunk = makeChunk({ fillByte: 0xcc });

      dispatcher.handleSnapshot(makeRaw({ timestamp: 1_000, chunks: [chunk] }));
      // 500 ms later — miner has run but page 0 starts with the same bytes
      dispatcher.handleSnapshot(makeRaw({ timestamp: 1_500, chunks: [chunk] }));

      assert.equal(received.length, 2, "cross-tick snapshots must never be deduped");
    });

    test("many ticks with same chunk structure are all dispatched", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const chunk = makeChunk({ fillByte: 0xdd });

      for (let t = 0; t < 10; t++) {
        dispatcher.handleSnapshot(makeRaw({ timestamp: 1_000 + t * 500, chunks: [chunk] }));
      }

      assert.equal(received.length, 10, "every tick must produce a snapshot");
    });

    test("empty delta (0 chunks) repeated across ticks: all dispatched", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      // Empty delta fingerprint is "D:65536:0:empty"
      for (let t = 0; t < 5; t++) {
        dispatcher.handleSnapshot(makeRaw({ timestamp: 1_000 + t * 500, chunks: [] }));
      }

      assert.equal(received.length, 5);
    });
  });

  describe("multi-batch reassembly", () => {
    test("single-batch snapshot is dispatched immediately", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      dispatcher.handleSnapshot(makeRaw({
        batchIndex: 0,
        batchCount: 1,
        chunks: [makeChunk({ offset: 0 })],
      }));

      assert.equal(received.length, 1);
    });

    test("two-batch snapshot is held until both batches arrive", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      const b0 = makeRaw({
        index: 0, timestamp: 3_000, totalByteLength: 131_072,
        batchIndex: 0, batchCount: 2,
        chunks: [makeChunk({ offset: 0, fillByte: 0x11 })],
      });
      const b1 = makeRaw({
        index: 0, timestamp: 3_000, totalByteLength: 131_072,
        batchIndex: 1, batchCount: 2,
        chunks: [makeChunk({ offset: 65_536, fillByte: 0x22 })],
      });

      dispatcher.handleSnapshot(b0);
      assert.equal(received.length, 0, "must not dispatch before all batches arrive");

      dispatcher.handleSnapshot(b1);
      assert.equal(received.length, 1, "must dispatch once all batches arrive");
      assert.equal(received[0]!.chunks.length, 2);
    });

    test("batches are assembled in order regardless of arrival order", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);

      const b0 = makeRaw({
        index: 0, timestamp: 4_000, totalByteLength: 131_072,
        batchIndex: 0, batchCount: 2,
        chunks: [makeChunk({ offset: 0, fillByte: 0x33 })],
      });
      const b1 = makeRaw({
        index: 0, timestamp: 4_000, totalByteLength: 131_072,
        batchIndex: 1, batchCount: 2,
        chunks: [makeChunk({ offset: 65_536, fillByte: 0x44 })],
      });

      // Arrive out of order
      dispatcher.handleSnapshot(b1);
      dispatcher.handleSnapshot(b0);

      assert.equal(received.length, 1);
      // Chunk at offset 0 must come first
      assert.equal(received[0]!.chunks[0]!.offset, 0);
      assert.equal(received[0]!.chunks[1]!.offset, 65_536);
    });
  });

  describe("fingerprint pruning", () => {
    test("fingerprint from >2s ago is pruned and does not suppress a new snapshot", () => {
      const received: Snapshot[] = [];
      const dispatcher = makeDispatcher(received);
      const chunk = makeChunk({ fillByte: 0xee });

      // T=1000: first snapshot
      dispatcher.handleSnapshot(makeRaw({ timestamp: 1_000, chunks: [chunk] }));
      // T=3100: same content, but >2 s later — pruning must have cleared T=1000's fp
      dispatcher.handleSnapshot(makeRaw({ timestamp: 3_100, chunks: [chunk] }));
      // T=3100 again from a second worker (same tick) — this one should be deduped
      dispatcher.handleSnapshot(makeRaw({ timestamp: 3_100, chunks: [chunk] }));

      assert.equal(received.length, 2, "T=1000 and T=3100 are distinct; T=3100 duplicate is deduped");
    });
  });
});
