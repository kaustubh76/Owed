import { generateGrid } from "@owed/merchant-agents";
import { beforeAll, describe, expect, it } from "vitest";
import { type LearningReport, runLearningMatrix } from "./learning.js";

/**
 * The honesty guards on the learning evaluation.
 *
 * A learner scored on the grid it memorised is worth nothing. These are the checks that
 * would catch it, and they run in CI rather than being asserted in a README.
 */
let sampled: LearningReport;
let wholeGrid: LearningReport;

beforeAll(async () => {
  // Enough policies to cover every merchant archetype, and enough episodes to pass the
  // exploration threshold. The matrices are computed once and shared.
  sampled = await runLearningMatrix(generateGrid().slice(0, 40), 6);
  // One episode across the whole grid: coverage, not convergence. grid.test.ts is what
  // pins the grid's contents.
  wholeGrid = await runLearningMatrix(generateGrid(), 1);
}, 120_000);

describe("the learning evaluation", () => {
  it("starts cold — episode one must equal the non-learning negotiator", () => {
    // Any divergence means the learner is seeing something a household would not have
    // on first contact with a merchant.
    expect(sampled.first_episode.realised_minor).toBe(sampled.cold.realised_minor);
    expect(wholeGrid.first_episode.realised_minor).toBe(wholeGrid.cold.realised_minor);
  });

  it("never exceeds what perfect information would achieve", () => {
    expect(sampled.last_episode.share).toBeLessThanOrEqual(sampled.oracle.share + 1e-9);
    expect(sampled.advantage_captured).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("does not make things worse than not learning at all", () => {
    expect(sampled.last_episode.share).toBeGreaterThanOrEqual(sampled.cold.share);
    expect(sampled.learned_loss_rate).toBeLessThanOrEqual(sampled.cold_loss_rate);
  });

  it("runs on the unchanged pre-registered grid", () => {
    expect(wholeGrid.grid_size).toBe(generateGrid().length);
    expect(wholeGrid.cells).toBe(generateGrid().length * 6);
  });
});
