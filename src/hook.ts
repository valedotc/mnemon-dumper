import type { LogLevel } from "./logger.js";

export function getHookScript(intervalMs: number, verbosity: LogLevel): string {
  return `
    (function() {
      try {

      const VERBOSITY = ${verbosity};

      const originalInstantiate = WebAssembly.instantiate;
      const originalInstantiateStreaming = WebAssembly.instantiateStreaming;

      function findMemory(instance, importObject) {
        // 1. Exported memory
        for (const value of Object.values(instance.exports)) {
          if (value instanceof WebAssembly.Memory) return value;
        }
        // 2. Imported memory — up to 2 levels deep
        if (importObject) {
          for (const mod of Object.values(importObject)) {
            if (mod instanceof WebAssembly.Memory) return mod;
            if (mod && typeof mod === "object") {
              for (const value of Object.values(mod)) {
                if (value instanceof WebAssembly.Memory) return value;
              }
            }
          }
        }
        // 3. Diagnostics — only emitted at verbosity >= 2
        if (VERBOSITY >= 2) {
          if (importObject) {
            const shape = Object.entries(importObject).map(([k, v]) => {
              if (!v || typeof v !== "object") return k + ":" + typeof v;
              return k + ":{" + Object.keys(v).join(",") + "}";
            }).join(" | ");
            console.log("[mnemon] findMemory: no Memory found. importObject shape: " + shape);
          } else {
            console.log("[mnemon] findMemory: no Memory found. importObject is null/undefined");
          }
          if (VERBOSITY >= 3) {
            console.log("[mnemon] findMemory: exports: " + Object.keys(instance.exports || {}).join(","));
          }
        }
        return null;
      }

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

      function pageChanged(curr, prev, offset, len) {
        const words = len >> 2;
        const u32c = new Uint32Array(curr.buffer, curr.byteOffset + offset, words);
        const u32p = new Uint32Array(prev.buffer, prev.byteOffset + offset, words);
        for (let i = 0; i < words; i++) {
          if (u32c[i] !== u32p[i]) return true;
        }
        for (let i = words << 2; i < len; i++) {
          if (curr[offset + i] !== prev[offset + i]) return true;
        }
        return false;
      }

      function startDumping(memory) {
        const PAGE = 65536;
        const CHUNKS_PER_MSG = 32;
        let prevData = null;
        let snapshotIndex = 0;

        setInterval(() => {
          const full   = new Uint8Array(memory.buffer);
          const nPages = Math.ceil(full.length / PAGE);

          if (prevData === null || prevData.length !== full.length) {
            prevData = new Uint8Array(full.length);
          }

          const isBase    = (snapshotIndex === 0);
          const timestamp = Date.now();
          const chunks    = [];
          let totalData   = 0;

          for (let p = 0; p < nPages; p++) {
            const offset = p * PAGE;
            const end    = Math.min(offset + PAGE, full.length);
            const len    = end - offset;
            if (isBase || pageChanged(full, prevData, offset, len)) {
              chunks.push({ offset, data: toBase64(full.subarray(offset, end)) });
              totalData += len;
              prevData.set(full.subarray(offset, end), offset);
            }
          }

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

      // ── Patch WebAssembly.Instance ─────────────────────────────────────────
      const OriginalInstance = WebAssembly.Instance;
      WebAssembly.Instance = function(module, importObject) {
        if (VERBOSITY >= 1) console.log("[mnemon] WebAssembly.Instance called");
        const instance = new OriginalInstance(module, importObject);
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) {
          if (VERBOSITY >= 1) console.log("[mnemon] memory found via Instance, size=" + memory.buffer.byteLength);
          startDumping(memory);
        }
        return instance;
      };
      WebAssembly.Instance.prototype = OriginalInstance.prototype;

      // ── Patch WebAssembly.instantiate ──────────────────────────────────────
      WebAssembly.instantiate = async function(source, importObject) {
        if (VERBOSITY >= 1) console.log("[mnemon] WebAssembly.instantiate called, source type=" + (source && source.constructor && source.constructor.name));
        const result = await originalInstantiate.call(this, source, importObject);
        const instance = result.instance || result;
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) {
          if (VERBOSITY >= 1) console.log("[mnemon] memory found via instantiate, size=" + memory.buffer.byteLength);
          startDumping(memory);
        }
        return result;
      };

      // ── Patch WebAssembly.instantiateStreaming ─────────────────────────────
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        if (VERBOSITY >= 1) console.log("[mnemon] WebAssembly.instantiateStreaming called");
        const result = await originalInstantiateStreaming.call(this, source, importObject);
        const instance = result.instance || result;
        try { extractAndSendMetadata(instance, importObject); } catch {}
        const memory = findMemory(instance, importObject);
        if (memory) {
          if (VERBOSITY >= 1) console.log("[mnemon] memory found via instantiateStreaming, size=" + memory.buffer.byteLength);
          startDumping(memory);
        }
        return result;
      };

      console.log("[mnemon] Hook installed");
      } catch (e) {
        console.error("[mnemon] Hook setup error: " + e);
      }
    })();
  `;
}
