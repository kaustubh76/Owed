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
  const { connected, session, error, turn, frames, now, range, speak, scrub, answer } = useBrain();

  /**
   * Both hops good — the same condition the badge below calls `--on`.
   *
   * The badge was made honest about the two hops after a brain with an expired token sat
   * behind a header reading "brain connected" while every utterance failed. The *controls*
   * were left reading `connected` alone, which is the same bug one layer down: with the
   * socket open and the add-on unreachable, the header said "add-on unreachable" while the
   * microphone, the scrubber and the proactive offer all still behaved as though someone
   * were listening. Speaking into that does nothing — `send` only no-ops when the socket is
   * shut, and here it is open.
   *
   * One derived value, used everywhere liveness is implied, so the indicator and the
   * controls cannot disagree again.
   */
  const live = connected && session === "live";
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
          className={`app__status app__status--${live ? "on" : connected ? "warn" : "off"}`}
          title={error ?? ""}
        >
          {live
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
            Owed speaking first. Badged, loudly, because we found no documented proactive channel
            for add-ons and a judge must never have to guess which part of this is real.
          */}
          {turn?.proactive ? (
            <div className={`app__proactive app__proactive--${turn.proactive.urgency}`}>
              <p className="app__proactive-line">
                <span className="app__proactive-badge">simulated proactive</span>
                Owed spoke first &middot; {turn.proactive.kind.replace(/_/g, " ")} &middot;{" "}
                {turn.proactive.urgency} urgency &middot; stale after{" "}
                {formatScenarioTime(turn.proactive.expires_at)}
              </p>
              {/*
                The offer, from the event rather than from a script.
                `docs/proactive.md` calls this the field without which an announcement is a
                dead end, and the household answering it is the whole beat: a reply that
                routes to `claim_file` with the promise the event was about.
              */}
              {turn.proactive.offer ? (
                <button
                  type="button"
                  className="app__proactive-offer"
                  disabled={!live}
                  title={`${turn.proactive.offer.tool} ${JSON.stringify(turn.proactive.offer.arguments)}`}
                  onClick={() => {
                    const offer = turn.proactive?.offer;
                    // The offer's own tool and arguments, not its words. Sending the words
                    // made the brain guess a subject from `#focus`, which the announcement
                    // that arrived after this one had already moved.
                    if (offer) answer(offer);
                  }}
                >
                  {turn.proactive.offer.utterance}
                  <span className="app__proactive-tool">{turn.proactive.offer.tool}</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {surface === "show" ? (
            <EchoShow view={turn?.view} />
          ) : (
            <EchoDot reply={turn?.reply ?? null} listening={live} />
          )}

          {/* The Dot renders the speech itself; printing it twice says it is decoration. */}
          <VoiceBar
            onSpeak={speak}
            connected={live}
            reply={surface === "dot" ? null : (turn?.reply ?? null)}
          />

          <Scrubber now={now} range={range} connected={live} onScrub={scrub} />

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
