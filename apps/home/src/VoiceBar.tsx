import { useEffect, useRef, useState } from "react";
import {
  canSpeak,
  hush,
  listenOnce,
  type SpeechRecognitionLike,
  say,
  speechRecognitionCtor,
} from "./speech.js";

/**
 * Four ways in, and the scripted ones stay first.
 *
 * Browser speech recognition is Chrome-only and network-dependent, so the scripted buttons
 * carry the storyboard's exact lines and the demo is never hostage to a microphone
 * (plan §8). The microphone and the spoken replies are real, and both are **opt-in**: a
 * recording of this demo must not depend on a permission prompt or on whatever voice the
 * host machine happens to have installed.
 *
 * So the capability is here for anyone who wants to talk to it, and off by default for
 * anyone who wants a deterministic take.
 */
const SCRIPT = ["Alexa, what am I owed?", "Why aren't you claiming that?", "File it"] as const;

export interface VoiceBarProps {
  onSpeak: (text: string) => void;
  connected: boolean;
  reply: string | null;
}

export function VoiceBar({ onSpeak, connected, reply }: VoiceBarProps) {
  const [typed, setTyped] = useState("");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);

  // Resolved once: a capability, not a render-time guess.
  const [recognitionCtor] = useState(speechRecognitionCtor);
  const ttsAvailable = canSpeak();

  const speak = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !connected) return;
    onSpeak(trimmed);
    // Barge-in: whatever Owed was saying is no longer the answer to the live question.
    hush();
  };

  /**
   * Speak each reply once, and only while the household asked for spoken replies.
   *
   * Keyed on the reply text rather than on a render, because the same answer re-rendering
   * (a reconnect, a sibling state change) must not make the device repeat itself.
   */
  useEffect(() => {
    if (!speaking || reply === null || reply.length === 0) return;
    say(reply);
  }, [reply, speaking]);

  // Nothing should keep talking or listening after this component goes away.
  useEffect(
    () => () => {
      hush();
      recognitionRef.current?.abort();
    },
    [],
  );

  const startListening = () => {
    if (recognitionCtor === undefined || listening || !connected) return;
    setMicError(null);
    hush();
    try {
      recognitionRef.current = listenOnce(recognitionCtor, {
        onHeard: (transcript) => {
          onSpeak(transcript);
        },
        onError: (reason) => {
          // `not-allowed` is a declined permission prompt, `no-speech` is silence. Both are
          // the household's business rather than a fault, so they are reported, not thrown.
          setMicError(reason === "not-allowed" ? "microphone permission declined" : reason);
        },
        onEnd: () => {
          setListening(false);
          recognitionRef.current = undefined;
        },
      });
      setListening(true);
    } catch (error) {
      setMicError(error instanceof Error ? error.message : "could not start the microphone");
      setListening(false);
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
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

      {/*
        Rendered only where the browser actually has the API, so the page never offers a
        control that cannot work. Chrome has both; Safari has synthesis and not recognition.
      */}
      {recognitionCtor !== undefined || ttsAvailable ? (
        <div className="voice__live">
          {recognitionCtor !== undefined ? (
            <button
              type="button"
              className={`voice__mic${listening ? " voice__mic--on" : ""}`}
              disabled={!connected}
              aria-pressed={listening}
              onClick={listening ? stopListening : startListening}
            >
              <span className="voice__mic-dot" aria-hidden="true" />
              {listening ? "Listening — say it" : "Hold a conversation"}
            </button>
          ) : null}

          {ttsAvailable ? (
            <label className="voice__tts">
              <input
                type="checkbox"
                checked={speaking}
                onChange={(event) => {
                  const on = event.target.checked;
                  setSpeaking(on);
                  if (!on) hush();
                }}
              />
              Speak the replies
            </label>
          ) : null}

          {micError !== null ? (
            <span className="voice__mic-error" role="status">
              {micError}
            </span>
          ) : null}
        </div>
      ) : null}

      {reply ? <p className="voice__reply">&ldquo;{reply}&rdquo;</p> : null}
    </section>
  );
}
