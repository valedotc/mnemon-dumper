// dispatcher.ts

import type { Extractor, Snapshot } from "./extractors/types.js";
import type { MetadataExtractor, ModuleMetadata } from "./extractors/metadata.js";

// Wire format sent by the browser hook
interface RawChunkData {
  offset: number;
  data: string; // base64-encoded
}

interface RawSnapshotData {
  index: number;
  timestamp: number;
  totalByteLength: number;
  byteLength: number;
  isBase: boolean;
  batchIndex: number; // 0-based index of this batch within the snapshot
  batchCount: number; // total number of batches for this snapshot (1 = no split)
  chunks: RawChunkData[];
}

export interface ActiveExtractor {
  sectionId: number;
  extractor: Extractor;
}

// Accumulator for in-flight multi-batch snapshots
interface PendingSnapshot {
  meta: Omit<RawSnapshotData, "chunks" | "batchIndex">;
  received: Map<number, RawChunkData[]>; // batchIndex → chunks
}

/**
 * Decodes raw CDP payloads, reassembles multi-batch snapshots (large memories
 * split into 32-page / ~2 MB CDP messages), deduplicates SharedArrayBuffer
 * snapshots by fingerprint, and fans out to all registered extractors.
 */
export class Dispatcher {
  // Pending multi-batch snapshots keyed by "workerIndex:snapshotIndex"
  private pending = new Map<string, PendingSnapshot>();

  // fingerprint → seq: dedup for workers sharing the same WebAssembly.Memory
  // via SharedArrayBuffer. Fingerprint: type:totalByteLength:chunkCount:first32bytes
  private fingerprints = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly activeExtractors: ActiveExtractor[],
    private readonly metadataExtractor: MetadataExtractor | null,
  ) {}

  handleSnapshot(rawPayload: string): void {
    let data: RawSnapshotData;
    try {
      data = JSON.parse(rawPayload) as RawSnapshotData;
    } catch {
      return;
    }

    // Single-batch fast path (most small WASM modules)
    if (data.batchCount === 1) {
      this.dispatch(data, data.chunks);
      return;
    }

    // Multi-batch: accumulate until all pieces arrive
    // Key includes totalByteLength to disambiguate different WASM instances
    // that happen to produce the same index+timestamp in the same tick.
    const key = `${data.index}:${data.timestamp}:${data.totalByteLength}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = {
        meta: {
          index:           data.index,
          timestamp:       data.timestamp,
          totalByteLength: data.totalByteLength,
          byteLength:      data.byteLength,
          isBase:          data.isBase,
          batchCount:      data.batchCount,
        },
        received: new Map(),
      };
      this.pending.set(key, pending);
    }
    pending.received.set(data.batchIndex, data.chunks);

    if (pending.received.size < data.batchCount) return; // still waiting

    // All batches received — assemble in order and dispatch
    const allChunks: RawChunkData[] = [];
    for (let b = 0; b < data.batchCount; b++) {
      const batch = pending.received.get(b);
      if (batch) allChunks.push(...batch);
    }
    this.pending.delete(key);
    this.dispatch(pending.meta as RawSnapshotData, allChunks);
  }

  private dispatch(meta: RawSnapshotData, rawChunks: RawChunkData[]): void {
    // Fingerprint-based dedup (SharedArrayBuffer workers send identical data)
    const firstBytes = rawChunks.length > 0
      ? Buffer.from(rawChunks[0]!.data, "base64").subarray(0, 32).toString("hex")
      : "empty";
    const fp = `${meta.isBase ? "B" : "D"}:${meta.totalByteLength}:${rawChunks.length}:${firstBytes}`;

    if (this.fingerprints.has(fp)) {
      console.log(
        `[mnemon] [dedup] Skipping duplicate ${meta.isBase ? "base" : "delta"} snapshot` +
        ` (shared memory, seq would be ${this.seq})`,
      );
      this.seq++;
      return;
    }
    this.fingerprints.set(fp, this.seq);

    const seq = this.seq++;

    // Decode base64 chunks once — all extractors share the same Buffer refs
    const chunks = rawChunks.map((c) => ({
      offset: c.offset,
      data: Buffer.from(c.data, "base64"),
    }));

    const snapshot: Snapshot = {
      seq,
      timestamp:       meta.timestamp,
      totalByteLength: meta.totalByteLength,
      isBase:          meta.isBase,
      chunks,
    };

    const type    = meta.isBase ? "base" : "delta";
    const sizeMB  = (meta.byteLength / 1024 / 1024).toFixed(1);
    const totalMB = Math.round(meta.totalByteLength / 1024 / 1024);
    console.log(
      `[mnemon] [${type}] seq:${seq}  ${sizeMB}MB / ${totalMB}MB total  chunks:${rawChunks.length}`,
    );

    for (const { extractor } of this.activeExtractors) {
      extractor.onSnapshot(snapshot);
    }
  }

  handleMetadata(rawPayload: string): void {
    if (!this.metadataExtractor) return;
    try {
      const data = JSON.parse(rawPayload) as ModuleMetadata;
      this.metadataExtractor.onMetadata(data);
    } catch {
      // Malformed payload — ignore
    }
  }
}
