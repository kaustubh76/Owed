#!/usr/bin/env node
/**
 * Drive the simulated household in a real browser and assert what it actually renders.
 *
 * The card lives inside a sandboxed, opaque-origin iframe, so nothing about it can be
 * checked from Node: the MCP Apps handshake, the theme, the geometry and the numbers on
 * screen only exist once a browser has run the page. This boots the whole stack, clicks
 * the storyboard utterance, reaches into the iframe and checks the result.
 *
 * Not wired into CI, which has no browser. Run it before recording anything.
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const SERVER_PORT = process.env.OWED_PORT ?? "3939";
const HOME_URL = process.env.OWED_HOME_URL ?? "http://127.0.0.1:5173/";
const BOOT_TIMEOUT_MS = 40_000;

/** The exact figures the storyboard commits to — docs/contract-v1.md §6. */
const EXPECTED = {
  recovered: "$47.00",
  open: "$8.00",
  kept: "2",
  canvas: { width: 768, height: 480 },
  utterance: "Alexa, what am I owed?",
};

const children = [];
function start(name, command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "ignore" });
  children.push({ name, child });
  return child;
}

function stopAll() {
  for (const { child } of children) if (!child.killed) child.kill("SIGTERM");
}
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

async function waitFor(label, check) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(300);
  }
  throw new Error(`${label} did not come up within ${BOOT_TIMEOUT_MS}ms`);
}

const reachable = (url) =>
  fetch(url)
    .then((r) => r.ok)
    .catch(() => false);

start("server", process.execPath, ["packages/mcp-server/dist/main.js"], { OWED_PORT: SERVER_PORT });
await waitFor("MCP server", () =>
  reachable(`http://127.0.0.1:${SERVER_PORT}/.well-known/oauth-protected-resource`),
);

start("brain", process.execPath, ["apps/brain/dist/main.js"], {
  OWED_MCP_URL: `http://127.0.0.1:${SERVER_PORT}/mcp`,
});

start("home", "pnpm", ["--filter", "@owed/home", "dev"]);
await waitFor("home", () => reachable(HOME_URL));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });

const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`);
});

const failures = [];
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
  else process.stdout.write(`  ok  ${label} — ${actual}\n`);
};

try {
  await page.goto(HOME_URL, { waitUntil: "networkidle" });
  // The brain only reports connected once account linking has completed.
  await page.waitForSelector(".app__status--on", { timeout: 20_000 });

  /**
   * The card lives in a sandboxed iframe that is replaced whenever the view changes, so
   * every read re-resolves the frame rather than holding a handle across turns.
   */
  const card = () => page.frameLocator("iframe.echo__screen");
  const cardText = async (selector) => {
    const locator = card().locator(selector);
    await locator.waitFor({ state: "visible", timeout: 20_000 });
    return (await locator.textContent())?.trim() ?? "";
  };

  // --- the ledger ---------------------------------------------------------
  await page.getByRole("button", { name: EXPECTED.utterance }).click();

  check("recovered", await cardText(".ledger__amount"), EXPECTED.recovered);
  check("open", await cardText(".ledger__stat-value--open"), EXPECTED.open);
  check(
    "kept",
    await cardText(".ledger__stat-value:not(.ledger__stat-value--open)"),
    EXPECTED.kept,
  );

  const box = await page.locator("iframe.echo__screen").boundingBox();
  check("canvas width", Math.round(box?.width ?? 0), EXPECTED.canvas.width);
  check("canvas height", Math.round(box?.height ?? 0), EXPECTED.canvas.height);

  const overflows = await card()
    .locator("body")
    .evaluate((body) => body.ownerDocument.documentElement.scrollWidth > body.clientWidth);
  check("no horizontal overflow", overflows, false);

  const spoken = (await page.textContent(".voice__reply")) ?? "";
  check("spoken line has no digits", /[0-9]/.test(spoken), false);
  check("spoken line offers the waiting claim", spoken.includes("one more I can file"), true);

  // --- the trust beat: what Owed did not see ------------------------------
  await page.getByRole("button", { name: "Why aren't you claiming that?" }).click();

  check("evidence card states the coverage", (await cardText(".evidence__coverage-label")).includes("20%"), true);
  check("evidence card names the gaps", (await cardText(".evidence__gaps")).startsWith("Not watched:"), true);
  check("evidence card gives the verdict", await cardText(".evidence__verdict"), "not enough to claim");

  // --- the hero interaction: say yes, and watch it settle -----------------
  await page.getByRole("button", { name: "File it" }).click();

  check("claim settles", await cardText(".claim__amount"), "$8.00");
  const steps = await card().locator(".claim__step-label").allTextContents();
  check("claim shows the exchange", steps.map((step) => step.trim()).join(" "), "Asked They offered Countered Settled");
  check(
    "counter cites the merchant's own clause",
    await cardText(".claim__step-clause"),
    "Delivery Guarantee 4.1",
  );

  check("console clean", consoleErrors.length, 0);
  if (consoleErrors.length > 0) process.stdout.write(`${consoleErrors.join("\n")}\n`);
} finally {
  await browser.close();
  stopAll();
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nThe household renders what the storyboard promises.\n");
