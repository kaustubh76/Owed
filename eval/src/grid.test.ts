import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { behaviourId, GRID_PARAMETERS, generateGrid } from "@owed/merchant-agents";
import { describe, expect, it } from "vitest";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../data/policies/grid.json", import.meta.url)), "utf8"),
) as {
  parameters: Record<string, unknown>;
  size: number;
  policies: Array<Record<string, unknown>>;
};

/**
 * Pre-registration, enforced.
 *
 * The merchant grid was fixed before the negotiator was tuned against it. Claiming that
 * is worth nothing on its own, so this test pins the committed file to the generator:
 * quietly widening the grid, dropping the merchants that punish a counter, or reordering
 * it after seeing a disappointing number all turn the suite red.
 */
describe("the pre-registered grid", () => {
  it("still matches the generator, parameter for parameter", () => {
    expect(committed.parameters).toEqual(JSON.parse(JSON.stringify(GRID_PARAMETERS)));
  });

  it("still contains exactly the policies the generator produces, in order", () => {
    const generated = generateGrid().map((behaviour) => ({
      id: behaviourId(behaviour),
      ...behaviour,
    }));

    expect(committed.size).toBe(generated.length);
    expect(committed.policies).toEqual(JSON.parse(JSON.stringify(generated)));
  });

  it("still includes merchants that punish a counter", () => {
    const adversarial = committed.policies.filter((p) => p.withdraws_on_counter === true);

    expect(adversarial.length).toBeGreaterThan(0);
    expect(adversarial.length).toBe(committed.policies.length / 2);
  });
});
