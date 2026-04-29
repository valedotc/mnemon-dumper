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
import { writeMnemonFile, type SectionData } from "./writer/mnemon-writer.js";
import {
  SECTION_ENTROPY,
  SECTION_STRINGS,
  SECTION_TIMELINE,
  SECTION_METADATA,
  SECTION_RAWPAGES,
} from "./writer/format.js";

const PKG_VERSION = "1.3.0";

const VALID_MODULES = ["entropy", "strings", "timeline", "metadata", "rawpages"] as const;

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
                       Available: ${VALID_MODULES.join(", ")}
  --max-rawpages-mb N  Stop rawpages capture after N MB of data (no limit by default)
  -o <path>            Output file path                     (default: ./session.mnem)
                       .mnem extension is added automatically if omitted
  -v                   Verbose: shallow progress (snapshot sizes, worker count)
  -vv                  More verbose: pipeline tracing (hook steps, fingerprints, batches)
  -vvv                 Most verbose: raw CDP payloads, chunk lists, importObject shapes
  --version, -V        Print version and exit
  --help,    -h        Print this help and exit
  --completion <shell> Print shell completion script (zsh or bash)

EXAMPLES
  mnemon --url https://example.com --duration 120 --interval 500
  mnemon --url https://example.com -vv
  mnemon --port 9222 --duration 60 -o captures/earth-test
  mnemon --url https://example.com --modules entropy,timeline
  mnemon --url https://example.com --modules entropy,strings,timeline,metadata,rawpages --max-rawpages-mb 500
`.trimStart();

// ── Completion scripts ────────────────────────────────────────────────────────

const ZSH_COMPLETION = `\
_mnemon() {
  _arguments -s \\
    '--url[Target URL (launch mode)]:url:' \\
    '--port[Remote debugging port (attach mode)]:port:' \\
    '--duration[Capture duration in seconds]:seconds:' \\
    '--interval[Snapshot interval in milliseconds]:ms:' \\
    '--modules[Comma-separated extractors]:modules:(entropy strings timeline metadata rawpages)' \\
    '--max-rawpages-mb[Stop rawpages capture after N MB]:mb:' \\
    '-o[Output file path]:file:_files' \\
    '-v[Verbose]' \\
    '-vv[More verbose]' \\
    '-vvv[Most verbose]' \\
    '--version[Print version and exit]' \\
    '--help[Print help and exit]' \\
    '--completion[Print shell completion script]:shell:(zsh bash)'
}
compdef _mnemon mnemon`;

const BASH_COMPLETION = `\
_mnemon_completion() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --modules)
      COMPREPLY=(\$(compgen -W "entropy strings timeline metadata rawpages" -- "$cur"))
      return 0 ;;
    --completion)
      COMPREPLY=(\$(compgen -W "zsh bash" -- "$cur"))
      return 0 ;;
    -o)
      COMPREPLY=(\$(compgen -f -- "$cur"))
      return 0 ;;
  esac

  COMPREPLY=(\$(compgen -W "--url --port --duration --interval --modules --max-rawpages-mb -o -v -vv -vvv --version --help --completion" -- "$cur"))
}

complete -F _mnemon_completion mnemon`;

// ── Arg parsing helpers ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`mnemon ${PKG_VERSION}\n`);
  process.exit(0);
}

if (args.includes("--completion")) {
  const idx = args.indexOf("--completion");
  const shell = args[idx + 1] ?? "zsh";
  if (shell === "zsh") {
    process.stdout.write(ZSH_COMPLETION + "\n");
  } else if (shell === "bash") {
    process.stdout.write(BASH_COMPLETION + "\n");
  } else {
    console.error(`[mnemon] Unknown shell: "${shell}". Supported: zsh, bash`);
    process.exit(1);
  }
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

function parsePositiveInt(raw: string, argName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[mnemon] --${argName} must be a positive integer (got: ${raw})`);
    process.exit(1);
  }
  return n;
}

function parseVerbosity(): 0 | 1 | 2 | 3 {
  let level = 0;
  for (const arg of args) {
    if (arg === "-v")   level += 1;
    if (arg === "-vv")  level += 2;
    if (arg === "-vvv") level += 3;
  }
  return Math.min(level, 3) as 0 | 1 | 2 | 3;
}

// ── Validate mode (--url xor --port) ─────────────────────────────────────────

const hasUrl  = hasFlag("url");
const hasPort = hasFlag("port");

if (hasUrl && hasPort) {
  console.error("[mnemon] --url and --port are mutually exclusive.");
  console.error("[mnemon] Use --url to launch a headless browser, --port to attach to a running one.");
  process.exit(1);
}
if (!hasUrl && !hasPort) {
  console.error("[mnemon] Either --url or --port is required.");
  console.error("[mnemon] Run `mnemon --help` for usage.");
  process.exit(1);
}

// ── Parse and validate arguments ─────────────────────────────────────────────

const verbosity = parseVerbosity();
const logger = new Logger(verbosity);

const duration = parsePositiveNumber(getArg("duration", "60"), "duration") * 1000;

const interval = parsePositiveNumber(getArg("interval", "1000"), "interval");
if (interval < 100) {
  console.error(`[mnemon] --interval must be at least 100ms (got: ${interval})`);
  process.exit(1);
}

const rawMaxMBRaw = hasFlag("max-rawpages-mb") ? getArg("max-rawpages-mb") : undefined;
const rawpagesMaxMB = rawMaxMBRaw !== undefined
  ? parsePositiveInt(rawMaxMBRaw, "max-rawpages-mb")
  : undefined;

const modules = getArg("modules", "entropy,strings,timeline,metadata")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Validate module names
for (const mod of modules) {
  if (!(VALID_MODULES as readonly string[]).includes(mod)) {
    console.error(`[mnemon] Unknown module: "${mod}"`);
    console.error(`[mnemon] Available modules: ${VALID_MODULES.join(", ")}`);
    process.exit(1);
  }
}

// Warn if --max-rawpages-mb is given but rawpages is not active
if (rawpagesMaxMB !== undefined && !modules.includes("rawpages")) {
  logger.warn(`--max-rawpages-mb has no effect without "rawpages" in --modules`);
}

// Validate URL or port
if (hasUrl) {
  const rawUrl = getArg("url");
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.error(`[mnemon] --url must use http:// or https:// (got: ${rawUrl})`);
      process.exit(1);
    }
  } catch {
    console.error(`[mnemon] --url is not a valid URL: ${rawUrl}`);
    process.exit(1);
  }
}

if (hasPort) {
  const rawPort = getArg("port", "9222");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[mnemon] --port must be an integer between 1 and 65535 (got: ${rawPort})`);
    process.exit(1);
  }
}

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
        extractor: new RawPagesExtractor({
          ...(rawpagesMaxMB !== undefined && { maxMB: rawpagesMaxMB }),
          duration,
          interval,
          logger,
        }),
      });
      break;
  }
}

// ── Resolve output filepath ───────────────────────────────────────────────────

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
  const sections: SectionData[] = activeExtractors.map(({ sectionId, extractor }) => {
    if (extractor.finalizeToHandle) {
      return {
        sectionId,
        data: null,
        writeStream: (fh) => extractor.finalizeToHandle!(fh),
      };
    }
    return { sectionId, data: extractor.finalize() };
  });
  const filepath = await writeMnemonFile(outputPath, sections);
  logger.info(`Session saved to ${filepath}`);
  logger.info("Done");
}

if (hasPort) {
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
