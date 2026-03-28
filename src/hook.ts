/**
 * Returns a self-contained JavaScript string to be injected by Puppeteer
 * as a page-level script before any other code runs.
 *
 * The returned string is plain JavaScript (not TypeScript) and runs inside
 * the browser context. It patches the WebAssembly instantiation APIs to
 * intercept any WebAssembly.Memory object and start periodic snapshots.
 *
 * @param intervalMs - Snapshot interval in milliseconds.
 */
export function getHookScript(intervalMs: number, maxBytes: number): string {
  return `
    (function() {

      const originalInstantiate = WebAssembly.instantiate;
      const originalInstantiateStreaming = WebAssembly.instantiateStreaming;

      /**
       * Searches for a WebAssembly.Memory instance in the module exports
       * or in the import object provided at instantiation time.
       *
       * @param {WebAssembly.Instance} instance - The instantiated Wasm module.
       * @param {object} importObject - The import object passed to instantiate.
       * @returns {WebAssembly.Memory|null} The first Memory found, or null.
       */
      function findMemory(instance, importObject) {

        // Check the module's own exports first.
        for (const value of Object.values(instance.exports)) {
          if (value instanceof WebAssembly.Memory) {
            return value;
          }
        }

        // Fall back to scanning the import object for a shared memory.
        if (importObject) {
          for (const mod of Object.values(importObject)) {
            if (mod && typeof mod === "object") {
              for (const value of Object.values(mod)) {
                if (value instanceof WebAssembly.Memory) {
                  return value;
                }
              }
            }
          }
        }

        return null;
      }

      /**
       * Starts a periodic timer that captures the current state of the Wasm
       * linear memory and forwards it to the host via window.saveSnapshot.
       *
       * The buffer reference is re-acquired on every tick because a call to
       * memory.grow() invalidates the previous ArrayBuffer.
       *
       * @param {WebAssembly.Memory} memory - The memory instance to snapshot.
       */
      function startDumping(memory) {
        let snapshotIndex = 0;
        const MAX_BYTES = ${maxBytes};

        setInterval(() => {
          // Re-acquire the buffer on every tick: memory.grow() detaches the old one.
          const full = new Uint8Array(memory.buffer);
          // Cap the dump to MAX_BYTES so large WASM memories (e.g. 512 MB) don't
          // stall the worker and overflow the CDP message limit.
          const bytes = full.length > MAX_BYTES ? full.subarray(0, MAX_BYTES) : full;

          // Encode to Base64 in fixed-size chunks to avoid stack overflow
          // on large memories when spreading byte arrays into String.fromCharCode.
          let binary = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode(...chunk);
          }
          const base64 = btoa(binary);

          // Deliver the snapshot to the Puppeteer host via the exposed binding.
          saveSnapshot(JSON.stringify({
            index: snapshotIndex,
            timestamp: Date.now(),
            byteLength: bytes.length,
            totalByteLength: full.length,
            base64: base64
          }));

          snapshotIndex++;
        }, ${intervalMs});
      }


      /**
       * Patched WebAssembly.Instance constructor — intercepts the synchronous
       * new WebAssembly.Instance(module, importObject) pattern used by Figma
       * and other apps that compile the module separately via WebAssembly.compile.
       */
      const OriginalInstance = WebAssembly.Instance;
      WebAssembly.Instance = function(module, importObject) {
        const instance = new OriginalInstance(module, importObject);
        const memory = findMemory(instance, importObject);
        if (memory) {
          console.log("[mnemon] Memory found via Instance constructor!", memory.buffer.byteLength, "bytes");
          startDumping(memory);
        }
        return instance;
      };
      WebAssembly.Instance.prototype = OriginalInstance.prototype;

      /**
       * Patched WebAssembly.instantiate — intercepts both the
       * {module, instance} and bare Instance return shapes.
       */
      WebAssembly.instantiate = async function(source, importObject) {
        const result = await originalInstantiate.call(this, source, importObject);

        // instantiate may return { module, instance } or a bare Instance.
        const instance = result.instance || result;

        const memory = findMemory(instance, importObject);
        if (memory) {
          console.log("[mnemon] Memory found!", memory.buffer.byteLength, "bytes");
          startDumping(memory);
        }

        return result;
      };

      /**
       * Patched WebAssembly.instantiateStreaming — same interception logic
       * applied to the streaming variant.
       */
      WebAssembly.instantiateStreaming = async function(source, importObject) {
        const result = await originalInstantiateStreaming.call(this, source, importObject);
        const instance = result.instance || result;

        const memory = findMemory(instance, importObject);
        if (memory) {
          console.log("[mnemon] Memory found!", memory.buffer.byteLength, "bytes");
          startDumping(memory);
        }

        return result;
      };

      console.log("[mnemon] Hook installed");
    })();
  `;
}
