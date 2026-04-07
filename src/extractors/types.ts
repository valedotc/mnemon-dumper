// extractors/types.ts

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
}
