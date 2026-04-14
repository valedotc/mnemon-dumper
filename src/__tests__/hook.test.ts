import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getHookScript } from "../hook.js";

describe("getHookScript", () => {
  test("returns a non-empty string", () => {
    const s = getHookScript(500, 0);
    assert.ok(typeof s === "string" && s.length > 0);
  });

  test("embeds the interval value", () => {
    const s = getHookScript(1234, 0);
    assert.ok(s.includes("1234"));
  });

  describe("verbosity 0 (default)", () => {
    test("WebAssembly.instantiate called log is guarded by VERBOSITY >= 1", () => {
      const s = getHookScript(500, 0);
      // The string literal is present in the script source, but only executed when VERBOSITY >= 1
      assert.ok(s.includes("WebAssembly.instantiate called"));
      assert.ok(s.includes("VERBOSITY >= 1"));
    });
    test("findMemory diagnostic log is guarded by VERBOSITY >= 2", () => {
      const s = getHookScript(500, 0);
      // The string literal is present in the script source, but only executed when VERBOSITY >= 2
      assert.ok(s.includes("findMemory: no Memory found"));
      assert.ok(s.includes("VERBOSITY >= 2"));
    });
    test("always contains Hook installed log", () => {
      const s = getHookScript(500, 0);
      assert.ok(s.includes("Hook installed"));
    });
  });

  describe("verbosity 1 (-v)", () => {
    test("contains WebAssembly.instantiate called guard at level 1", () => {
      const s = getHookScript(500, 1);
      assert.ok(s.includes("WebAssembly.instantiate called"));
      assert.ok(s.includes("VERBOSITY >= 1"));
    });
    test("does not unconditionally log findMemory diagnostics", () => {
      const s = getHookScript(500, 1);
      // findMemory diagnostic requires VERBOSITY >= 2
      assert.ok(!s.match(/console\.log\("[mnemon] findMemory/));
    });
  });

  describe("verbosity 2 (-vv)", () => {
    test("contains findMemory diagnostic guarded at level 2", () => {
      const s = getHookScript(500, 2);
      assert.ok(s.includes("findMemory: no Memory found"));
      assert.ok(s.includes("VERBOSITY >= 2"));
    });
  });

  describe("verbosity 3 (-vvv)", () => {
    test("contains importObject shape log guarded at level 3", () => {
      const s = getHookScript(500, 3);
      assert.ok(s.includes("importObject shape"));
      assert.ok(s.includes("VERBOSITY >= 3"));
    });
  });
});
