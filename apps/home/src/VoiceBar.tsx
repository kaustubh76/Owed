import { useState } from "react";

/**
 * Three ways in, on purpose.
 *
 * Browser speech recognition is Chrome-only and network-dependent, so the scripted
 * buttons carry the storyboard's exact lines and the demo is never hostage to a
 * microphone (plan §8).
 */
const SCRIPT = ["Alexa, what am I owed?", "Why aren't you claiming that?", "File it"] as const;

export interface VoiceBarProps {
  onSpeak: (text: string) => void;
  connected: boolean;
  reply: string | null;
}

export function VoiceBar({ onSpeak, connected, reply }: VoiceBarProps) {
  const [typed, setTyped] = useState("");

  const speak = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !connected) return;
    onSpeak(trimmed);
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  };

  return (
    <section className="voice">
      <div className="voice__script">
        {SCRIPT.map((line) => (
          <button
            key={line}
            type="button"
            className="voice__chip"
            disabled={!connected}
            onClick={() => speak(line)}
          >
            {line}
          </button>
        ))}
      </div>

      <form
        className="voice__form"
        onSubmit={(event) => {
          event.preventDefault();
          speak(typed);
          setTyped("");
        }}
      >
        <input
          className="voice__input"
          value={typed}
          placeholder="or type an utterance"
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Utterance"
        />
        <button className="voice__send" type="submit" disabled={!connected}>
          Say it
        </button>
      </form>

      {reply ? <p className="voice__reply">&ldquo;{reply}&rdquo;</p> : null}
    </section>
  );
}
