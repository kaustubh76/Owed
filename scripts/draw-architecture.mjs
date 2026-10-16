#!/usr/bin/env node
/**
 * Draw the whole product, end to end, as one Excalidraw file.
 *
 * Why a generator rather than a hand-drawn file: a few hundred coordinates typed by hand is
 * where diagrams go wrong, and a diagram that cannot be re-run goes stale the first time the
 * system changes. This computes the layout, checks its own arithmetic, and writes
 * `docs/architecture.excalidraw`.
 *
 * Every label here is traced to the code rather than remembered — the event types, the
 * promise statuses, the six detector kinds and their precedence, both breach gates, the
 * extraction threshold, the negotiation bounds, the tool names and the view URIs. A diagram
 * with a wrong enum value is worse than no diagram, because nobody can tell by looking.
 *
 * Three decisions that keep the output openable:
 *   - **Standalone text, never container-bound.** Bound text needs the container's
 *     `boundElements` and the text's `containerId` to agree; half-right produces invisible
 *     labels. Centring text by arithmetic is dull and always renders.
 *   - **Unbound arrows.** Bindings are the other way these files break. An arrow drawn
 *     between two computed edge points looks identical and cannot detach.
 *   - **Frames with `frameId` set on every child**, because Excalidraw clips to its frames —
 *     so containment is asserted below rather than assumed.
 *
 * Usage: node scripts/draw-architecture.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(REPO_ROOT, "docs/architecture.excalidraw");

// ---------------------------------------------------------------------------
// Palette. Colour carries meaning here, not decoration — the legend in the
// overview frame says which is which, and nothing uses a hue it has not earned.
// ---------------------------------------------------------------------------
const INK = "#1e1e1e";
const STYLE = {
  plain: { strokeColor: INK, backgroundColor: "#f8f9fa" },
  /** Anything written to the append-only ledger. */
  event: { strokeColor: "#1971c2", backgroundColor: "#d0ebff" },
  /** A decision with a threshold in it. */
  gate: { strokeColor: "#f08c00", backgroundColor: "#fff3bf" },
  /** Something the household itself does. */
  human: { strokeColor: "#2f9e44", backgroundColor: "#d3f9d8" },
  /** Simulated, or a caveat we are not allowed to drop. */
  caveat: { strokeColor: "#e03131", backgroundColor: "#ffe3e3" },
  /** Someone else's system. */
  external: { strokeColor: "#6741d9", backgroundColor: "#e5dbff" },
  /** A refusal — a first-class outcome, not an error path. */
  refusal: { strokeColor: "#ae3ec9", backgroundColor: "#f3d9fa" },
};

let counter = 0;
function nextId() {
  counter += 1;
  return `owed-${counter.toString(36).padStart(4, "0")}`;
}

/** Deterministic, so re-running produces the same file and the diff stays readable. */
const base = (overrides) => {
  const id = nextId();
  return {
    id,
    angle: 0,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: counter * 9973,
    version: 1,
    versionNonce: counter * 7919,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    ...overrides,
  };
};

/** Virgil is wider than a monospace font; 0.58em is the ratio that stopped overflowing. */
const CHAR_W = 0.58;
const LINE_H = 1.25;
const textWidth = (lines, fontSize) =>
  Math.max(...lines.map((line) => line.length)) * fontSize * CHAR_W;
const textHeight = (lines, fontSize) => lines.length * fontSize * LINE_H;

const elements = [];
/** Remembered so the validator can check each label actually fits its shape. */
const labelled = [];

function text(lines, x, y, { fontSize = 16, align = "left", color = INK, frameId = null } = {}) {
  const body = lines.join("\n");
  const element = base({
    type: "text",
    x,
    y,
    width: textWidth(lines, fontSize),
    height: textHeight(lines, fontSize),
    roundness: null,
    strokeColor: color,
    frameId,
    text: body,
    fontSize,
    fontFamily: 1,
    textAlign: align,
    verticalAlign: "top",
    containerId: null,
    originalText: body,
    lineHeight: LINE_H,
    autoResize: true,
  });
  elements.push(element);
  return element;
}

/**
 * A labelled shape. `lines[0]` is the title; the rest is detail a size smaller, which is how
 * a box can carry an enum list without the title getting lost in it.
 */
