export function getHookScript(intervalMs: number, maxBytes: number): string {
  return `
    (function() {

      const originalInstantiate = WebAssembly.instantiate;
      const originalInstantiateStreaming = WebAssembly.instantiateStreaming;

      function findMemory(instance, importObject) {
        for (const value of Object.values(instance.exports)) {
          if (value instanceof WebAssembly.Memory) return value;
        }
        if (importObject) {
          for (const mod of Object.values(importObject)) {
            if (mod && typeof mod === "object") {
              for (const value of Object.values(mod)) {
                if (value instanceof WebAssembly.Memory) return value;
              }
            }
          }
        }
        return null;
      }

      function toBase64(bytes) {
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      }

      /**
       * XOR checksum of a 64 KB page via Uint32Array (4x faster than byte-by-byte).
       * Used to detect which pages changed between ticks without storing full copies.
       */
      function pageChecksum(full, offset, end) {
        const u32 = new Uint32Array(full.buffer, full.byteOffset + offset, (end - offset) >> 2);
        let xor = 0;
        for (let i = 0; i < u32.length; i++) xor ^= u32[i];
        return xor;
      }

      function startDumping(memory) {
        const PAGE     = 65536;  // 64 KB — WASM page size
        const MAX_BYTES = ${maxBytes};

        // prevChecksums[i] = XOR checksum of page i in the previous tick.
        // Initialised to 0 so the first tick behaves like a full diff: every
        // non-zero page differs from 0 and is included in the base snapshot.
        let prevChecksums = null;
        let snapshotIndex = 0;

        setInterval(() => {
          const full  = new Uint8Array(memory.buffer);
          const nPages = Math.ceil(full.length / PAGE);

          if (prevChecksums === null) {
            prevChecksums = new Int32Array(nPages); // all 0
          }

          const isBase = (snapshotIndex === 0);
          const chunks  = [];
          let totalData = 0;

          for (let p = 0; p < nPages && totalData < MAX_BYTES; p++) {
            const offset = p * PAGE;
            const end    = Math.min(offset + PAGE, full.length);
            const csum   = pageChecksum(full, offset, end);

            // Base: include all non-zero pages (csum !== 0 means at least one
            //       non-zero uint32 → differs from the zeroed prevChecksums).
            // Delta: include any page whose checksum changed since last tick,
            //        including pages that went from non-zero back to zero.
            if (csum !== prevChecksums[p]) {
              chunks.push({ offset, data: toBase64(full.subarray(offset, end)) });
              totalData += (end - offset);
            }

            prevChecksums[p] = csum;
          }

          saveSnapshot(JSON.stringify({
            index:           snapshotIndex,
            timestamp:       Date.now(),
            totalByteLength: full.length,
            byteLength:      totalData,
            isBase,
            chunks,
          }));

          snapshotIndex++;
        }, ${intervalMs});
      }

      // ── Patch WebAssembly.Instance (sync constructor) ──────────────────────
      const OriginalInstance = WebAssembly.Instance;
      WebAssembly.Instance = function(module, importObject) {
        const instance = new OriginalInstance(module, importObject);
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return instance;
      };
      WebAssembly.Instance.prototype = OriginalInstance.prototype;

      // ── Patch WebAssembly.instantiate ──────────────────────────────────────
      WebAssembly.instantiate = async function(source, importObject) {
        const result = await originalInstantiate.call(this, source, importObject);
        const instance = result.instance || result;
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return result;
      };

      // ── Patch WebAssembly.instantiateStreaming ─────────────────────────────
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        const result = await originalInstantiateStreaming.call(this, source, importObject);
        const instance = result.instance || result;
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return result;
      };

      console.log("[mnemon] Hook installed");
    })();
  `;
}
