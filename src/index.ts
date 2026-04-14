#!/usr/bin/env node
// index.ts

import { extname } from "node:path";
import { runSession, runAttachSession } from "./browser.js";
import { Dispatcher, type ActiveExtractor } from "./dispatcher.js";
import { Logger } from "./logger.js";
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

const PKG_VERSION = "1.1.1";

const USAGE = `
mnemon v${PKG_VERSION} — WebAssembly linear memory capture tool

USAGE
  mnemon --url <url> [options]       Launch headless Chromium and capture
  mnemon --port <n> [options]        Attach to a running Chrome instance

OPTIONS
  --url <url>          Target URL (required in launch mode)
  --port <n>           Remote debugging port; enables attach mode
  --duration <s>       Capture duration in seconds          (default: 60)
  --interval <ms>      Snapshot interval in milliseconds    (default: 1000)
  --modules <list>     Comma-separated extractors to enable (default: entropy,strings,timeline,metadata)
                       Available: entropy, strings, timeline, metadata, rawpages
  -o <path>            Output file path                     (default: ./session.mnem)
                       .mnem extension is added automatically if omitted
  -v                   Verbose: shallow progress (snapshot sizes, worker count)
  -vv                  More verbose: pipeline tracing (hook steps, fingerprints, batches)
  -vvv                 Most verbose: raw CDP payloads, chunk lists, importObject shapes
  --version, -V        Print version and exit
  --help,    -h        Print this help and exit

EXAMPLES
  mnemon --url https://example.com --duration 120 --interval 500
  mnemon --url https://example.com -vv
  mnemon --port 9222 --duration 60 -o captures/earth-test
  mnemon --url https://example.com --modules entropy,timeline
`.trimStart();

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`mnemon ${PKG_VERSION}\n`);
  process.exit(0);
}

function getArg(name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= args.length) {
    if (fallback !== undefined) return fallback;
    console.error(`[mnemon] Missing required argument: --${name}`);
    console.error(`[mnemon] Run \`mnemon --help\` for usage.`);
    process.exit(1);
  }
  return args[index + 1]!;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function parsePositiveNumber(raw: string, argName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[mnemon] --${argName} must be a positive number (got: ${raw})`);
    process.exit(1);
  }
  return n;
}

/**
 * Count verbosity level from -v / -vv / -vvv flags.
 * A single token "-vvv" counts as 3. Repeated "-v -v -v" also counts as 3. Capped at 3.
 */
function parseVerbosity(): 0 | 1 | 2 | 3 {
  let level = 0;
  for (const arg of args) {
    if (arg === "-v")   level += 1;
    if (arg === "-vv")  level += 2;
    if (arg === "-vvv") level += 3;
  }
  return Math.min(level, 3) as 0 | 1 | 2 | 3;
}

const verbosity = parseVerbosity();
const logger = new Logger(verbosity);

const duration = parsePositiveNumber(getArg("duration", "60"), "duration") * 1000;
const interval = parsePositiveNumber(getArg("interval", "1000"), "interval");
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
      logger.warn(`Unknown module: ${mod}`);
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
const dispatcher = new Dispatcher(activeExtractors, metadataExtractor, logger);
const startTimestamp = Date.now();
let sessionUrl = "";

logger.info("Starting memory dumper");
logger.info(`Modules: ${modules.join(", ")}`);

async function finalize(): Promise<void> {
  if (metadataExtractor) {
    metadataExtractor.setSessionInfo(sessionUrl, startTimestamp, Date.now());
  }
  const sections = activeExtractors.map(({ sectionId, extractor }) => ({
    sectionId,
    data: extractor.finalize(),
  }));
  const filepath = await writeMnemonFile(outputPath, sections);
  logger.info(`Session saved to ${filepath}`);
  logger.info("Done");
}

if (hasFlag("port")) {
  const port = Number(getArg("port", "9222"));
  sessionUrl = `attach:${port}`;
  runAttachSession({ port, duration, interval, dispatcher, logger })
    .then(finalize)
    .catch((err: unknown) => {
      logger.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    });
} else {
  const url = getArg("url");
  sessionUrl = url;
  runSession({ url, duration, interval, dispatcher, logger })
    .then(finalize)
    .catch((err: unknown) => {
      logger.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    });
}