function box(x, y, w, h, lines, { style = "plain", shape = "rectangle", frameId, dashed } = {}) {
  const shapeElement = base({
    type: shape,
    x,
    y,
    width: w,
    height: h,
    frameId: frameId ?? null,
    roundness: shape === "diamond" ? null : { type: 3 },
    ...STYLE[style],
    ...(dashed ? { strokeStyle: "dashed" } : {}),
  });
  elements.push(shapeElement);

  const title = [lines[0]];
  const detail = lines.slice(1);
  const titleSize = detail.length > 0 ? 17 : 16;
  const detailSize = 13;
  const titleH = textHeight(title, titleSize);
  const detailH = detail.length > 0 ? textHeight(detail, detailSize) + 8 : 0;
  let cursor = y + (h - titleH - detailH) / 2;

  const titleElement = text(title, x + (w - textWidth(title, titleSize)) / 2, cursor, {
    fontSize: titleSize,
    align: "center",
    frameId: frameId ?? null,
  });
  cursor += titleH + 8;

  let detailElement;
  if (detail.length > 0) {
    detailElement = text(detail, x + (w - textWidth(detail, detailSize)) / 2, cursor, {
      fontSize: detailSize,
      align: "center",
      color: "#495057",
      frameId: frameId ?? null,
    });
  }

  labelled.push({ shape: shapeElement, labels: [titleElement, detailElement].filter(Boolean) });
  return shapeElement;
}

const rightOf = (b) => ({ x: b.x + b.width, y: b.y + b.height / 2 });
const leftOf = (b) => ({ x: b.x, y: b.y + b.height / 2 });
const under = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height });
const over = (b) => ({ x: b.x + b.width / 2, y: b.y });

