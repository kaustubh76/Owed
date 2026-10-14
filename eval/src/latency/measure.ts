/**
 * Tool latency, measured over real Streamable HTTP.
 *
 * Separate from the gate in `packages/mcp-server/src/alexa/contract.test.ts`, and the
 * split is deliberate. That one is a *threshold*: 500 ms, three attempts, there to fail a
 * regression and nothing else. This one is a *measurement*: it publishes a distribution
 * and commits it to `eval/results/latency.json`, so the figures the README quotes come out
 * of a file rather than out of someone's terminal scrollback.
 *
 * The distinction matters because the previous README figure — "p95 4.7–35 ms across the
 * tool surface" — was neither. It was printed to stdout by a test that timed one tool and
 * discarded the number.
 */

export interface ToolLatency {
  tool: string;
  samples: number;
  min_ms: number;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
  mean_ms: number;
}

export interface LatencyReport {
  measured_at: string;
  /** What the machine was, because a latency number without one is not a number. */
  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    load_average_1m: number;
  };
  target_ms: number;
  samples_per_tool: number;
  tools: ToolLatency[];
  worst: { tool: string; p95_ms: number };
  met: boolean;
}

/** Nearest-rank percentile. No interpolation: every value reported is one that happened. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarise(tool: string, durations: readonly number[]): ToolLatency {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    tool,
    samples: sorted.length,
    min_ms: round(sorted[0] ?? 0),
    median_ms: round(percentile(sorted, 0.5)),
    p95_ms: round(percentile(sorted, 0.95)),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
    mean_ms: round(sorted.length === 0 ? 0 : total / sorted.length),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The worst tool decides the verdict.
 *
 * A mean across tools would let a fast projection hide a slow one, and the household is
 * waiting on whichever tool their sentence happened to route to.
 */
export function verdict(tools: readonly ToolLatency[], targetMs: number) {
  const worst = tools.reduce(
    (a, b) => (b.p95_ms > a.p95_ms ? b : a),
    tools[0] ?? {
      tool: "none",
      p95_ms: 0,
      samples: 0,
      min_ms: 0,
      median_ms: 0,
      max_ms: 0,
      mean_ms: 0,
    },
  );
  return { worst: { tool: worst.tool, p95_ms: worst.p95_ms }, met: worst.p95_ms < targetMs };
}
