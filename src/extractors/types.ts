// extractors/types.ts

import type { FileHandle } from "node:fs/promises";

export interface Snapshot {
  seq: number;
  timestamp: number;
  totalByteLength: number;
  isBase: boolean;
  chunks: Array<{ offset: number; data: Buffer }>;
}

export interface Extractor {
  onSnapshot(snapshot: Snapshot): void;
  finalize(): Buffer;
  // Optional streaming finalize for sections that exceed the 2GB Buffer limit.
  // When present, the writer calls this instead of finalize(). Returns bytes written.
  finalizeToHandle?: (fh: FileHandle) => Promise<number>;
}