function arrow(from, to, { label, frameId, style = "plain", dashed } = {}) {
  const element = base({
    type: "arrow",
    x: from.x,
    y: from.y,
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
    roundness: { type: 2 },
    frameId: frameId ?? null,
    strokeColor: STYLE[style].strokeColor,
    backgroundColor: "transparent",
    ...(dashed ? { strokeStyle: "dashed" } : {}),
    points: [
      [0, 0],
      [to.x - from.x, to.y - from.y],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  });
  elements.push(element);

  if (label !== undefined) {
    const size = 12;
    const lines = [label];
    text(lines, (from.x + to.x) / 2 - textWidth(lines, size) / 2, (from.y + to.y) / 2 - 20, {
      fontSize: size,
      align: "center",
      color: "#868e96",
      frameId: frameId ?? null,
    });
  }
  return element;
}

function frame(x, y, w, h, name) {
  const element = base({
    type: "frame",
    x,
    y,
    width: w,
    height: h,
    roundness: null,
    strokeColor: "#bbb",
    backgroundColor: "transparent",
    roughness: 0,
    name,
  });
  elements.push(element);
  return element;
}

// ---------------------------------------------------------------------------
// Layout grid. One overview across the top, eight detail frames below it.
// ---------------------------------------------------------------------------
const COL_W = 1140;
const COL_GAP = 100;
const ROW_H = 900;
const ROW_GAP = 140;
const PAD = 36;
const TOP_PAD = 52;

const OVERVIEW_W = COL_W * 3 + COL_GAP * 2;
const OVERVIEW_H = 690;
const ROW0 = OVERVIEW_H + ROW_GAP;

const colX = (c) => c * (COL_W + COL_GAP);
const rowY = (r) => ROW0 + r * (ROW_H + ROW_GAP);

/**
 * Place boxes down a column, each full content width unless told otherwise.
 *
 * A cursor rather than typed coordinates, so adding a line to one box pushes the rest down
 * instead of silently overlapping the next one. The validator checks the result anyway.
 */
function stack(f, { gap = 26, top = TOP_PAD } = {}) {
  let y = f.y + top;
  const left = f.x + PAD;
  const width = f.width - PAD * 2;
  return {
    left,
    width,
    get y() {
      return y;
    },
    box(h, lines, opts = {}) {
      const w = opts.width ?? width;
      const x = opts.x ?? (opts.centre ? left + (width - w) / 2 : left);
      const made = box(x, y, w, h, lines, { ...opts, frameId: f.id });
      y += h + (opts.gap ?? gap);
      return made;
    },
    note(lines, opts = {}) {
      const size = opts.fontSize ?? 13;
      const made = text(lines, left, y, {
        fontSize: size,
        color: "#495057",
        frameId: f.id,
        ...opts,
      });
      y += textHeight(lines, size) + (opts.gap ?? gap);
      return made;
    },
    /** Two boxes side by side, for a fork. */
    pair(h, leftLines, rightLines, opts = {}) {
      const w = (width - 28) / 2;
      const a = box(left, y, w, h, leftLines, { ...(opts.left ?? {}), frameId: f.id });
      const b = box(left + w + 28, y, w, h, rightLines, { ...(opts.right ?? {}), frameId: f.id });
      y += h + (opts.gap ?? gap);
      return [a, b];
    },
    down(from, to, opts = {}) {
      return arrow(under(from), over(to), { ...opts, frameId: f.id });
    },
  };
}

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------
{
  const f = frame(0, 0, OVERVIEW_W, OVERVIEW_H, "OWED — end to end");
  const left = PAD;
  const width = OVERVIEW_W - PAD * 2;

  text(
    [
      "Most Alexa+ add-ons will sell you something. This one represents the household:",
      "it reads what merchants promise, notices when they break it, and argues for you.",
    ],
    left,
    TOP_PAD - 16,
    { fontSize: 19, frameId: f.id },
  );

  const spineY = 148;
  const n = 8;
  const bw = 376;
  const bgap = (width - bw * n) / (n - 1);
  const steps = [
    ["1. Merchant message", '"arriving Tuesday 1–5pm"'],
    ["2. Extract the promise", "rules, not a model"],
    ["3. Watch for evidence", "scans · door · camera uptime"],
    ["4. Assess", "six detectors, two gates"],
    ["5. Owed speaks first", "simulated proactive"],
    ["6. The household says yes", "nothing is filed without it"],
    ["7. Argue the claim", "the merchant's own clause"],
    ["8. The money arrives", "Settled ≠ Recovered"],
  ];
  const spine = steps.map((lines, i) => {
    const style = i === 5 ? "human" : i === 4 ? "caveat" : i === 6 ? "external" : "plain";
    return box(left + i * (bw + bgap), spineY, bw, 92, lines, { style, frameId: f.id });
  });
  for (let i = 0; i < spine.length - 1; i += 1) {
    arrow(rightOf(spine[i]), leftOf(spine[i + 1]), { frameId: f.id });
  }

  const ledger = box(
    left,
    spineY + 180,
    width,
    96,
    [
      "THE LEDGER — one append-only event log, behind one port",
      "PromiseCaptured · EvidenceObserved · SourceUptimeRecorded · PromiseAssessed · ClaimProposed · ClaimFiled · OfferReceived · CounterSent · Settled · Escalated · Recovered · WrittenOff",
    ],
    { style: "event", frameId: f.id },
  );

  // Only the steps that actually write, so the arrows mean something.
  for (const i of [1, 2, 3, 6, 7]) {
    arrow(
      under(spine[i]),
      { x: spine[i].x + spine[i].width / 2, y: ledger.y },
      {
        frameId: f.id,
        style: "event",
      },
    );
  }

  const cardsY = ledger.y + ledger.height + 70;
  const cards = [
    ["ui://owed/ledger", "$47.00 recovered · $8.00 open · 2 kept"],
    ["ui://owed/claim", "Asked · They offered · Countered · Settled"],
    ["ui://owed/evidence", "coverage bar · the gaps · their own sentence"],
  ];
  const cw = 496;
  cards.forEach((lines, i) => {
    const card = box(left + i * (cw + 30), cardsY, cw, 92, lines, {
      style: "plain",
      frameId: f.id,
    });
    arrow({ x: card.x + card.width / 2, y: ledger.y + ledger.height }, over(card), {
      frameId: f.id,
      style: "event",
      dashed: true,
    });
  });

  box(
    left + 1620,
    cardsY,
    820,
    168,
    [
      "LEGEND",
      "blue — written to the append-only ledger",
      "amber — a decision with a threshold in it",
      "green — something the household itself does",
      "violet — somebody else's system",
      "purple — a refusal, which is a first-class outcome",
      "red — simulated, or a caveat we are not allowed to drop",
    ],
    { style: "plain", frameId: f.id },
  );

  box(
    left + 2470,
    cardsY,
    width - 2470,
    168,
    [
      "What is simulated — and labelled everywhere",
      "The household, the doorbell, the merchants' agents and the",
      "proactive channel are all stand-ins. The MCP server, the OAuth",
      "flow, the ledger, the evidence reasoning and the negotiation",
      "protocol are real and tested. None of it has run against the real",
      "Alexa+ client: Alexa+ for Builders is partner-gated.",
    ],
    { style: "caveat", frameId: f.id },
  );
}

// ---------------------------------------------------------------------------
// 1. CAPTURE
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(0),
    rowY(0),
    COL_W,
    ROW_H,
    "1. CAPTURE — reading a promise out of a sentence",
  );
  const s = stack(f);

  const msg = s.box(66, ['"Delivered between 1 and 5pm, guaranteed or your money back."'], {
    style: "plain",
  });
  const ext = s.box(76, [
    "Rules extractor — no model, no network",
    "finds the time expressions first, then classifies each by the words around it",
  ]);
  s.down(msg, ext);

  const [strong, weak] = s.pair(
    76,
    ["delivery_window", "stated outright · confidence 0.95"],
    ["guarantee", "inferred, no clock of its own · confidence 0.80"],
    { left: { style: "event" }, right: { style: "event" } },
  );
  arrow(under(ext), over(strong), { frameId: f.id });
  arrow(under(ext), over(weak), { frameId: f.id });

  const [g1, g2] = s.pair(104, ["≥ 0.85 ?"], ["≥ 0.85 ?"], {
    left: { style: "gate", shape: "diamond" },
    right: { style: "gate", shape: "diamond" },
  });
  arrow(under(strong), over(g1), { frameId: f.id });
  arrow(under(weak), over(g2), { frameId: f.id });

  const [captured, candidate] = s.pair(
    82,
    ["Captured", "tracked — can become a claim"],
    ["Candidate", '"not yet tracked" — recorded, never claimed'],
    { left: { style: "event" }, right: { style: "refusal" } },
  );
  arrow(under(g1), over(captured), { frameId: f.id, label: "yes" });
  arrow(under(g2), over(candidate), { frameId: f.id, label: "no" });

  s.box(132, [
    "TRACKING_CONFIDENCE = 0.85",
    "The extractor emits exactly three confidences: 0.95 when the cue sits next to",
    "the time it qualifies, 0.82 when it is further away, and 0.80 when the promise is",
    "inferred from a guarantee rather than stated. Over the 120-message corpus that",
    "is 89 reads above the line and 11 below it. One sentence can produce both.",
    "Every promise carries source_quote — the merchant's own words — into the ledger.",
  ]);
}

