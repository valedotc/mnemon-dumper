// storage.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface SnapshotData {
  index: number;
  timestamp: number;
  byteLength: number;
  totalByteLength: number;
  base64: string;
}

interface SessionMeta {
  url: string;
  interval: number;
  startTime: string;
  snapshots: Array<{
    seq: number;
    workerIndex: number;
    timestamp: number;
    byteLength: number;
    totalByteLength: number;
    filename: string;
  }>;
}

export class Storage {
  private sessionDir: string;
  private meta: SessionMeta;
  // Global sequence counter shared across all workers/contexts.
  // Prevents filename collisions when multiple workers call saveSnapshot
  // simultaneously with the same per-worker index.
  private seq = 0;

  constructor(
    outputDir: string,
    sessionId: string,
    url: string,
    interval: number,
  ) {
    this.sessionDir = join(outputDir, sessionId);
    this.meta = {
      url,
      interval,
      startTime: new Date().toISOString(),
      snapshots: [],
    };
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async saveSnapshot(data: SnapshotData): Promise<void> {
    const seq = this.seq++;
    const filename = `snapshot_${String(seq).padStart(5, "0")}.bin`;
    const filepath = join(this.sessionDir, filename);

    const buffer = Buffer.from(data.base64, "base64");
    await writeFile(filepath, buffer);

    this.meta.snapshots.push({
      seq,
      workerIndex: data.index,
      timestamp: data.timestamp,
      byteLength: data.byteLength,
      totalByteLength: data.totalByteLength ?? data.byteLength,
      filename,
    });

    const truncated = data.totalByteLength > data.byteLength
      ? ` (truncated from ${(data.totalByteLength / 1024 / 1024).toFixed(0)}MB)`
      : "";
    console.log(`[mnemon] Saved ${filename} (${(data.byteLength / 1024 / 1024).toFixed(1)}MB${truncated})`);
  }

  async finalize(): Promise<void> {
    const metaPath = join(this.sessionDir, "meta.json");
    await writeFile(metaPath, JSON.stringify(this.meta, null, 2));
    console.log(`[mnemon] Session saved to ${this.sessionDir}`);
  }
}
