# mnemon

WebAssembly linear memory capture tool for security research. Hooks WASM instantiation in a browser session, periodically snapshots the linear memory of every running WASM instance, and writes the results to a single binary `.mnem` file for offline analysis.

Mnemon is a **data collection tool only** — it does not classify, detect, or interpret what it captures.

---

## How it works

A JavaScript hook is injected into every execution context of the browser session — the main page, all dedicated Web Workers, and Service Workers — **before any application script runs**. The hook patches three WASM APIs:

- `WebAssembly.instantiate`
- `WebAssembly.instantiateStreaming`
- `new WebAssembly.Instance()`

Once a `WebAssembly.Memory` is found, a periodic timer (`setInterval`) scans the linear memory buffer at the configured interval. Memory is divided into 64 KB pages (the native WASM page size). On each tick:

1. An XOR checksum is computed over every page via `Uint32Array` (4× faster than byte-by-byte).
2. The **first tick** (seq 0) is a **base**: all pages with a non-zero checksum are included. Zero pages are copy-on-write and carry no data.
3. All **subsequent ticks** are **deltas**: only pages whose checksum changed since the previous tick are included.
4. Changed pages are base64-encoded and sent to Node.js via a Chrome DevTools Protocol binding (`saveSnapshot`), bypassing the DOM entirely.
5. A second binding (`saveMetadata`) fires once per WASM instance at instantiation time and carries the module's export/import table and memory descriptor.

Because large memories would exceed CDP message limits, the hook splits each tick's data into batches of 32 pages (~2 MB of base64 each). The Node.js dispatcher reassembles all batches for a tick before forwarding to the extractors.

### Worker timing

Workers are paused at startup via `Target.setAutoAttach` with `waitForDebuggerOnStart: true`. The hook is injected before the worker script executes; `Runtime.runIfWaitingForDebugger` resumes it afterward. This guarantees the WASM API patches are in place before any `WebAssembly.instantiate` call.

### SharedArrayBuffer deduplication

When multiple workers share the same `WebAssembly.Memory` via `SharedArrayBuffer`, every worker emits identical snapshots. Mnemon deduplicates on a fingerprint `type:totalByteLength:chunkCount:first32bytes`, so shared memory is recorded exactly once.

---

## Installation

### From npm (recommended)

```bash
npm install -g mnemon
```

### From source

```bash
npm install
npm run build
```

Requires Node.js 22+ and a Chromium-based browser.

---

## Usage

### Launch mode

Opens a headless Chromium, navigates to the URL, captures for the given duration, then exits.

```bash
node dist/index.js --url https://example.com [options]
```

### Attach mode

Connects to a running Chrome instance via remote debugging. The browser stays open after the session ends.

Start Chrome with a dedicated profile (required — Chrome refuses remote debugging on the default profile):

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --no-first-run

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug

# Windows
chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug
```

Then:

```bash
node dist/index.js --port 9222 [options]
```

### Options

| Flag               | Default                             | Description                                                                               |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `--url <url>`      | _(required in launch mode)_         | Target URL                                                                                |
| `--port <n>`       | —                                   | Remote debugging port; enables attach mode                                                |
| `--duration <s>`   | `60`                                | Capture duration in seconds                                                               |
| `--interval <ms>`  | `1000`                              | Snapshot interval in milliseconds                                                         |
| `--modules <list>` | `entropy,strings,timeline,metadata` | Comma-separated list of extractors to enable. Add `rawpages` to also store raw page bytes |
| `-o <path>`        | `./session.mnem`                    | Output file path. `.mnem` extension is added automatically if omitted                     |

### Examples

```bash
# 2-minute capture of a target site, 500 ms interval
node dist/index.js --url https://example.com --duration 120 --interval 500

# Attach to a running browser, save to a named file
node dist/index.js --port 9222 --duration 60 -o captures/earth-test

# Capture only timeline and entropy, no strings
node dist/index.js --url https://example.com --modules entropy,timeline

