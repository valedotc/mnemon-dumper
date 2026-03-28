# mnemon-dumper

WebAssembly linear memory snapshot tool for security research. Captures, diffs, and analyzes the WASM heap of any browser application over time — designed for cryptojacking detection, forensic memory analysis, and behavioral fingerprinting of WASM-based applications.

## How it works

The tool injects a JavaScript hook into every execution context of a browser session (main page, Web Workers, Service Workers) by patching the three WASM instantiation APIs before any application code runs:

- `WebAssembly.instantiate`
- `WebAssembly.instantiateStreaming`
- `new WebAssembly.Instance()`

Once a `WebAssembly.Memory` object is found, a periodic timer scans the linear memory buffer at the configured interval. Memory is divided into 64 KB pages (the native WASM page size). On each tick:

1. An XOR checksum is computed over each page using `Uint32Array` (4× faster than byte-by-byte).
2. Pages whose checksum changed since the previous tick are collected as **chunks** `{ offset, data }` where `data` is the raw page bytes encoded in base64.
3. The chunks are sent to Node.js via a Chrome DevTools Protocol (CDP) runtime binding (`saveSnapshot`), bypassing the DOM entirely.
4. Node.js decodes, writes, and analyzes each snapshot on disk.

The first snapshot from a given memory instance is a **base**: all non-zero pages are included (zero pages are copy-on-write and contain no information). Subsequent snapshots are **deltas**: only pages that changed since the last tick. This sparse+delta format keeps disk usage proportional to actual memory activity, not total allocation size.

### Shared memory deduplication

When multiple Web Workers share the same `WebAssembly.Memory` via `SharedArrayBuffer`, every worker produces identical snapshots. mnemon-dumper deduplicates both base and delta snapshots using a fingerprint (`type:totalByteLength:chunkCount:first32bytes`), so shared memory is recorded only once regardless of worker count.

---

## Modes

### Launch mode

Opens a headless Chromium instance, navigates to the target URL, and captures for the configured duration.

```bash
npm run build
node dist/index.js --url https://example.com --duration 60 --interval 1000
```

### Attach mode

Connects to an already-running Chrome instance via remote debugging. The browser stays open after the session ends, so you can browse normally while mnemon captures in the background.

Start Chrome with remote debugging enabled (a separate `--user-data-dir` is required):

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

Then run:

```bash
node dist/index.js --port 9222 --duration 60 --interval 1000
```

In attach mode, mnemon hooks all tabs already open and every new tab the user opens during the session.

### CLI arguments

| Argument | Default | Description |
|---|---|---|
| `--url <url>` | *(required in launch mode)* | Target URL |
| `--port <n>` | — | Remote debugging port (enables attach mode) |
| `--duration <seconds>` | `60` | How long to capture |
| `--interval <ms>` | `1000` | Snapshot interval |
| `--max-memory-mb <n>` | `64` | Maximum non-zero bytes to transfer per snapshot tick (cap to avoid CDP message size limits) |

---

## Output structure

Each run produces a session directory under `dumps/` named by timestamp:

```
dumps/
└── 2026-03-28_185055/
    ├── meta.json
    ├── analysis.json
    ├── strings.txt
    ├── snapshot_00000_base.bin
    ├── snapshot_00000_base.map.json
    ├── snapshot_00001_delta.bin
    ├── snapshot_00001_delta.map.json
    └── ...
```

---

### `meta.json`

Raw session index. Contains the full snapshot list with all per-snapshot metadata as recorded during capture.

```json
{
  "url": "https://example.com",
  "interval": 1000,
  "startTime": "2026-03-28T18:50:55.551Z",
  "snapshots": [
    {
      "seq": 0,
      "timestamp": 1774723873530,
      "type": "base",
      "totalMemoryMB": 32,
      "changedChunks": 12,
      "byteLength": 786432,
      "strings": ["stratum+tcp://pool.example.com:3333", "..."],
      "highEntropyRegions": [
        { "offset": 2097152, "entropy": 7.94 }
      ],
      "binFile": "snapshot_00000_base.bin",
      "mapFile": "snapshot_00000_base.map.json"
    }
  ]
}
```

Fields per snapshot entry:

| Field | Description |
|---|---|
| `seq` | Global sequence number for this session |
| `timestamp` | Unix millisecond timestamp from inside the browser |
| `type` | `"base"` (first snapshot, all non-zero pages) or `"delta"` (only changed pages) |
| `totalMemoryMB` | Total WASM linear memory size in MB at capture time |
| `changedChunks` | Number of 64 KB pages included in this snapshot |
| `byteLength` | Total bytes transferred in this snapshot (changedChunks × up to 65536) |
| `strings` | Security-filtered strings found in memory (URLs and readable phrases — see below) |
| `highEntropyRegions` | Chunks with Shannon entropy > 7.0 bits/byte, with their memory offset |
| `binFile` | Filename of the flat binary for this snapshot |
| `mapFile` | Filename of the offset map for this snapshot |

---

### `analysis.json`

Analyst-facing aggregated summary built from all snapshots in the session. This is the primary file for behavioral analysis.

```json
{
  "url": "https://example.com",
  "interval": 1000,
  "startTime": "2026-03-28T18:50:55.551Z",
  "snapshotCount": 20,
  "strings": [ ... ],
  "hotHighEntropyPages": [ ... ],
  "timeline": [ ... ]
}
```

#### `strings`

All security-relevant strings found in WASM memory across the entire session, annotated with when they first appeared. A string qualifies as security-relevant if it is:

- A **URL**: contains `://` (covers `stratum+tcp://`, `https://`, `wss://`, etc.)
- **Human-readable**: at least 20 characters, contains a space, contains at least one letter (filters binary noise and short hex sequences)

