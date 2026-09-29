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


/**
 * Accessibility, computed rather than eyeballed.
 *
 * Contrast and target size are certification gates *and* sit under the judged design
 * criterion, so a quiet failure costs twice. Runs inside the card's own document, over
 * the colours the browser actually resolved.
 */
async function auditAccessibility(frame, label) {
  return frame.locator("body").evaluate((body) => {
    const doc = body.ownerDocument;
    const view = doc.defaultView;
    const problems = [];

    const parse = (value) => {
      const parts = value.match(/[\d.]+/g);
      if (!parts) return null;
      const [r, g, b, a = "1"] = parts;
      return { r: +r, g: +g, b: +b, a: +a };
    };
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });

    const backgroundOf = (element) => {
      let node = element;
      while (node && node !== doc.documentElement) {
        const colour = parse(view.getComputedStyle(node).backgroundColor);
        if (colour && colour.a > 0.95) return colour;
        node = node.parentElement;
      }
      return { r: 0, g: 0, b: 0, a: 1 };
    };

    for (const element of doc.querySelectorAll("*")) {
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent?.trim() ?? "")
        .join("");
      if (text.length === 0) continue;

      const style = view.getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const foreground = parse(style.color);
      if (!foreground) continue;

      const background = backgroundOf(element);
      const composited = foreground.a < 1 ? over(foreground, background) : foreground;
      const a = luminance(composited);
      const b = luminance(background);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

      // 3:1 is permitted for large or bold text; everything else needs 4.5:1.
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (ratio + 0.01 < required) {
        problems.push(
          `contrast ${ratio.toFixed(2)}:1 (needs ${required}:1) on "${text.slice(0, 40)}"`,
        );
      }
    }

    for (const control of doc.querySelectorAll("button, a, input, select, [role=button]")) {
      const box = control.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.width < 48 || box.height < 48) {
        problems.push(`target ${Math.round(box.width)}x${Math.round(box.height)} under 48x48`);
      }
    }

    for (const image of doc.querySelectorAll("img")) {
      const alt = image.getAttribute("alt");
      if (alt === null) problems.push("image with no alt text");
      else if (alt.length > 125) problems.push(`alt text ${alt.length} characters, over 125`);
    }

    return problems;
  });
}

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

// Merchant agents first: the server is told where to find them and will not quietly
// fall back to in-process ones if they are missing.
const MERCHANTS_PORT = process.env.OWED_MERCHANTS_PORT ?? "3941";
start("merchants", process.execPath, ["packages/merchant-agents/dist/bin/serve.js"], {
  OWED_MERCHANTS_PORT: MERCHANTS_PORT,
});
await waitFor("merchant agents", () => reachable(`http://127.0.0.1:${MERCHANTS_PORT}/merchants`));

start("server", process.execPath, ["packages/mcp-server/dist/main.js"], {
  OWED_PORT: SERVER_PORT,
  OWED_MERCHANTS_URL: `http://127.0.0.1:${MERCHANTS_PORT}`,
});
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

  // --- the scrubber: move the household through its week -------------------
  const slider = page.locator(".scrub__range");
  await slider.waitFor({ state: "visible", timeout: 20_000 });
  const weekStart = Number(await slider.getAttribute("min"));
  const HOUR = 60 * 60 * 1000;
  const scrubTo = async (ms) => {
    await slider.fill(String(ms));
    // The scrubber only tells the server where a drag settled, and the brain then
    // polls. Wait for the clock the server echoed back rather than for a fixed delay.
    await page.waitForFunction(
      (expected) => document.querySelector(".app__clock")?.textContent?.includes(expected),
      new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      }).format(new Date(ms)),
      { timeout: 20_000 },
    );
  };

  await scrubTo(weekStart + 8 * HOUR);
  check("scrubbed back to Monday", (await page.textContent(".app__clock"))?.includes("Mon"), true);

  /**
   * The proactive beat. Crossing the moment a promise breaks makes Owed speak without
   * being asked — the one thing Alexa+ add-ons cannot do, which is why it is badged.
   */
  await scrubTo(weekStart + 6 * 24 * HOUR + 19.5 * HOUR);
  await page.waitForSelector(".app__proactive", { timeout: 20_000 });
  check("Owed spoke first", await page.isVisible(".app__proactive"), true);
  check(
    "the announcement is labelled simulated",
    (await page.textContent(".app__proactive-badge"))?.trim(),
    "simulated proactive",
  );
  const announced = (await page.textContent(".voice__reply")) ?? "";
  check("announcement names the breach", announced.includes("missed the delivery window"), true);
  check("announcement has no digits", /[0-9]/.test(announced), false);
  check(
    "inspector shows the commitment event",
    await page.locator(".inspector__line--proactive").count(),
    3,
  );

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

  // The inspector's claim is that it shows the wire, including the argument with the
  // merchant that the brain never sees itself.
  const recourseRows = await page.locator(".inspector__line--recourse").count();
  check("inspector shows the recourse exchange", recourseRows > 0, true);
  check(
    "recourse rows name the merchant",
    (await page.locator(".inspector__line--recourse .inspector__channel").first().textContent())?.trim(),
    "Northwind Parcel",
  );

  const claimProblems = await auditAccessibility(card(), "claim card");
  check("claim card accessibility", claimProblems.join(" | ") || "clean", "clean");

  await page.getByRole("button", { name: "Alexa, what am I owed?" }).click();
  await cardText(".ledger__amount");
  const ledgerProblems = await auditAccessibility(card(), "ledger card");
  check("ledger card accessibility", ledgerProblems.join(" | ") || "clean", "clean");

  // --- the surface with no screen -----------------------------------------
  // Voice-only parity is a certification requirement and the easiest thing to fake.
  // The only honest test is to take the card away and see whether the answer survives.
  await page.getByRole("button", { name: "Echo Dot" }).click();
  await page.waitForSelector(".dot__speech", { timeout: 20_000 });
  check("the Dot has no screen", await page.locator("iframe.echo__screen").count(), 0);

  const spokenOnDot = (await page.textContent(".dot__speech")) ?? "";
  check("the Dot still answers", spokenOnDot.length > 0, true);
  check("the Dot's answer has no digits", /[0-9]/.test(spokenOnDot), false);

  await page.getByRole("button", { name: "Alexa, what am I owed?" }).click();
  await page.waitForFunction(
    () => (document.querySelector(".dot__speech")?.textContent ?? "").includes("recovered"),
    undefined,
    { timeout: 20_000 },
  );
  const ledgerOnDot = (await page.textContent(".dot__speech")) ?? "";
  check("the ledger is answerable by voice alone", ledgerOnDot.includes("recovered"), true);
  check("and stands on its own", ledgerOnDot.includes("still open"), true);

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