// ---------------------------------------------------------------------------
// 2. OBSERVE
// ---------------------------------------------------------------------------
{
  const f = frame(colX(1), rowY(0), COL_W, ROW_H, "2. OBSERVE — what the house actually saw");
  const s = stack(f);

  const ev = s.box(
    104,
    [
      "Six kinds of evidence — each one tagged to a single promise",
      "timestamp · carrier_scan · doorbell_event",
      "doorbell_snapshot · refund_observed · price_observed",
    ],
    { style: "event" },
  );

  const evEvent = s.box(58, ["EvidenceObserved"], { style: "event" });
  s.down(ev, evEvent);

  const up = s.box(104, [
    "Camera uptime — a separate channel on purpose",
    "SourceUptimeRecorded · household-wide, never per promise",
    "ObservationWindow { source_id, household_id, interval }",
  ]);

  s.box(142, [
    "Why uptime is kept apart from evidence",
    "Separating what the camera was *up for* from what it *saw* is what lets Owed say",
    "the door was watched and recorded nobody arriving — which is the entire",
    "phantom-delivery signal. It is also where coverage comes from:",
    "coverage = the watched stretches ÷ the window being judged.",
  ]);
  s.down(up, elements[elements.length - 3]);

  s.box(
    126,
    [
      "Evidence reaches only the promise it names",
      "promise_id is optional on the schema, and the engine used to admit anything that",
      "omitted it — so one untagged doorbell event was visible to every promise in the",
      "house, and could clear a claim it was never about. That is the silent failure:",
      "money the household is owed and never hears about. Now tightened, and tested",
      "in both directions.",
    ],
    { style: "refusal" },
  );
}

// ---------------------------------------------------------------------------
// 3. ASSESS
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(2),
    rowY(0),
    COL_W,
    ROW_H,
    "3. ASSESS — did they keep it, and did we see enough to say?",
  );
  const s = stack(f, { gap: 22 });

  const det = s.box(122, [
    "Six detectors, most specific first — the first one to reach a verdict wins a tie",
    "phantom_delivery  (delivery_window)        no_show  (appointment_slot + window)",
    "missed_window  (delivery_window | appointment_slot)    late_eta  (eta + deadline)",
    "late_refund  (refund_sla + deadline)        price_drop  (price_match + window)",
  ]);

  const detection = s.box(84, [
    "Each returns a Detection",
    "verdict · confidence · coverage · evaluation_interval · observed · explanation",
  ]);
  s.down(det, detection);

  const conf = s.box(76, [
    "confidence = 1 − (1 − coverage) × 0.5",
    "82% watched → 0.91    ·    20% watched → 0.60",
  ]);
  s.down(detection, conf);

  const gate = s.box(100, ["confidence ≥ 0.85  AND  coverage ≥ 0.7 ?"], {
    style: "gate",
    shape: "diamond",
    width: 760,
    centre: true,
  });
  s.down(conf, gate);

  s.box(
    140,
    [
      "Four verdicts, in the order they are decided",
      "1. Kept — short-circuits first, never blocked by a gate",
      "2. Undetermined — too early to say, the window has not closed",
      "3. Breached — only when BOTH gates are met. This is the only one that can be claimed.",
      "4. Suspected — past the deadline but under the gate. Says what it saw, claims nothing.",
    ],
    { style: "event" },
  );

  s.box(74, [
    "The loudest verdict wins:  Breached 3  >  Suspected 2  >  Kept 1  >  Undetermined 0",
    "A promise can be seen by two detectors; the most severe reading is the one recorded.",
  ]);

  s.box(
    96,
    [
      "The restraint beat — this is the product's whole character",
      "In the demo, prm_010 was watched for 20% of its window against a 0.70 gate. It reads",
      '"not enough to claim", and Owed says so out loud rather than guessing. A refusal is an',
      "outcome here, not an error.",
    ],
    { style: "refusal" },
  );
}

