import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger, SILENT } from "../logger.js";

function capture(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  try { fn(); } finally { console.log = orig; }
  return out;
}

function captureWarn(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => out.push(args.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return out;
}

function captureError(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => out.push(args.join(" "));
  try { fn(); } finally { console.error = orig; }
  return out;
}

describe("Logger", () => {
  describe("info/warn/error always emit", () => {
    test("info emits at level 0", () => {
      const msgs = capture(() => new Logger(0).info("hello"));
      assert.ok(msgs.some(m => m.includes("hello")));
    });

    test("warn emits at level 0", () => {
      const msgs = captureWarn(() => new Logger(0).warn("oops"));
      assert.ok(msgs.some(m => m.includes("oops")));
    });

    test("error emits at level 0", () => {
      const msgs = captureError(() => new Logger(0).error("boom"));
      assert.ok(msgs.some(m => m.includes("boom")));
    });

    test("info emits at level 3", () => {
      const msgs = capture(() => new Logger(3).info("hello"));
      assert.ok(msgs.some(m => m.includes("hello")));
    });
    test("warn emits at level 3", () => {
      const msgs = captureWarn(() => new Logger(3).warn("oops"));
      assert.ok(msgs.some(m => m.includes("oops")));
    });
    test("error emits at level 3", () => {
      const msgs = captureError(() => new Logger(3).error("boom"));
      assert.ok(msgs.some(m => m.includes("boom")));
    });
  });

  describe("v() — level 1", () => {
    test("suppressed at level 0", () => {
      const msgs = capture(() => new Logger(0).v("x"));
      assert.equal(msgs.length, 0);
    });
    test("emitted at level 1", () => {
      const msgs = capture(() => new Logger(1).v("x"));
      assert.ok(msgs.some(m => m.includes("x")));
    });
    test("emitted at level 3", () => {
      const msgs = capture(() => new Logger(3).v("x"));
      assert.ok(msgs.some(m => m.includes("x")));
    });
  });

  describe("vv() — level 2", () => {
    test("suppressed at level 1", () => {
      const msgs = capture(() => new Logger(1).vv("x"));
      assert.equal(msgs.length, 0);
    });
    test("emitted at level 2", () => {
      const msgs = capture(() => new Logger(2).vv("x"));
      assert.ok(msgs.some(m => m.includes("x")));
    });
  });

  describe("vvv() — level 3", () => {
    test("suppressed at level 2", () => {
      const msgs = capture(() => new Logger(2).vvv("x"));
      assert.equal(msgs.length, 0);
    });
    test("emitted at level 3", () => {
      const msgs = capture(() => new Logger(3).vvv("x"));
      assert.ok(msgs.some(m => m.includes("x")));
    });
  });

  describe("SILENT", () => {
    test("SILENT suppresses v/vv/vvv", () => {
      const msgs = capture(() => {
        SILENT.v("a");
        SILENT.vv("b");
        SILENT.vvv("c");
      });
      assert.equal(msgs.length, 0);
    });

    test("SILENT still emits info/warn/error", () => {
      const infoMsgs = capture(() => SILENT.info("x"));
      const warnMsgs = captureWarn(() => SILENT.warn("y"));
      const errMsgs = captureError(() => SILENT.error("z"));
      assert.ok(infoMsgs.some(m => m.includes("x")));
      assert.ok(warnMsgs.some(m => m.includes("y")));
      assert.ok(errMsgs.some(m => m.includes("z")));
    });
  });

  describe("message format", () => {
    test("info prefixes with [mnemon]", () => {
      const msgs = capture(() => new Logger(0).info("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] test-msg"));
    });
    test("v prefixes with [mnemon] [v]", () => {
      const msgs = capture(() => new Logger(1).v("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] [v] test-msg"));
    });
    test("vv prefixes with [mnemon] [vv]", () => {
      const msgs = capture(() => new Logger(2).vv("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] [vv] test-msg"));
    });
    test("vvv prefixes with [mnemon] [vvv]", () => {
      const msgs = capture(() => new Logger(3).vvv("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] [vvv] test-msg"));
    });
    test("warn prefixes with [mnemon]", () => {
      const msgs = captureWarn(() => new Logger(0).warn("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] test-msg"));
    });
    test("error prefixes with [mnemon]", () => {
      const msgs = captureError(() => new Logger(0).error("test-msg"));
      assert.ok(msgs.some(m => m === "[mnemon] test-msg"));
    });
  });
});
