// storage.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── Wire format sent by the browser hook ─────────────────────────────────────

interface ChunkData {
  offset: number;
  data: string; // base64-encoded bytes
}

interface SnapshotData {
  index: number;        // per-worker counter (resets for each memory instance)
  timestamp: number;
  totalByteLength: number;
  byteLength: number;   // bytes in this message (non-zero or changed)
  isBase: boolean;      // true → full sparse dump; false → delta (changed pages only)
  chunks: ChunkData[];
}

// ── Per-snapshot entry in analysis.json ──────────────────────────────────────

interface HighEntropyRegion {
  offset: number;
  entropy: number; // Shannon entropy in bits/byte (> 7.5 ≈ crypto computation)
}

interface SnapshotAnalysis {
  seq: number;
  timestamp: number;
  type: "base" | "delta";
  totalMemoryMB: number;
  changedChunks: number;
  byteLength: number;
  strings: string[];           // printable ASCII sequences ≥ 8 chars
  highEntropyRegions: HighEntropyRegion[]; // chunks with entropy > 7.0
  binFile: string;
  mapFile: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Shannon entropy in bits/byte for the given buffer.
 * 8.0 = perfectly random; 0.0 = all identical bytes.
 * > 7.5 strongly suggests crypto hashing / RNG output.
 */
function shannonEntropy(buf: Buffer): number {
  const freq = new Float64Array(256);
  for (const b of buf) freq[b] = (freq[b] ?? 0) + 1;
  let h = 0;
  const n = buf.length;
  for (const f of freq) {
    if (f > 0) {
      const p = f / n;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * Extracts ALL printable ASCII sequences of at least minLen characters.
 * Returns every run without filtering — callers apply their own criteria.
 */
function extractStrings(buf: Buffer, minLen = 8): string[] {
  const results: string[] = [];
  let run = "";
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) {
      run += String.fromCharCode(b);
    } else {
      if (run.length >= minLen) results.push(run);
      run = "";
    }
  }
  if (run.length >= minLen) results.push(run);
  return results;
}

/**
 * From a list of raw strings, returns only those that are likely
 * security-relevant: URLs and human-readable strings with spaces.
 *
 * URLs    — contain "://" (stratum, https, wss, etc.)
 * Readable — contain at least one space AND at least one letter
 *            AND are ≥ 20 chars (filters short noise like "0d 1e 1e")
 */
function securityStrings(strings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of strings) {
    if (seen.has(s)) continue;
    const isUrl      = s.includes("://");
    const isReadable = s.length >= 20 && /[A-Za-z]/.test(s) && s.includes(" ");
    if (isUrl || isReadable) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ── Storage class ─────────────────────────────────────────────────────────────

interface SessionMeta {
  url: string;
  interval: number;
  startTime: string;
  snapshots: SnapshotAnalysis[];
}

export class Storage {
  private sessionDir: string;
  private meta: SessionMeta;
  private seq = 0;
  // fingerprint → seq: deduplicates snapshots from workers sharing the same
  // WebAssembly.Memory via SharedArrayBuffer. Applied to both base and delta
  // snapshots — shared memory produces identical data in every worker tick.
  private fingerprints = new Map<string, number>();
  // All raw strings seen across every snapshot — written to strings.txt at finalize.
  private allRawStrings = new Set<string>();

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
    // Deduplicate snapshots from workers sharing the same WebAssembly.Memory
    // via SharedArrayBuffer — they send identical data every tick. The
    // fingerprint covers base and delta: type + totalByteLength + chunk count
    // + first 32 bytes of first chunk (or "empty" when chunks.length === 0).
    {
      const firstBytes = data.chunks.length > 0
        ? Buffer.from(data.chunks[0]!.data, "base64").subarray(0, 32).toString("hex")
        : "empty";
      const fp = `${data.isBase ? "B" : "D"}:${data.totalByteLength}:${data.chunks.length}:${firstBytes}`;
      if (this.fingerprints.has(fp)) {
        console.log(`[mnemon] [dedup] Skipping duplicate ${data.isBase ? "base" : "delta"} snapshot (shared memory, seq would be ${this.seq})`);
        this.seq++;
        return;
      }
      this.fingerprints.set(fp, this.seq);
    }

    const seq  = this.seq++;
    const type = data.isBase ? "base" : "delta";
    const base = `snapshot_${String(seq).padStart(5, "0")}_${type}`;
    const binFile = `${base}.bin`;
    const mapFile = `${base}.map.json`;

    // ── Decode chunks and build the flat binary ───────────────────────────────
    const buffers = data.chunks.map((c) => Buffer.from(c.data, "base64"));
    const flat    = Buffer.concat(buffers);
    await writeFile(join(this.sessionDir, binFile), flat);

    // ── Write offset map ──────────────────────────────────────────────────────
    // Each entry records the original WASM linear-memory offset and the chunk
    // length so analysts can reconstruct the full address space.
    const mapEntries = data.chunks.map((c, i) => ({
      offset: c.offset,
      size:   buffers[i]!.length,
    }));
    await writeFile(
      join(this.sessionDir, mapFile),
      JSON.stringify(
        { totalByteLength: data.totalByteLength, chunks: mapEntries },
        null, 2,
      ),
    );

    // ── Analysis: strings + entropy ───────────────────────────────────────────
    const allStrings: string[] = [];
    const highEntropyRegions: HighEntropyRegion[] = [];

    let pos = 0;
    for (let i = 0; i < buffers.length; i++) {
      const chunk = buffers[i]!;

      // String extraction (only on base snapshots — they have the full picture;
      // deltas catch any new strings that appear in changed pages).
      const strs = extractStrings(chunk);
      allStrings.push(...strs);

      // Entropy: flag chunks that look like active crypto computation.
      const entropy = shannonEntropy(chunk);
      if (entropy > 7.0) {
        highEntropyRegions.push({ offset: data.chunks[i]!.offset, entropy });
      }

      pos += chunk.length;
    }

    // Deduplicate strings; sort by length descending (longer strings are more
    // informative — wallet addresses, pool URLs, etc.).
    const uniqueStrings = [...new Set(allStrings)].sort((a, b) => b.length - a.length);

    // Accumulate raw strings for the per-session strings.txt dump.
    for (const s of uniqueStrings) this.allRawStrings.add(s);

    const entry: SnapshotAnalysis = {
      seq,
      timestamp: data.timestamp,
      type,
      totalMemoryMB:     Math.round(data.totalByteLength / 1024 / 1024),
      changedChunks:     data.chunks.length,
      byteLength:        data.byteLength,
      strings:           securityStrings(uniqueStrings),
      highEntropyRegions,
      binFile,
      mapFile,
    };

    this.meta.snapshots.push(entry);

    // ── Console summary ───────────────────────────────────────────────────────
    const sizeMB     = (data.byteLength / 1024 / 1024).toFixed(1);
    const totalMB    = Math.round(data.totalByteLength / 1024 / 1024);
    const hotCount   = highEntropyRegions.length;
    const strPreview = uniqueStrings.length > 0
      ? `  strings: ${uniqueStrings.slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(", ")}${uniqueStrings.length > 3 ? ` +${uniqueStrings.length - 3}` : ""}`
      : "";

    console.log(
      `[mnemon] [${type}] ${binFile}  ` +
      `${sizeMB}MB / ${totalMB}MB total  ` +
      `chunks:${data.chunks.length}  hot:${hotCount}` +
      strPreview,
    );
  }

  /**
   * Writes meta.json (raw snapshot index) and analysis.json (human-readable
   * summary: string timeline, entropy hotspots, change frequency).
   */
  async finalize(): Promise<void> {
    // ── meta.json — raw index (backward compat) ───────────────────────────────
    await writeFile(
      join(this.sessionDir, "meta.json"),
      JSON.stringify(this.meta, null, 2),
    );

    // ── analysis.json — analyst-facing summary ────────────────────────────────
    //
    // Aggregates across all snapshots:
    //   allStrings     — unique strings seen at any point, with first-seen seq
    //   entropyTimeline — per-offset entropy over time (to track active regions)
    //   changeFrequency — how many times each chunk offset changed (hot pages)

    const stringFirstSeen = new Map<string, { seq: number; timestamp: number }>();
    const entropyByOffset = new Map<number, number[]>();
    const changeCount     = new Map<number, number>();

    for (const snap of this.meta.snapshots) {
      for (const s of snap.strings) {
        if (!stringFirstSeen.has(s)) {
          stringFirstSeen.set(s, { seq: snap.seq, timestamp: snap.timestamp });
        }
      }
      for (const r of snap.highEntropyRegions) {
        if (!entropyByOffset.has(r.offset)) entropyByOffset.set(r.offset, []);
        entropyByOffset.get(r.offset)!.push(r.entropy);
        changeCount.set(r.offset, (changeCount.get(r.offset) ?? 0) + 1);
      }
    }

    // Hot pages: chunk offsets that appeared in > half the snapshots
    const totalSnaps = this.meta.snapshots.length;
    const hotPages = [...changeCount.entries()]
      .filter(([, c]) => c > totalSnaps / 2)
      .sort(([, a], [, b]) => b - a)
      .map(([offset, count]) => ({
        offset,
        hexOffset: `0x${offset.toString(16)}`,
        appearedInSnapshots: count,
        avgEntropy: (
          (entropyByOffset.get(offset) ?? [0]).reduce((a, b) => a + b, 0) /
          (entropyByOffset.get(offset)?.length ?? 1)
        ).toFixed(3),
      }));

    const allStringsAnnotated = [...stringFirstSeen.entries()]
      .sort(([, a], [, b]) => b.seq - a.seq) // most recent first
      .map(([str, meta]) => ({ string: str, firstSeenSeq: meta.seq, timestamp: meta.timestamp }));

    // Per-seq count of strings seen for the first time in that snapshot.
    const newStringsPerSeq = new Map<number, number>();
    for (const [, meta] of stringFirstSeen) {
      newStringsPerSeq.set(meta.seq, (newStringsPerSeq.get(meta.seq) ?? 0) + 1);
    }

    const analysis = {
      url:          this.meta.url,
      interval:     this.meta.interval,
      startTime:    this.meta.startTime,
      snapshotCount: totalSnaps,
      // Strings found anywhere in memory across all snapshots.
      // Long strings are more interesting — wallet addresses, pool URLs, etc.
      strings: allStringsAnnotated,
      // Memory regions with consistently high entropy (> 7.0 bits/byte).
      // These are likely active computation areas (hash state, work buffers).
      hotHighEntropyPages: hotPages,
      // Per-snapshot summary for timeline analysis.
      timeline: this.meta.snapshots.map((s) => ({
        seq:            s.seq,
        timestamp:      s.timestamp,
        type:           s.type,
        changedChunks:  s.changedChunks,
        bytesMB:        (s.byteLength / 1024 / 1024).toFixed(2),
        hotChunks:      s.highEntropyRegions.length,
        newStrings:     newStringsPerSeq.get(s.seq) ?? 0,
      })),
    };

    await writeFile(
      join(this.sessionDir, "analysis.json"),
      JSON.stringify(analysis, null, 2),
    );

    // strings.txt — all raw printable strings seen in memory, one per line,
    // sorted by length descending. Search with: grep -i "pool\|wallet\|stratum"
    const rawSorted = [...this.allRawStrings].sort((a, b) => b.length - a.length);
    await writeFile(
      join(this.sessionDir, "strings.txt"),
      rawSorted.join("\n") + "\n",
    );

    console.log(`[mnemon] Session saved to ${this.sessionDir}`);
    console.log(
      `[mnemon] analysis.json: ` +
      `${totalSnaps} snapshots, ` +
      `${allStringsAnnotated.length} security strings, ` +
      `${hotPages.length} persistent high-entropy regions`,
    );
    console.log(`[mnemon] strings.txt: ${rawSorted.length} raw strings`);
  }
}