// ---------------------------------------------------------------------------
// 4. ANNOUNCE
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(0),
    rowY(1),
    COL_W,
    ROW_H,
    "4. ANNOUNCE — the one thing Alexa+ does not document",
  );
  const s = stack(f, { gap: 22 });

  s.box(
    104,
    [
      "Everything in the published add-on docs is reactive",
      "A tool runs because somebody said something. We found no documented way for an",
      "add-on to raise anything on its own — and we checked the docs, not the platform.",
    ],
    { style: "caveat" },
  );

  const endpoint = s.box(80, [
    "GET /control/commitments  →  a projection, not a queue",
    "so moving scenario time backwards stays coherent instead of replaying announcements",
  ]);

  const schema = s.box(
    168,
    [
      "CommitmentEvent — the primitive we specified, as a real schema",
      "event_id · household_id · kind · occurred_at · subject · spoken · resource_uri?",
      "",
      "expires_at   after this, say nothing. Being told on Friday about a parcel that",
      "             failed on Sunday is worse than silence.",
      "urgency      only the add-on knows whether money is about to stop being recoverable.",
      "offer        the utterance and tool to answer with. Without it an announcement is a",
      "             dead end — you hear something is wrong and must work out how to fix it.",
    ],
    { style: "event" },
  );
  s.down(endpoint, schema);

  s.box(122, [
    "Four rules the scheduler keeps",
    "Never speak about a Suspected verdict — speaking unasked is the last place to guess.",
    "Never raise a promise already filed. The household knows.",
    "A host that has just come up does not read out the backlog.",
    "Announcements go stale after three days, and are dropped rather than queued.",
  ]);

  s.box(
    76,
    [
      'Every announcement is badged "simulated proactive"',
      "Honest, and not shippable. The inspector shows the frame it would have travelled on.",
    ],
    { style: "caveat" },
  );
}

// ---------------------------------------------------------------------------
// 5. CONFIRM
// ---------------------------------------------------------------------------
{
  const f = frame(colX(1), rowY(1), COL_W, ROW_H, "5. CONFIRM — nothing is filed without a yes");
  const s = stack(f, { gap: 24 });

  const ask = s.box(72, ["claim_file  { promise_id }"], { style: "human" });

  const [elicit, confirmArg] = s.pair(
    120,
    [
      "Elicitation",
      "where the connection can carry it:",
      "one form-mode round, flat booleans,",
      '"File this claim?" + "Send the evidence?"',
    ],
    [
      "An explicit confirm argument",
      "where it cannot. The SDK's recommended",
      "stateless serving cannot ask anything at",
      "all on the revision Amazon's docs name.",
    ],
    { left: { style: "human" }, right: { style: "human" } },
  );
  arrow(under(ask), over(elicit), { frameId: f.id });
  arrow(under(ask), over(confirmArg), { frameId: f.id });

  s.box(
    74,
    [
      "A decline must be distinguishable from silence",
      "The documented example reads both as the same value and re-asks forever.",
    ],
    { style: "caveat" },
  );

  s.box(
    160,
    [
      "Three refusals, each saying which one it is",
      "",
      'not confident it was a promise →  "I\'m not tracking that one."',
      'not enough coverage to claim  →  "I only watched twenty percent of the window."',
      'no published remedy to claim under  →  "They have published nothing covering this."',
    ],
    { style: "refusal" },
  );

  s.box(72, ["ClaimProposed  →  ClaimFiled", "confirmed_by: household · attached_evidence_ids"], {
    style: "event",
  });
}

