import { useState } from "react";
import type { Frame } from "./useBrain.js";

function describe(message: unknown): string {
  const record = message as {
    method?: string;
    id?: number | string;
    error?: unknown;
    result?: unknown;
  };
  if (typeof record.method === "string") return record.method;
  if (record.error !== undefined) return "error";
  if (record.result !== undefined) return `result #${String(record.id ?? "")}`;
  return "message";
}

/**
 * Every frame here was captured on the wire between the brain and the server.
 * Nothing in this pane is reconstructed from a result — that is the point of it.
 */
export function Inspector({ frames }: { frames: readonly Frame[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const recourse = frames.filter((frame) => frame.channel === "recourse").length;

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <h2 className="inspector__title">Protocol inspector</h2>
        <span className="inspector__count">
          {frames.length} frames
          {recourse > 0 ? ` · ${recourse} recourse` : ""}
        </span>
      </header>

      <ol className="inspector__list">
        {frames.map((frame) => (
          <li className="inspector__row" key={frame.id}>
            <button
              type="button"
              className={`inspector__line inspector__line--${frame.channel}`}
              aria-expanded={open === frame.id}
              aria-label={`${frame.direction === "out" ? "sent" : "received"} ${describe(frame.message)}`}
              onClick={() => setOpen(open === frame.id ? null : frame.id)}
            >
              <span
                aria-hidden="true"
                className={`inspector__dir inspector__dir--${frame.direction}`}
              >
                {frame.direction === "out" ? "→" : "←"}
              </span>
              <span className="inspector__method">{describe(frame.message)}</span>
              {frame.channel === "recourse" ? (
                <span className="inspector__channel">{frame.merchant}</span>
              ) : null}
            </button>
            {open === frame.id ? (
              <pre className="inspector__json">{JSON.stringify(frame.message, null, 2)}</pre>
            ) : null}
          </li>
        ))}
      </ol>

      {frames.length === 0 ? (
        <p className="inspector__empty">No traffic yet. Say something to Owed.</p>
      ) : null}
    </aside>
  );
}
