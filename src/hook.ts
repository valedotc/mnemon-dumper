export function getHookScript(intervalMs: number): string {
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

      // WeakMap to capture Memory descriptors (initial/maximum pages) at
      // construction time, before we can inspect them at instantiation.
      const memoryDescriptors = new WeakMap();
      const OriginalMemory = WebAssembly.Memory;
      WebAssembly.Memory = function(descriptor) {
        const mem = new OriginalMemory(descriptor);
        if (descriptor) memoryDescriptors.set(mem, descriptor);
        return mem;
      };
      WebAssembly.Memory.prototype = OriginalMemory.prototype;

      function extractAndSendMetadata(instance, importObject) {
        const memory = findMemory(instance, importObject);

        // Flatten imports to "modName.importName" strings
        const imports = [];
        if (importObject) {
          for (const [modName, mod] of Object.entries(importObject)) {
            if (mod && typeof mod === "object") {
              for (const name of Object.keys(mod)) {
                imports.push(modName + "." + name);
              }
            }
          }
        }

        const descriptor = memory ? memoryDescriptors.get(memory) : null;
        const initialPages = descriptor?.initial ?? (memory ? memory.buffer.byteLength / 65536 : null);
        const maxPages = descriptor?.maximum ?? null;

        saveMetadata(JSON.stringify({
          exports: Object.keys(instance.exports || {}),
          imports,
          initialPages,
          maxPages,
        }));
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
       */
      function pageChecksum(full, offset, end) {
        const u32 = new Uint32Array(full.buffer, full.byteOffset + offset, (end - offset) >> 2);
        let xor = 0;
        for (let i = 0; i < u32.length; i++) xor ^= u32[i];
        return xor;
      }

      function startDumping(memory) {
        const PAGE = 65536;       // 64 KB — WASM page size
        const CHUNKS_PER_MSG = 32; // 32 × 64 KB ≈ 2 MB of base64 per CDP message — safe transport limit

        let prevChecksums = null;
        let snapshotIndex = 0;

        setInterval(() => {
          const full   = new Uint8Array(memory.buffer);
          const nPages = Math.ceil(full.length / PAGE);

          if (prevChecksums === null) {
            prevChecksums = new Int32Array(nPages); // all 0
          }

          const isBase    = (snapshotIndex === 0);
          const timestamp = Date.now();
          const chunks    = [];
          let totalData   = 0;

          for (let p = 0; p < nPages; p++) {
            const offset = p * PAGE;
            const end    = Math.min(offset + PAGE, full.length);
            const csum   = pageChecksum(full, offset, end);

            if (csum !== prevChecksums[p]) {
              chunks.push({ offset, data: toBase64(full.subarray(offset, end)) });
              totalData += (end - offset);
            }

            prevChecksums[p] = csum;
          }

          // Split chunks into batches to stay within CDP payload limits.
          // The dispatcher reassembles all batches before forwarding to extractors.
          const batchCount = Math.max(1, Math.ceil(chunks.length / CHUNKS_PER_MSG));
          for (let b = 0; b < batchCount; b++) {
            saveSnapshot(JSON.stringify({
              index:           snapshotIndex,
              timestamp,
              totalByteLength: full.length,
              byteLength:      totalData,
              isBase,
              batchIndex:      b,
              batchCount,
              chunks:          chunks.slice(b * CHUNKS_PER_MSG, (b + 1) * CHUNKS_PER_MSG),
            }));
          }

          snapshotIndex++;
        }, ${intervalMs});
      }

      // ── Patch WebAssembly.Instance (sync constructor) ──────────────────────
      const OriginalInstance = WebAssembly.Instance;
      WebAssembly.Instance = function(module, importObject) {
        const instance = new OriginalInstance(module, importObject);
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return instance;
      };
      WebAssembly.Instance.prototype = OriginalInstance.prototype;

      // ── Patch WebAssembly.instantiate ──────────────────────────────────────
      WebAssembly.instantiate = async function(source, importObject) {
        const result = await originalInstantiate.call(this, source, importObject);
        const instance = result.instance || result;
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return result;
      };

      // ── Patch WebAssembly.instantiateStreaming ─────────────────────────────
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        const result = await originalInstantiateStreaming.call(this, source, importObject);
        const instance = result.instance || result;
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) startDumping(memory);
        return result;
      };

      console.log("[mnemon] Hook installed");
    })();
  `;
}