// ---------------------------------------------------------------------------
// 6. ARGUE
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(2),
    rowY(1),
    COL_W,
    ROW_H,
    "6. ARGUE — the recourse protocol, agent to agent",
  );
  const s = stack(f, { gap: 20 });

  const policy = s.box(104, [
    "The merchant's own published clause, transcribed with its source and a quote",
    "reservation  =  the figure they published",
    "ceiling      =  the most their own wording can be read to allow",
  ]);

  const strategy = s.box(128, [
    "The negotiator has exactly two positions",
    "Open at the ceiling. Counter at the reservation, citing the clause — never a number",
    "of our own invention. Accept anything at or above the published figure.",
    "At the round cap of 3, take whatever is standing rather than walk away on principle:",
    "a household is better off with five dollars than with a point well made.",
  ]);
  s.down(policy, strategy);

  const wire = s.box(
    96,
    [
      "CLAIM  →  OFFER  →  COUNTER  →  SETTLE | DECLINE",
      "A round counts only a merchant reply, so that exchange is two rounds, not four.",
    ],
    { style: "external" },
  );
  s.down(strategy, wire);

  s.box(
    74,
    [
      "The merchant's agent runs in its own process, over MCP",
      "It answers from its own policy, not from what the claimant asserts. It can say no.",
    ],
    { style: "external" },
  );

  s.box(
    104,
    [
      "The demo's actual exchange",
      "Asked $10.00  ·  they offered $3.00  ·  countered $8.00 citing Delivery Guarantee 4.1",
      "with a coverage statement  ·  settled $8.00",
    ],
    { style: "event" },
  );

  s.box(
    84,
    [
      "When nobody answers — the common case, since almost no merchant implements this",
      "The claim is recorded anyway, with the clause and the figure, routed email or manual",
      "depending on whether the policy publishes a contact. It used to be dropped silently.",
    ],
    { style: "refusal" },
  );

  s.box(72, [
    "After three encounters it stops arguing with merchants who withdraw",
    "learned from the ledger · MIN_OBSERVATIONS = 3",
  ]);
}

// ---------------------------------------------------------------------------
// 7. RECOVER AND RENDER
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(0),
    rowY(2),
    COL_W,
    ROW_H,
    "7. RECOVER — and the money is not real until it arrives",
  );
  const s = stack(f, { gap: 24 });

  const settled = s.box(72, ["Settled", "the merchant agreed"], { style: "event" });
  const recovered = s.box(72, ["Recovered", "the credit was observed in a linked source"], {
    style: "event",
  });
  s.down(settled, recovered, { label: "a separate event, later" });

  s.box(
    84,
    [
      "Settled is not Recovered, and the ledger refuses to conflate them",
      "Money a merchant agreed to is not money that arrived. Only Recovered counts toward",
      '"recovered this week" — which is why Settled is not a terminal status.',
    ],
    { style: "caveat" },
  );

  s.box(76, ["Twelve promise statuses · only three are endings", "Kept · Recovered · WrittenOff"]);

  s.box(
    120,
    [
      "The ledger — one port, three adapters, the same replay from each",
      "append(events) · read(householdId, upTo?)",
      "memory  ·  node:sqlite  ·  DynamoDB",
      "On DynamoDB the whole guarantee is one conditional write — attribute_not_exists(sk) —",
      "plus an atomic ADD counter, with seq rather than time as the sort key.",
    ],
    { style: "event" },
  );

  s.box(100, [
    "Three cards, each a projection of the event log",
    "ui://owed/ledger  ·  ui://owed/claim  ·  ui://owed/evidence",
    "single-file HTML into a sandboxed iframe, deny-by-default CSP",
  ]);

  s.box(
    72,
    ["What the demo adds up to", "$47.00 recovered  ·  $8.00 still open  ·  2 kept  ·  1 declined"],
    { style: "human" },
  );
}

// ---------------------------------------------------------------------------
// 8. WHAT WE MEASURED
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(1),
    rowY(2),
    COL_W,
    ROW_H,
    "8. WHAT WE MEASURED — thresholds written down first",
  );
  const s = stack(f, { gap: 22 });

  s.box(
    116,
    [
      "Can a promise be extracted from what a merchant actually wrote?",
      "written down first:  ≥ 0.9 precision, ≥ 0.8 recall, seven promise kinds",
      "MET — 100% precision, 99% recall on 120 labelled messages",
      "on 40 messages it had never seen:  73.7% precision, 58.3% recall",
    ],
    { style: "event" },
  );

  s.box(
    100,
    [
      "Can a breach be detected reliably, per kind, without crying wolf?",
      "written down first:  ≥ 0.9 precision per kind, under 5% false positives on kept",
      "MET — 100% precision and recall on all six kinds, 0% false positives, 60 timelines",
    ],
    { style: "event" },
  );

  s.box(
    116,
    [
      "Does arguing recover more than taking the first offer?",
      "written down first:  ≥ 60% of owed, ≥ 1.5× the baseline, median ≤ 2 rounds",
      "NOT MET — 33.9% of owed at 1.10×, over 1,620 negotiations on 270 policies",
      "met on the rounds criterion · 44.1% at 1.43× once it learns per merchant",
    ],
    { style: "refusal" },
  );

  s.box(
    132,
    [
      "And the result that does not flatter us",
      "Those merchants behave exactly as configured. Let their acceptance thresholds wobble",
      "by 10% and the advantage inverts — 1.10× becomes 0.95×, and 0.90× at 25%.",
      "Arguing loses to taking the first offer once a merchant is unpredictable.",
      "We then measured the obvious fix — concede a little — and it does not rescue it either.",
      "Published rather than buried, because a number measured only where it flatters you",
      "is not a measurement.",
    ],
    { style: "caveat" },
  );

  s.box(80, [
    "Three corpora, each committed before the code they judge",
    "120 + 40 messages · 60 evidence timelines · 270 merchant policies × 6 breach kinds",
    "A test pins each committed corpus to its generator, so it cannot be quietly widened.",
  ]);
}

