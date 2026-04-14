import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runSession } from "../../browser.js";
import { Dispatcher } from "../../dispatcher.js";
import { SILENT } from "../../logger.js";
import type { Snapshot } from "../../extractors/types.js";

// Minimal WASM: exports `add(i32,i32)->i32` and `memory` (1 page = 64KB).
const WASM_WITH_MEMORY = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, // magic \0asm
  0x01, 0x00, 0x00, 0x00, // version 1
  // type section (id=1, size=7): 1 type (i32,i32)->i32
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // function section (id=3, size=2): func[0] = type[0]
  0x03, 0x02, 0x01, 0x00,
  // memory section (id=5, size=3): 1 memory, no max, min=1 page
  0x05, 0x03, 0x01, 0x00, 0x01,
  // export section (id=7, size=16): "add" (func 0) + "memory" (mem 0)
  0x07, 0x10, 0x02,
  0x03, 0x61, 0x64, 0x64, 0x00, 0x00,         // "add"
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, // "memory"
  // code section (id=10, size=9): add = local.get 0 + local.get 1
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// Worker script that loads WASM and writes to memory on an interval.
// Using a dedicated worker mirrors real-world usage (mining scripts, Google Earth)
// and exercises the workercreated → setupContextCDP path instead of page-level bindings.
const WORKER_SCRIPT = `
WebAssembly.instantiateStreaming(fetch('/wasm/test.wasm'))
  .then(function(result) {
    var mem = new Uint8Array(result.instance.exports.memory.buffer);
    var i = 0;
    setInterval(function() { mem[0] = (++i) & 0xff; }, 100);
  })
  .catch(function(e) { console.error('WASM load error', e); });
`;

const HTML_WITH_MEMORY = `<!DOCTYPE html><html><head><title>mnemon test</title></head><body>
<script>
new Worker('/worker.js');
</script>
</body></html>`;

function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/wasm/test.wasm") {
        res.writeHead(200, { "Content-Type": "application/wasm" });
        res.end(WASM_WITH_MEMORY);
      } else if (req.url === "/worker.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(WORKER_SCRIPT);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HTML_WITH_MEMORY);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
    server.on("error", reject);
  });
}

describe("Integration: runSession with real WASM", () => {
  test(
    "captures at least one snapshot from a page with exported memory",
    { timeout: 40_000 },
    async () => {
      const received: Snapshot[] = [];
      const dispatcher = new Dispatcher(
        [{
          sectionId: 1,
          extractor: {
            onSnapshot(s: Snapshot) { received.push(s); },
            finalize() { return Buffer.alloc(0); },
          },
        }],
        null,
        SILENT,
      );

      const server = await startServer();
      try {
        await runSession({
          url: `http://127.0.0.1:${server.port}/`,
          duration: 3000,
          interval: 300,
          dispatcher,
          logger: SILENT,
        });
      } finally {
        await server.close();
      }

      assert.ok(
        received.length > 0,
        `expected at least 1 snapshot, got ${received.length}`
      );
      assert.ok(
        received[0]!.totalByteLength > 0,
        "snapshot totalByteLength should be > 0"
      );
      assert.equal(
        received[0]!.totalByteLength,
        65536,
        "1-page WASM memory should be 65536 bytes"
      );
    }
  );
});
