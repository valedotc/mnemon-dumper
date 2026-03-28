// index.ts

import { runSession, runAttachSession } from "./browser.js";

const args = process.argv.slice(2);

function getArg(name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= args.length) {
    if (fallback !== undefined) return fallback;
    console.error(`[mnemon] Missing required argument: --${name}`);
    process.exit(1);
  }
  return args[index + 1]!;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const duration = Number(getArg("duration", "60")) * 1000;
const interval = Number(getArg("interval", "1000"));
const maxBytes = Number(getArg("max-memory-mb", "64")) * 1024 * 1024;

console.log("[mnemon] Starting memory dumper");

if (hasFlag("port")) {
  // ── Attach mode ────────────────────────────────────────────────────────────
  // Connect to an already-running Chrome instance.
  //
  // IMPORTANT: --user-data-dir is required (Chrome refuses remote debugging
  // on the default profile as a security measure). Use any temp directory.
  //
  //   macOS:
  //     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  //       --remote-debugging-port=9222 \
  //       --user-data-dir=/tmp/chrome-debug \
  //       --no-first-run
  //
  //   Linux:
  //     google-chrome --remote-debugging-port=9222 \
  //       --user-data-dir=/tmp/chrome-debug
  //
  //   Windows:
  //     chrome.exe --remote-debugging-port=9222 ^
  //       --user-data-dir=%TEMP%\chrome-debug
  //
  // Then run:
  //   node dist/index.js --port 9222 --duration 60 --interval 1000
  const port = Number(getArg("port", "9222"));
  runAttachSession({ port, duration, interval, maxBytes, outputDir: "dumps" }).catch((err) => {
    console.error("[mnemon] Error:", err.message);
    process.exit(1);
  });
} else {
  // ── Launch mode ────────────────────────────────────────────────────────────
  // Open a headless browser, navigate to --url, and capture.
  //
  //   node dist/index.js --url https://earth.google.com/web/ --duration 60
  const url = getArg("url");
  runSession({ url, duration, interval, maxBytes, outputDir: "dumps" }).catch((err) => {
    console.error("[mnemon] Error:", err.message);
    process.exit(1);
  });
}
