// dispatcher.ts

import type { Extractor, Snapshot } from "./extractors/types.js";
import type { MetadataExtractor, ModuleMetadata } from "./extractors/metadata.js";
import { type Logger, SILENT } from "./logger.js";

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
 * Decodes raw CDP payloads, reassembles multi-batch snapshots, deduplicates
 * SharedArrayBuffer snapshots by fingerprint, and fans out to all extractors.
 */
export class Dispatcher {
  // Pending multi-batch snapshots keyed by "workerIndex:snapshotIndex"
  private pending = new Map<string, PendingSnapshot>();

  // fingerprint → seq: dedup for workers sharing the same WebAssembly.Memory
  private fingerprints = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly activeExtractors: ActiveExtractor[],
    private readonly metadataExtractor: MetadataExtractor | null,
    private readonly logger: Logger = SILENT,
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

    this.logger.vv(
      `multi-batch: batch ${data.batchIndex + 1}/${data.batchCount} arrived for key ${key}`
    );

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
    const firstBytes = rawChunks.length > 0
      ? Buffer.from(rawChunks[0]!.data, "base64").subarray(0, 32).toString("hex")
      : "empty";
    const fp = `${meta.timestamp}:${meta.isBase ? "B" : "D"}:${meta.totalByteLength}:${rawChunks.length}:${firstBytes}`;

    this.logger.vv(`fingerprint: ${fp.slice(0, 60)}`);

    if (this.fingerprints.has(fp)) {
      this.logger.vv(
        `dedup: skipping duplicate ${meta.isBase ? "base" : "delta"} snapshot` +
        ` (shared memory, seq would be ${this.seq})`
      );
      this.seq++;
      return;
    }
    this.fingerprints.set(fp, this.seq);

    // Prune stale entries (older than 2 s) to keep the map small.
    const cutoff = meta.timestamp - 2000;
    for (const key of this.fingerprints.keys()) {
      const ts = Number(key.split(":")[0]);
      if (ts < cutoff) this.fingerprints.delete(key);
    }

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
    this.logger.info(
      `[${type}] seq:${seq}  ${sizeMB}MB / ${totalMB}MB total  chunks:${rawChunks.length}`
    );

    this.logger.vvv(
      `chunks: ${chunks.map(c => `@${c.offset}+${c.data.length}`).join(" ")}`
    );

    for (const { extractor } of this.activeExtractors) {
      this.logger.vv(`extractor dispatch seq:${seq}`);
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
