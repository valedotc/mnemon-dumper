// browser.ts

import { get as httpGet } from "node:http";
import puppeteer, { TargetType } from "puppeteer";
import type { Browser, CDPSession, Page, WebWorker, Target } from "puppeteer";
import { getHookScript } from "./hook.js";
import { Dispatcher } from "./dispatcher.js";

export interface SessionConfig {
  url: string;
  duration: number;
  interval: number;
  dispatcher: Dispatcher;
}

export interface AttachConfig {
  port: number;
  duration: number;
  interval: number;
  dispatcher: Dispatcher;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Given an already-open CDPSession for any execution context (dedicated
 * worker, service worker, shared worker), registers the saveSnapshot binding,
 * injects the hook script, and resumes the context if it was paused via
 * waitForDebuggerOnStart.
 */
async function setupContextCDP(
  cdpSession: CDPSession,
  hookScript: string,
  dispatcher: Dispatcher,
  label: string,
): Promise<void> {
  await cdpSession.send("Runtime.addBinding", { name: "saveSnapshot" });
  await cdpSession.send("Runtime.addBinding", { name: "saveMetadata" });
  await cdpSession.send("Runtime.enable");

  cdpSession.on("Runtime.bindingCalled", (event) => {
    if (event.name === "saveSnapshot") {
      dispatcher.handleSnapshot(event.payload);
    } else if (event.name === "saveMetadata") {
      dispatcher.handleMetadata(event.payload);
    }
  });

  try {
    await cdpSession.send("Runtime.evaluate", { expression: hookScript });
  } catch {
    // Context closed before injection — ignore.
  }

  // Resume if the context was paused by waitForDebuggerOnStart.
  // Must run AFTER hook injection so WASM APIs are already patched.
  try {
    await cdpSession.send("Runtime.runIfWaitingForDebugger");
  } catch {}

  console.log(`[mnemon] Hook injected into ${label}`);
}

/**
 * Sets up WASM interception for a single Page:
 * - Registers the saveSnapshot binding on the main-frame CDP session.
 * - Sets waitForDebuggerOnStart so dedicated workers start paused.
 * - Hooks workercreated to inject into each worker before it runs.
 * - Returns the page-level CDPSession.
 */
async function hookPage(
  page: Page,
  hookScript: string,
  dispatcher: Dispatcher,
  injectNow: boolean,
): Promise<void> {
  const cdp = await page.createCDPSession();

  // Pause dedicated workers on start so the hook is guaranteed to be injected
  // before any worker script executes (and before WebAssembly.instantiate runs).
  // setupContextCDP ends with Runtime.runIfWaitingForDebugger to resume them.
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  await cdp.send("Runtime.addBinding", { name: "saveSnapshot" });
  await cdp.send("Runtime.addBinding", { name: "saveMetadata" });
  cdp.on("Runtime.bindingCalled", (event) => {
    if (event.name === "saveSnapshot") {
      dispatcher.handleSnapshot(event.payload);
    } else if (event.name === "saveMetadata") {
      dispatcher.handleMetadata(event.payload);
    }
  });

  page.on("workercreated", async (worker: WebWorker) => {
    const label = `worker ${worker.url().slice(0, 80)}`;
    console.log(`[mnemon] New target: ${label}`);
    try {
      await setupContextCDP(worker.client, hookScript, dispatcher, label);
    } catch (err) {
      console.warn(`[mnemon] Could not attach to ${label}: ${err}`);
    }
  });

  if (injectNow) {
    // Attach mode: page already loaded, inject into current context.
    try {
      await page.evaluate(hookScript);
    } catch {}
    // Also hook any workers already running.
    const existingWorkers = page.workers();
    for (const worker of existingWorkers) {
      const label = `worker ${worker.url().slice(0, 80)} [existing]`;
      console.log(`[mnemon] Existing target: ${label}`);
      try {
        await setupContextCDP(worker.client, hookScript, dispatcher, label);
      } catch (err) {
        console.warn(`[mnemon] Could not attach to ${label}: ${err}`);
      }
    }
  } else {
    // Launch mode: inject before any page script runs.
    await page.evaluateOnNewDocument(hookScript);
  }
}

/**
 * Sets up service-worker interception for the whole browser instance.
 * Service workers are browser-level targets, not page-level ones.
 */
function hookServiceWorkers(
  browser: Browser,
  hookScript: string,
  dispatcher: Dispatcher,
  seenUrls: Set<string>,
): void {
  browser.on("targetcreated", async (target: Target) => {
    if (target.type() !== TargetType.SERVICE_WORKER) return;
    if (seenUrls.has(target.url())) return;
    seenUrls.add(target.url());

    const label = `service_worker ${target.url().slice(0, 80)}`;
    console.log(`[mnemon] New target: ${label}`);
    try {
      const swCDP = await target.createCDPSession();
      await setupContextCDP(swCDP, hookScript, dispatcher, label);
    } catch (err) {
      console.warn(`[mnemon] Could not attach to ${label}: ${err}`);
    }
  });
}

/**
 * Scans already-known service-worker targets after navigation and injects.
 * targetcreated can fire late (only when the CDP stream is flushed), so this
 * proactive scan is the only reliable way to catch SWs registered at load.
 */
async function scanExistingServiceWorkers(
  browser: Browser,
  hookScript: string,
  dispatcher: Dispatcher,
  seenUrls: Set<string>,
): Promise<void> {
  for (const target of browser.targets()) {
    if (target.type() !== TargetType.SERVICE_WORKER) continue;
    if (seenUrls.has(target.url())) continue;
    seenUrls.add(target.url());

    const label = `service_worker ${target.url().slice(0, 80)} [existing]`;
    console.log(`[mnemon] Existing target: ${label}`);
    try {
      const swCDP = await target.createCDPSession();
      await setupContextCDP(swCDP, hookScript, dispatcher, label);
    } catch (err) {
      console.warn(`[mnemon] Could not attach to ${label}: ${err}`);
    }
  }
}

/** Fetches the browser WebSocket endpoint from Chrome's /json/version API. */
function getWsEndpoint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    httpGet(`http://localhost:${port}/json/version`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { webSocketDebuggerUrl?: string };
          if (!parsed.webSocketDebuggerUrl) {
            reject(
              new Error(
                "webSocketDebuggerUrl not found in /json/version response",
              ),
            );
          } else {
            resolve(parsed.webSocketDebuggerUrl);
          }
        } catch {
          reject(new Error(`Failed to parse /json/version response: ${body}`));
        }
      });
    }).on("error", (err) => {
      reject(
        new Error(
          `Could not reach Chrome on port ${port}. ` +
            `Make sure Chrome is running with remote debugging enabled.\n\n` +
            `macOS:\n` +
            `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n` +
            `    --remote-debugging-port=${port} \\\n` +
            `    --user-data-dir=/tmp/chrome-debug \\\n` +
            `    --no-first-run\n\n` +
            `Note: --user-data-dir is required — Chrome refuses remote debugging\n` +
            `on the default profile. Any temp directory works.\n\n` +
            `Original error: ${err.message}`,
        ),
      );
    });
  });
}