# Include raw page bytes (large output)
node dist/index.js --url https://example.com --modules entropy,strings,timeline,metadata,rawpages
```

---

## Output format

Every run produces a single `.mnem` binary file. The default path is `./session.mnem`; use `-o` to override.

### File layout

```
[header         — 16 bytes      ]
[section data   — variable      ]  ← one block per active extractor
[section table  — 12 bytes × N  ]  ← at sectionTableOffset
```

All integers are **little-endian**.

#### Header (16 bytes)

| Offset | Size | Field              | Value                                     |
| ------ | ---- | ------------------ | ----------------------------------------- |
| 0      | 4    | magic              | `4D 4E 45 4D` ("MNEM")                    |
| 4      | 2    | version            | `1`                                       |
| 6      | 2    | sectionCount       | number of sections                        |
| 8      | 4    | sectionTableOffset | absolute byte offset of the section table |
| 12     | 4    | reserved           | `0`                                       |

#### Section table entry (12 bytes each, at `sectionTableOffset`)

| Offset | Size | Field                                                |
| ------ | ---- | ---------------------------------------------------- |
| 0      | 4    | sectionId (uint32)                                   |
| 4      | 4    | dataOffset — absolute offset of section data in file |
| 8      | 4    | dataSize — byte length of section data               |

To read a specific section: parse the 16-byte header → seek to `sectionTableOffset` → iterate entries to find the desired `sectionId` → seek to `dataOffset`.

---

## Sections

### 0x01 — METADATA

Captured once per WASM instance at instantiation time, plus session-level info written at finalization.

```
urlLen:         uint16
url:            utf8[urlLen]
startTimestamp: uint64   ms epoch
endTimestamp:   uint64   ms epoch
instanceCount:  uint32

per instance:
  exportCount:  uint32
  per export:   nameLen (uint16) + utf8[nameLen]
  importCount:  uint32
  per import:   nameLen (uint16) + utf8[nameLen]   ← "module.name" format
  initialPages: int32   (-1 if unavailable)
  maxPages:     int32   (-1 if unavailable)
```

### 0x02 — ENTROPY

Shannon entropy (bits/byte) computed per received chunk. 0.0 = all identical bytes; 8.0 = uniform random.

```
snapshotCount: uint32

per snapshot:
  seq:       uint32
  timestamp: uint64   ms epoch
  pageCount: uint32   number of pages in this tick

  per page:
    offset:  uint32   byte offset in linear memory
    entropy: float32
```

Only chunks actually transferred (changed/non-zero pages) have entropy entries. Entropy is not computed for zero pages.

### 0x03 — STRINGS

All printable ASCII sequences ≥ 8 consecutive characters (bytes 0x20–0x7E) found in received chunks. Only the first occurrence of each unique string is recorded.

```
stringCount:    uint32

per string:
  firstSeenSeq: uint32   seq of the snapshot where this string first appeared
  memoryOffset: uint32   absolute byte offset in linear memory at firstSeenSeq
  length:       uint16   byte length of the UTF-8 value
  value:        utf8[length]
```

`memoryOffset` is `chunkBaseOffset + positionWithinChunk`.

### 0x04 — TIMELINE

One record per snapshot tick, including ticks with zero changed pages (idle deltas).

```
tickCount:      uint32

per tick:
  seq:             uint32
  timestamp:       uint64   ms epoch
  changedPages:    uint32   number of chunks transferred in this tick
  totalByteLength: uint32   total linear memory size at this tick
```

`totalByteLength` grows when the WASM module calls `memory.grow()`.

### 0x05 — RAWPAGES _(opt-in)_

Raw page bytes for every received chunk. Only enabled when `rawpages` is in `--modules`. Each chunk is exactly 65536 bytes per the WASM page spec; a warning is emitted and the chunk skipped if this invariant is violated.

```
snapshotCount: uint32

per snapshot:
  seq:        uint32
  chunkCount: uint32

  per chunk:
    offset:   uint32
    data:     bytes[65536]
```

---

## Project structure

```
src/
  index.ts              — CLI parsing, extractor wiring, session orchestration
  browser.ts            — Puppeteer launch/attach, CDP setup, hook injection
  hook.ts               — Browser-side JS: WASM API patching, periodic scanning
  dispatcher.ts         — CDP payload decoding, batch reassembly, dedup, fan-out
  extractors/
    types.ts            — Shared Snapshot and Extractor interfaces
    entropy.ts          — Shannon entropy per page
    strings.ts          — ASCII string extraction, first-seen tracking
    timeline.ts         — Per-tick change summary
    metadata.ts         — Module exports/imports, session URL and timestamps
    rawpages.ts         — Optional raw page dump
  writer/
    format.ts           — Magic, version, section ID constants, header layout
    mnemon-writer.ts    — Seek-back binary writer for .mnem files
```

---

## Known limits

| Limit                     | Detail                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CDP batch size            | 32 pages (~2 MB base64) per message. Larger memories produce multiple messages per tick; the dispatcher reassembles them before dispatch.                    |
| Batch loss                | If a CDP message is dropped (rare on loopback), that entire tick is silently discarded. Subsequent ticks are unaffected.                                     |
| `memoryOffset` in STRINGS | `uint32` — addresses up to 4 GB, sufficient for current WASM linear memory limits.                                                                           |
| Pending batch leak        | If not all batches for a tick arrive (e.g. context torn down mid-tick), the partial entry stays in the dispatcher's pending map for the rest of the session. |
