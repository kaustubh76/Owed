import { useEffect, useRef, useState } from "react";
import type { ScenarioRange } from "./useBrain.js";

/** Quarter-hour steps: fine enough to land on a breach, coarse enough to drag across a week. */
const STEP_MS = 15 * 60 * 1000;
/** Dragging emits continuously; the server is only told where the drag settled. */
const SETTLE_MS = 120;

const DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "America/Los_Angeles",
});
const STAMP = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Los_Angeles",
});

/**
 * Move the household through its week.
 *
 * Every tool answers for the instant on the clock, so this changes what Owed says
 * without any tool knowing a scrubber exists — including whether it has anything to
 * say unprompted. Dragging onto Sunday evening is what makes the proactive beat happen.
 */
export function Scrubber({
  now,
  range,
  connected,
  onScrub,
}: {
  now: string | null;
  range: ScenarioRange | null;
  connected: boolean;
  onScrub: (instant: string) => void;
}) {
  const startMs = range ? Date.parse(range.start) : 0;
  const endMs = range ? Date.parse(range.end) : 0;

  // Held locally while dragging so the label tracks the thumb rather than the network.
  const [dragging, setDragging] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (!range || !now || endMs <= startMs) return null;

  const at = dragging ?? Date.parse(now);

  const move = (ms: number) => {
    setDragging(ms);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDragging(null);
      onScrub(new Date(ms).toISOString());
    }, SETTLE_MS);
  };

  const days: number[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) days.push(ms);

  return (
    <section className="scrub">
      <div className="scrub__head">
        <span className="scrub__label">Timeline</span>
        <output className="scrub__at">{STAMP.format(new Date(at))}</output>
      </div>

      <input
        className="scrub__range"
        type="range"
        min={startMs}
        max={endMs}
        step={STEP_MS}
        value={at}
        disabled={!connected}
        aria-label="Scenario time"
        onChange={(event) => move(Number(event.target.value))}
      />

      <div className="scrub__days" aria-hidden="true">
        {days.map((ms) => (
          <span className="scrub__day" key={ms}>
            {DAY.format(new Date(ms))}
          </span>
        ))}
      </div>
    </section>
  );
}
