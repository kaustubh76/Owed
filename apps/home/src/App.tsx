import { EchoShow } from "./EchoShow.js";
import { Inspector } from "./Inspector.js";
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

export function App() {
  const { connected, turn, frames, now, speak } = useBrain();

  return (
    <div className="app">
      <header className="app__bar">
        <h1 className="app__title">Owed</h1>
        <span className="app__tag">simulated household</span>
        <span className="app__clock" title={now ?? ""}>
          scenario time &middot; {formatScenarioTime(now)}
        </span>
        <span className={`app__status app__status--${connected ? "on" : "off"}`}>
          {connected ? "brain connected" : "brain offline"}
        </span>
      </header>

      <main className="app__stage">
        <div className="app__household">
          <EchoShow view={turn?.view} />
          <VoiceBar onSpeak={speak} connected={connected} reply={turn?.reply ?? null} />
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
