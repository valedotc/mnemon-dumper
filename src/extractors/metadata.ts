// extractors/metadata.ts

import type { Extractor, Snapshot } from "./types.js";

export interface ModuleMetadata {
  exports: string[];
  imports: string[];
  initialPages: number | null;
  maxPages: number | null;
}

export class MetadataExtractor implements Extractor {
  private instances: ModuleMetadata[] = [];
  private url = "";
  private startTimestamp = 0;
  private endTimestamp = 0;

  // Called at WASM instantiation time via the saveMetadata CDP binding.
  onMetadata(data: ModuleMetadata): void {
    this.instances.push(data);
  }

  // Called by the orchestrator (index.ts) immediately before finalize().
  setSessionInfo(url: string, startTimestamp: number, endTimestamp: number): void {
    this.url = url;
    this.startTimestamp = startTimestamp;
    this.endTimestamp = endTimestamp;
  }

  // Metadata arrives at instantiation, not per-snapshot.
  onSnapshot(_snapshot: Snapshot): void {}

  // Format:
  //   urlLen:         uint16
  //   url:            utf8[urlLen]
  //   startTimestamp: uint64
  //   endTimestamp:   uint64
  //   instanceCount:  uint32
  //   per instance:
  //     exportCount: uint32, per export: length (uint16) + utf8 bytes
  //     importCount: uint32, per import: length (uint16) + utf8 bytes
  //     initialPages: int32  (-1 if null)
  //     maxPages:     int32  (-1 if null)
  finalize(): Buffer {
    const parts: Buffer[] = [];

    const urlBytes = Buffer.from(this.url, "utf8");
    const urlHeader = Buffer.allocUnsafe(2);
    urlHeader.writeUInt16LE(urlBytes.length, 0);
    parts.push(urlHeader, urlBytes);

    const timestamps = Buffer.allocUnsafe(16);
    timestamps.writeBigUInt64LE(BigInt(this.startTimestamp), 0);
    timestamps.writeBigUInt64LE(BigInt(this.endTimestamp), 8);
    parts.push(timestamps);

    const instanceCount = Buffer.allocUnsafe(4);
    instanceCount.writeUInt32LE(this.instances.length, 0);
    parts.push(instanceCount);

    for (const inst of this.instances) {
      const serializeNames = (names: string[]): void => {
        const cnt = Buffer.allocUnsafe(4);
        cnt.writeUInt32LE(names.length, 0);
        parts.push(cnt);
        for (const name of names) {
          const utf8 = Buffer.from(name, "utf8");
          const len = Buffer.allocUnsafe(2);
          len.writeUInt16LE(utf8.length, 0);
          parts.push(len, utf8);
        }
      };

      serializeNames(inst.exports);
      serializeNames(inst.imports);

      const pages = Buffer.allocUnsafe(8);
      pages.writeInt32LE(inst.initialPages ?? -1, 0);
      pages.writeInt32LE(inst.maxPages ?? -1, 4);
      parts.push(pages);
    }

    return Buffer.concat(parts);
  }
}