// ---------------------------------------------------------------------------
// 9. THE MCP SURFACE
// ---------------------------------------------------------------------------
{
  const f = frame(
    colX(2),
    rowY(2),
    COL_W,
    ROW_H,
    "9. THE ADD-ON CONTRACT — what Alexa+ would actually talk to",
  );
  const s = stack(f, { gap: 22 });

  s.box(140, [
    "Six tools  ·  Streamable HTTP  ·  spec 2025-11-25, negotiated from the SDK",
    "ledger_summary      what am I owed            → ui://owed/ledger",
    "promises_list       list promises             → ui://owed/ledger",
    "promise_check       check a promise           → ui://owed/evidence",
    "evidence_get        get one piece of evidence → ui://owed/evidence",
    "claim_status        check a claim             → ui://owed/claim",
    "claim_file          file a claim              → ui://owed/claim   (the only writer)",
  ]);

  s.box(
    120,
    [
      "Our own OAuth 2.1 authorization server — the SDK ships none",
      "PKCE S256 as a hard requirement · RFC 9728 and 8414 discovery",
      "RFC 8707 audience binding · RFC 8252 loopback redirects",
      "No dynamic client registration, deliberately: Alexa+ does not support RFC 7591,",
      "and advertising it would promise a capability we do not honour.",
    ],
    { style: "external" },
  );

  s.box(
    116,
    [
      "Served at both well-known path shapes, because the docs disagree",
      "/.well-known/oauth-protected-resource        (+ /mcp)",
      "/.well-known/oauth-authorization-server      (+ /mcp)",
      "A builder cannot tell which page is stale, so the only safe answer is the union.",
    ],
    { style: "caveat" },
  );

  s.box(132, [
    "Outside the MCP surface, because they are the simulation's seams",
    "GET  /control/commitments     the proactive projection",
    "POST /control/messages        deliver a message, watch it be read",
    "GET  /control/clock           where scenario time is",
    "POST /control/clock           move it — every tool answers for the clock",
    "GET  /health                  touches the store, not a constant",
  ]);

  s.box(
    94,
    [
      "What a clean conformance run does and does not establish",
      "It passes every documented check of the community checker. That tool's own words:",
      '"the known, documented bar is met", not proof of behaviour undocumented pages',
      "might also require. It has never run against the real Alexa+ client.",
    ],
    { style: "caveat" },
  );
}

// ---------------------------------------------------------------------------
// Validate. This is what stands in for my not being able to see the result.
// ---------------------------------------------------------------------------
const problems = [];
const inside = (child, parent) =>
  child.x >= parent.x &&
  child.y >= parent.y &&
  child.x + child.width <= parent.x + parent.width &&
  child.y + child.height <= parent.y + parent.height;

const REQUIRED = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
];
for (const element of elements) {
  for (const key of REQUIRED) {
    if (!(key in element)) problems.push(`${element.type} ${element.id} is missing ${key}`);
  }
  if (!Number.isFinite(element.x) || !Number.isFinite(element.y)) {
    problems.push(`${element.type} ${element.id} has a non-finite position`);
  }
  if (element.type === "text") {
    for (const key of ["text", "fontSize", "fontFamily", "textAlign", "originalText"]) {
      if (!(key in element)) problems.push(`text ${element.id} is missing ${key}`);
    }
  }
  if (element.type === "arrow") {
    const [first] = element.points;
    if (first[0] !== 0 || first[1] !== 0) {
      problems.push(`arrow ${element.id} does not start at its own origin`);
    }
    const [, last] = element.points;
    if (Math.abs(Math.abs(last[0]) - element.width) > 0.01) {
      problems.push(`arrow ${element.id} width disagrees with its points`);
    }
    if (Math.abs(Math.abs(last[1]) - element.height) > 0.01) {
      problems.push(`arrow ${element.id} height disagrees with its points`);
    }
  }
}