Sorted by most recently first-seen (new strings appearing late in the session are often the most interesting).

```json
"strings": [
  {
    "string": "stratum+tcp://pool.minexmr.com:4444",
    "firstSeenSeq": 3,
    "timestamp": 1774723876186
  },
  {
    "string": "4BGGo3R1dNFhVS3wEqwwkaPyZ5AdmncvJRbYVFXh5T7msdWRzgFG1gVFkW8zXfMiYkMK",
    "firstSeenSeq": 3,
    "timestamp": 1774723876186
  }
]
```

#### `hotHighEntropyPages`

Memory pages (64 KB chunks) with Shannon entropy consistently above 7.0 bits/byte across more than half of all snapshots. Entropy above 7.5 bits/byte strongly suggests active cryptographic computation (hash state, work buffers, RNG output). Pages that appear once and disappear are excluded — only pages that remain hot throughout the session are listed.

```json
"hotHighEntropyPages": [
  {
    "offset": 2097152,
    "hexOffset": "0x200000",
    "appearedInSnapshots": 18,
    "avgEntropy": "7.923"
  }
]
```

| Field | Description |
|---|---|
| `offset` | Byte offset in WASM linear memory |
| `hexOffset` | Same offset in hex (easier to match against WASM source maps) |
| `appearedInSnapshots` | How many snapshots included this page as a high-entropy region |
| `avgEntropy` | Average Shannon entropy across all snapshots where it appeared (bits/byte, max 8.0) |

#### `timeline`

Per-snapshot summary for behavioral analysis. This is the most important section for cryptojacking detection: a legitimate application shows activity that decays to zero as it finishes loading, while a miner maintains a flat non-zero baseline indefinitely.

```json
"timeline": [
  { "seq": 0,  "timestamp": 1774723873530, "type": "base",  "changedChunks": 459, "bytesMB": "28.69", "hotChunks": 7, "newStrings": 312 },
  { "seq": 1,  "timestamp": 1774723876186, "type": "delta", "changedChunks": 115, "bytesMB": "7.19",  "hotChunks": 2, "newStrings": 84  },
  { "seq": 2,  "timestamp": 1774723879213, "type": "delta", "changedChunks": 129, "bytesMB": "8.06",  "hotChunks": 1, "newStrings": 5   },
  { "seq": 8,  "timestamp": 1774723885024, "type": "delta", "changedChunks": 0,   "bytesMB": "0.00",  "hotChunks": 0, "newStrings": 0   },
  { "seq": 9,  "timestamp": 1774723888000, "type": "delta", "changedChunks": 0,   "bytesMB": "0.00",  "hotChunks": 0, "newStrings": 0   }
]
```

| Field | Description |
|---|---|
| `seq` | Snapshot sequence number |
| `timestamp` | Unix ms timestamp |
| `type` | `"base"` or `"delta"` |
| `changedChunks` | Number of 64 KB pages that changed since the previous tick |
| `bytesMB` | Total bytes in this snapshot in MB |
| `hotChunks` | Number of chunks with entropy > 7.0 in this snapshot |
| `newStrings` | Number of security strings seen for the **first time** in this snapshot (not repeated from earlier snapshots) |

---

### `strings.txt`

All raw printable ASCII strings (≥ 8 characters) found in WASM memory across the entire session, one per line, sorted by length descending. This is the unfiltered companion to the `strings` section of `analysis.json` and is intended for manual grep-based investigation.

```bash
# Search for mining pool indicators
grep -iE "stratum|pool\.|mining|xmr|monero" dumps/SESSION/strings.txt

# Search for Ethereum wallet addresses
grep -E "0x[0-9a-fA-F]{40}" dumps/SESSION/strings.txt

# Search for Monero wallet addresses (95-char base58)
grep -E "[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}" dumps/SESSION/strings.txt
```

---

### `snapshot_NNNNN_<type>.bin`

Flat binary file containing the raw bytes of the changed pages, concatenated in the order they appear in the corresponding `.map.json`. To reconstruct the original address space, use the map file to place each chunk at its correct offset.

This file is the source material for:
- Binary diffing between snapshots (e.g. with `radiff2` or `vbindiff`)
- Pattern matching for known algorithm signatures (RandomX scratchpad, CryptoNight hash state)
- Entropy visualization per region

### `snapshot_NNNNN_<type>.map.json`

Offset map for the corresponding `.bin` file. Maps each consecutive chunk in the binary to its original byte offset in WASM linear memory.

```json
{
  "totalByteLength": 536870912,
  "chunks": [
    { "offset": 65536,   "size": 65536 },
    { "offset": 196608,  "size": 65536 },
    { "offset": 4259840, "size": 65536 }
  ]
}
```

`totalByteLength` is the full size of the WASM linear memory at capture time (including unallocated/zero pages that were not transferred). The chunks array contains only the pages that were actually captured.

---

## Cryptojacking detection

The behavioral signature of a WASM cryptominer is distinct from any legitimate application:

| Signal | Legitimate app | Cryptominer |
|---|---|---|
| `changedChunks` over time | Decays to 0 after loading | Never reaches 0, stable 1–20/tick |
| `hotChunks` (entropy > 7.0) | Transient, only during computation | Persistent throughout the session |
| `newStrings` | Concentrated in early snapshots | May appear mid-session (pool reconnect, wallet rotation) |
| `strings` content | API endpoints, feature flags, shader source | `stratum://`, pool hostnames, wallet addresses |
| `hotHighEntropyPages` offsets | Vary, no fixed pattern | Fixed offsets (algorithm scratchpad has a known size and alignment) |

A session where `changedChunks` never drops to zero, `hotChunks` remains non-zero across every delta, and `strings.txt` contains a `stratum` URL is a strong positive signal for in-browser mining.
