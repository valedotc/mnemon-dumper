#!/usr/bin/env node
// index.ts

import { extname } from "node:path";
import { runSession, runAttachSession } from "./browser.js";
import { Dispatcher, type ActiveExtractor } from "./dispatcher.js";
import { EntropyExtractor } from "./extractors/entropy.js";
import { StringsExtractor } from "./extractors/strings.js";
import { TimelineExtractor } from "./extractors/timeline.js";
import { MetadataExtractor } from "./extractors/metadata.js";
import { RawPagesExtractor } from "./extractors/rawpages.js";
import { writeMnemonFile } from "./writer/mnemon-writer.js";
import {
  SECTION_ENTROPY,
  SECTION_STRINGS,
  SECTION_TIMELINE,
  SECTION_METADATA,
  SECTION_RAWPAGES,
} from "./writer/format.js";

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
const modules = getArg("modules", "entropy,strings,timeline,metadata")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Build extractor list ──────────────────────────────────────────────────────

const activeExtractors: ActiveExtractor[] = [];
let metadataExtractor: MetadataExtractor | null = null;

for (const mod of modules) {
  switch (mod) {
    case "entropy":
      activeExtractors.push({
        sectionId: SECTION_ENTROPY,
        extractor: new EntropyExtractor(),
      });
      break;
    case "strings":
      activeExtractors.push({
        sectionId: SECTION_STRINGS,
        extractor: new StringsExtractor(),
      });
      break;
    case "timeline":
      activeExtractors.push({
        sectionId: SECTION_TIMELINE,
        extractor: new TimelineExtractor(),
      });
      break;
    case "metadata": {
      metadataExtractor = new MetadataExtractor();
      activeExtractors.push({
        sectionId: SECTION_METADATA,
        extractor: metadataExtractor,
      });
      break;
    }
    case "rawpages":
      activeExtractors.push({
        sectionId: SECTION_RAWPAGES,
        extractor: new RawPagesExtractor(),
      });
      break;
    default:
      console.warn(`[mnemon] Unknown module: ${mod}`);
  }
}

// ── Resolve output filepath ───────────────────────────────────────────────────
// -o <path>  explicit path; .mnem extension added if omitted
// (default)  ./session.mnem

function resolveOutputPath(): string {
  const idx = args.indexOf("-o");
  if (idx !== -1 && idx + 1 < args.length) {
    const raw = args[idx + 1]!;
    return extname(raw) === "" ? `${raw}.mnem` : raw;
  }
  return "./session.mnem";
}

const outputPath = resolveOutputPath();
const dispatcher = new Dispatcher(activeExtractors, metadataExtractor);
const startTimestamp = Date.now();
let sessionUrl = "";

console.log("[mnemon] Starting memory dumper");
console.log(`[mnemon] Modules: ${modules.join(", ")}`);

async function finalize(): Promise<void> {
  if (metadataExtractor) {
    metadataExtractor.setSessionInfo(sessionUrl, startTimestamp, Date.now());
  }
  const sections = activeExtractors.map(({ sectionId, extractor }) => ({
    sectionId,
    data: extractor.finalize(),
  }));
  const filepath = await writeMnemonFile(outputPath, sections);
  console.log(`[mnemon] Session saved to ${filepath}`);
  console.log("[mnemon] Done");
}

if (hasFlag("port")) {
  // ── Attach mode ─────────────────────────────────────────────────────────────
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
  sessionUrl = `attach:${port}`;
  runAttachSession({ port, duration, interval, dispatcher })
    .then(finalize)
    .catch((err: unknown) => {
      console.error("[mnemon] Error:", (err as Error).message);
      process.exit(1);
    });
} else {
  // ── Launch mode ──────────────────────────────────────────────────────────────
  // Open a headless browser, navigate to --url, and capture.
  //
  //   node dist/index.js --url https://earth.google.com/web/ --duration 60
  const url = getArg("url");
  sessionUrl = url;
  runSession({ url, duration, interval, dispatcher })
    .then(finalize)
    .catch((err: unknown) => {
      console.error("[mnemon] Error:", (err as Error).message);
      process.exit(1);
    });
}