const frames = elements.filter((e) => e.type === "frame");
for (const element of elements) {
  if (element.frameId === null) continue;
  const parent = frames.find((candidate) => candidate.id === element.frameId);
  if (parent === undefined) {
    problems.push(`${element.type} ${element.id} names a frame that does not exist`);
    continue;
  }
  if (!inside(element, parent)) {
    const over = Math.round(element.y + element.height - (parent.y + parent.height));
    problems.push(
      `${element.type} ${element.id} escapes frame "${parent.name}"` +
        (over > 0 ? ` — ${over}px below its bottom edge` : " — outside its bounds"),
    );
  }
}

// Shapes in the same frame must not overlap. Text is exempt: it sits on top of its shape.
const shapes = elements.filter((e) => ["rectangle", "diamond", "ellipse"].includes(e.type));
for (let i = 0; i < shapes.length; i += 1) {
  for (let j = i + 1; j < shapes.length; j += 1) {
    const a = shapes[i];
    const b = shapes[j];
    if (a.frameId !== b.frameId) continue;
    const gap =
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
    if (!gap) problems.push(`shapes ${a.id} and ${b.id} overlap in the same frame`);
  }
}

// Every label has to fit the shape it labels — this is what catches text spilling out.
for (const { shape, labels } of labelled) {
  for (const label of labels) {
    if (label.width > shape.width - 12) {
      problems.push(
        `label "${label.text.split("\n")[0].slice(0, 44)}" is ${Math.round(
          label.width - shape.width,
        )}px wider than its shape`,
      );
    }
    if (label.y + label.height > shape.y + shape.height + 2) {
      problems.push(
        `label "${label.text.split("\n")[0].slice(0, 44)}" overflows the bottom of its shape`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stdout.write(`\n${problems.length} layout problem(s):\n`);
  for (const line of [...new Set(problems)].slice(0, 40)) {
    process.stdout.write(`  ${line}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// An ASCII map, so a gross layout error is visible before anyone opens the file.
// ---------------------------------------------------------------------------
const bounds = elements.reduce(
  (acc, e) => ({
    minX: Math.min(acc.minX, e.x),
    minY: Math.min(acc.minY, e.y),
    maxX: Math.max(acc.maxX, e.x + e.width),
    maxY: Math.max(acc.maxY, e.y + e.height),
  }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
);

process.stdout.write("\nOwed — architecture diagram\n\n");
process.stdout.write(
  `  canvas        ${Math.round(bounds.maxX - bounds.minX)} x ${Math.round(bounds.maxY - bounds.minY)}\n`,
);
process.stdout.write(`  frames        ${frames.length}\n`);
process.stdout.write(`  shapes        ${shapes.length}\n`);
process.stdout.write(`  labels        ${elements.filter((e) => e.type === "text").length}\n`);
process.stdout.write(`  arrows        ${elements.filter((e) => e.type === "arrow").length}\n`);
process.stdout.write(`  elements      ${elements.length}\n\n`);

const COLS = 76;
const ROWS = 30;
const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));
const sx = (x) => Math.round(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * (COLS - 1));
const sy = (y) => Math.round(((y - bounds.minY) / (bounds.maxY - bounds.minY)) * (ROWS - 1));
for (const [index, f] of frames.entries()) {
  const mark = index === 0 ? "O" : String(index);
  for (let x = sx(f.x); x <= sx(f.x + f.width); x += 1) {
    for (let y = sy(f.y); y <= sy(f.y + f.height); y += 1) {
      if (grid[y] !== undefined && grid[y][x] !== undefined) grid[y][x] = mark;
    }
  }
}
for (const row of grid) process.stdout.write(`  ${row.join("")}\n`);
process.stdout.write("\n  O = overview, 1-9 = the detail frames, in reading order\n");
for (const [index, f] of frames.entries()) {
  if (index === 0) continue;
  process.stdout.write(`    ${index}. ${f.name}\n`);
}

// ---------------------------------------------------------------------------
const file = {
  type: "excalidraw",
  version: 2,
  source: "https://github.com/kaustubh76/Owed",
  elements,
  appState: {
    gridSize: null,
    gridStep: 5,
    gridModeEnabled: false,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
};

const json = `${JSON.stringify(file, null, 2)}\n`;
const reparsed = JSON.parse(json);
if (reparsed.elements.length !== elements.length) {
  process.stdout.write("\nthe file does not round-trip through JSON\n");
  process.exit(1);
}

writeFileSync(OUT, json);
process.stdout.write(
  `\n  written to ${relative(REPO_ROOT, OUT)} — ${Math.round(json.length / 1024)} KB\n` +
    "  open it at excalidraw.com, or with the Excalidraw extension in VS Code\n",
);
