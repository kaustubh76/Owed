import { useState } from "react";
import { EchoDot } from "./EchoDot.js";
import { EchoShow } from "./EchoShow.js";
import { Inspector } from "./Inspector.js";
import { Scrubber } from "./Scrubber.js";
import { useBrain } from "./useBrain.js";
import { VoiceBar } from "./VoiceBar.js";

function formatScenarioTime(instant: string | null): string {
  if (!instant) return "—";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(instant));
}

/** Which device the household is standing in front of. */
type Surface = "show" | "dot";

const SURFACES: ReadonlyArray<{ id: Surface; label: string }> = [
  { id: "show", label: "Echo Show" },
  { id: "dot", label: "Echo Dot" },
];

export function App() {
  const { connected, session, error, turn, frames, now, range, speak, scrub } = useBrain();
  const [surface, setSurface] = useState<Surface>("show");

  return (
    <div className="app">
      <header className="app__bar">
        <h1 className="app__title">Owed</h1>
        <span className="app__tag">simulated household</span>

        <fieldset className="app__surfaces">
          <legend className="app__surfaces-legend">Device</legend>
          {SURFACES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`app__surface${surface === option.id ? " app__surface--on" : ""}`}
              aria-pressed={surface === option.id}
              onClick={() => setSurface(option.id)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>

        <span className="app__clock" title={now ?? ""}>
          scenario time &middot; {formatScenarioTime(now)}
        </span>
        {/*
          Two hops, one indicator, and it has to be honest about both.

          The home's socket to the brain being open says nothing about whether the brain can
          reach the add-on, and those fail independently with the same symptom: nothing
          happens when you speak. Reporting only the first is what let a brain with an
          expired token sit behind a header reading "brain connected" while every utterance
          failed — the demo looked healthy and answered nothing.

          `--on` therefore means both hops are good, which is also what
          `scripts/verify-ui.mjs` waits for and what docs/demo-script.md tells a presenter
          "brain connected" means.
        */}
        <span
          className={`app__status app__status--${connected && session === "live" ? "on" : connected ? "warn" : "off"}`}
          title={error ?? ""}
        >
          {connected && session === "live"
            ? "brain connected"
            : connected && session === "linking"
              ? "linking…"
              : connected
                ? "add-on unreachable"
                : "brain offline"}
        </span>
      </header>

      <main className="app__stage">
        <div className="app__household">
          {/*
            Owed speaking first. Badged, loudly, because Alexa+ has no proactive channel
            for add-ons and a judge must never have to guess which part of this is real.
          */}
          {turn?.proactive ? (
            <p className={`app__proactive app__proactive--${turn.proactive.urgency}`}>
              <span className="app__proactive-badge">simulated proactive</span>
              Owed spoke first &middot; {turn.proactive.kind.replace(/_/g, " ")} &middot;{" "}
              {turn.proactive.urgency} urgency
            </p>
          ) : null}

          {surface === "show" ? (
            <EchoShow view={turn?.view} />
          ) : (
            <EchoDot reply={turn?.reply ?? null} listening={connected} />
          )}

          {/* The Dot renders the speech itself; printing it twice says it is decoration. */}
          <VoiceBar
            onSpeak={speak}
            connected={connected}
            reply={surface === "dot" ? null : (turn?.reply ?? null)}
          />

          <Scrubber now={now} range={range} connected={connected} onScrub={scrub} />

          {turn?.trace.length ? (
            <ul className="app__trace">
              {turn.trace.map((call) => (
                <li className="app__trace-item" key={call.tool}>
                  <code>{call.tool}</code>
                  <span>{call.ms} ms</span>
                  {call.resourceUri ? (
                    <span className="app__trace-uri">{call.resourceUri}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <Inspector frames={frames} />
      </main>
    </div>
  );
}
