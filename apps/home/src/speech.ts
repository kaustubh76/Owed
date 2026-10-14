/**
 * The browser's speech APIs, typed and feature-detected.
 *
 * `SpeechRecognition` is not in TypeScript's DOM library because it has never been on a
 * standards track — Chrome ships it as `webkitSpeechRecognition` and the unprefixed name
 * is an alias. So the shape is declared here rather than reached for with a cast, which
 * `noExplicitAny` would refuse anyway.
 *
 * Only what this app uses is declared. A narrower type that is true beats a complete one
 * copied from a spec nobody implements.
 */

export interface SpeechResultAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechResultAlternative;
}

export interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}

export interface SpeechRecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}

/** `no-speech`, `not-allowed`, `network`, `aborted`, … — kept open, it is a browser string. */
export interface SpeechRecognitionErrorEvent {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechCapableWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/**
 * The constructor, or undefined where the browser has none.
 *
 * Returned rather than a boolean so a caller gets the capability check and the thing it
 * was checking for in one go, and cannot drift between them.
 */
export function speechRecognitionCtor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as SpeechCapableWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * One utterance, spoken once.
 *
 * `en-US` and `interimResults: false` because the household says one short thing and the
 * add-on acts on it — a partial transcript would route a half-heard utterance to a tool
 * that files claims. `continuous: false` for the same reason: this listens for an
 * utterance, not for a conversation.
 */
export function listenOnce(
  ctor: SpeechRecognitionConstructor,
  handlers: {
    onHeard: (transcript: string) => void;
    onError: (reason: string) => void;
    onEnd: () => void;
  },
): SpeechRecognitionLike {
  const recognition = new ctor();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const result = event.results[event.resultIndex];
    const heard = result?.[0]?.transcript?.trim();
    if (heard !== undefined && heard.length > 0) handlers.onHeard(heard);
  };
  recognition.onerror = (event) => {
    handlers.onError(event.error);
  };
  recognition.onend = () => {
    handlers.onEnd();
  };

  recognition.start();
  return recognition;
}

/** Whether this browser can speak at all. */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Say one line, replacing anything already being said.
 *
 * The cancel is not tidiness — it is the barge-in. A household that interrupts has to be
 * answered about the thing they just asked, not after the previous answer finishes, and a
 * queued utterance would arrive over the top of the next one.
 */
export function say(text: string): void {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}

/** Stop speaking now. Safe to call when nothing is being said. */
export function hush(): void {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
}