export function makeSessionId(): string {
  return new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/T/, "_")
    .replace(/:/g, "");
}

// ── Public session runners ────────────────────────────────────────────────────

/**
 * Launch mode: opens a headless browser, navigates to the given URL, and
 * captures WASM memory snapshots for the configured duration.
 */
export async function runSession(config: SessionConfig): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  const hookScript = getHookScript(config.interval);
  const seenUrls = new Set<string>();

  hookServiceWorkers(browser, hookScript, config.dispatcher, seenUrls);

  const page = await browser.newPage();
  await hookPage(page, hookScript, config.dispatcher, /* injectNow */ false);

  console.log(`[mnemon] Navigating to ${config.url}`);
  console.log(`[mnemon] Duration: ${config.duration / 1000}s, Interval: ${config.interval}ms`);

  // waitUntil "load" so service workers registered after DOMContentLoaded
  // are already alive when we do the proactive scan below.
  await page.goto(config.url, { waitUntil: "load", timeout: 60_000 });
  await scanExistingServiceWorkers(browser, hookScript, config.dispatcher, seenUrls);

  await new Promise((resolve) => setTimeout(resolve, config.duration));

  // Close the browser first so all worker setIntervals stop and no more
  // binding callbacks can fire after we finalize.
  await browser.close();
}

/**
 * Attach mode: connects to an already-running Chrome instance via its remote
 * debugging port, injects hooks into every open page and worker, and captures
 * WASM memory snapshots for the configured duration.
 *
 * Start Chrome with:
 *   --remote-debugging-port=<port>
 *
 * Then browse normally — mnemon will intercept WASM on every tab you visit.
 */
export async function runAttachSession(config: AttachConfig): Promise<void> {
  const wsEndpoint = await getWsEndpoint(config.port);
  console.log(`[mnemon] Connecting to Chrome on port ${config.port}`);

  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  const hookScript = getHookScript(config.interval);
  const seenUrls = new Set<string>();

  hookServiceWorkers(browser, hookScript, config.dispatcher, seenUrls);
  await scanExistingServiceWorkers(browser, hookScript, config.dispatcher, seenUrls);

  // Hook all pages already open.
  const pages = await browser.pages();
  console.log(`[mnemon] Found ${pages.length} open page(s)`);
  for (const page of pages) {
    const url = page.url();
    if (!url || url === "about:blank") continue;
    console.log(`[mnemon] Hooking page: ${url.slice(0, 80)}`);
    await hookPage(page, hookScript, config.dispatcher, /* injectNow */ true);
  }

  // Hook new pages as the user opens them.
  browser.on("targetcreated", async (target: Target) => {
    if (target.type() !== TargetType.PAGE) return;
    const newPage = await target.page();
    if (!newPage) return;

    // evaluateOnNewDocument ensures the hook runs before any page script on
    // subsequent navigations within this tab.
    await newPage.evaluateOnNewDocument(hookScript);
    await hookPage(newPage, hookScript, config.dispatcher, /* injectNow */ false);

    newPage.on("framenavigated", async (frame) => {
      if (frame !== newPage.mainFrame()) return;
      const url = newPage.url();
      if (!url || url === "about:blank") return;
      console.log(`[mnemon] New page: ${url.slice(0, 80)}`);
    });
  });

  console.log(`[mnemon] Attached — capturing for ${config.duration / 1000}s`);
  console.log(`[mnemon] Browse normally; WASM memory will be captured automatically.`);

  await new Promise((resolve) => setTimeout(resolve, config.duration));

  // Disconnect without closing so the user's browser stays open.
  browser.disconnect();
}
