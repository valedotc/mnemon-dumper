import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runSession } from "../../browser.js";
import { Dispatcher } from "../../dispatcher.js";
import { Logger } from "../../logger.js";
import type { Snapshot } from "../../extractors/types.js";

// Minimal WASM: exports only `add(i32,i32)->i32`. No memory section, no memory export.
const WASM_NO_MEMORY = Buffer.from([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01,
  0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const HTML_NO_MEMORY = `<!DOCTYPE html><html><head><title>mnemon no-memory test</title></head><body>
<script>
WebAssembly.instantiateStreaming(fetch('/wasm/no-memory.wasm'))
  .then(function(result) {
    var sum = result.instance.exports.add(1, 2);
    console.log('add(1,2)=' + sum);
  })
  .catch(function(e) { console.error('WASM load error', e); });
</script>
</body></html>`;

class SpyLogger extends Logger {
  readonly messages: Array<{ level: number; msg: string }> = [];
  constructor() { super(3); }

  override info(msg: string): void  { this.messages.push({ level: 0, msg }); }
  override warn(msg: string): void  { this.messages.push({ level: 0, msg }); }
  override error(msg: string): void { this.messages.push({ level: 0, msg }); }
  override v(msg: string):   void { this.messages.push({ level: 1, msg }); }
  override vv(msg: string):  void { this.messages.push({ level: 2, msg }); }
  override vvv(msg: string): void { this.messages.push({ level: 3, msg }); }
}

function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/wasm/no-memory.wasm") {
        res.writeHead(200, { "Content-Type": "application/wasm" });
        res.end(WASM_NO_MEMORY);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HTML_NO_MEMORY);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res()))
        ),
      });
    });
    server.on("error", reject);
  });
}

describe("Regression: WASM with no exported/imported memory", () => {
  test(
    "captures zero snapshots and emits findMemory diagnostic at -vv",
    { timeout: 40_000 },
    async () => {
      const received: Snapshot[] = [];
      const spy = new SpyLogger();

      const dispatcher = new Dispatcher(
        [{
          sectionId: 1,
          extractor: {
            onSnapshot(s: Snapshot) { received.push(s); },
            finalize() { return Buffer.alloc(0); },
          },
        }],
        null,
        spy,
      );

      const server = await startServer();
      try {
        await runSession({
          url: `http://127.0.0.1:${server.port}/`,
          duration: 3000,
          interval: 300,
          dispatcher,
          logger: spy,
        });
      } finally {
        await server.close();
      }

      assert.equal(
        received.length,
        0,
        `expected 0 snapshots for no-memory WASM, got ${received.length}`
      );

      const findMemoryLogged = spy.messages.some(
        (m) => m.msg.includes("findMemory: no Memory found")
      );
      assert.ok(
        findMemoryLogged,
        "expected findMemory diagnostic in log output.\n" +
          spy.messages.map((m) => `  [${m.level}] ${m.msg}`).join("\n")
      );
    }
  );
});
