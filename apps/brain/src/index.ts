/**
 * The brain as a library, next to the process it also is.
 *
 * `package.json` has always pointed `main`, `types` and `exports["."]` at
 * `./dist/index.js` while the real entry point is `dist/main.js` — the one
 * `deploy/owed-brain.service` runs. So the declared module entry resolved to nothing and
 * `import "@owed/brain"` failed.
 *
 * Two things live here rather than one. The **wire protocol** is the contract the
 * simulated home is written against, and `apps/home` currently redeclares a parallel copy
 * of it by hand (`apps/home/src/useBrain.ts` says so in a comment) because there was no
 * way to import it. And the **session** and **intent router** are the two pieces with
 * behaviour worth driving from a test or another host; `session.test.ts` already imports
 * them by relative path.
 *
 * `main.ts` stays the executable and is deliberately not re-exported: importing it would
 * start a server as a side effect of a type import.
 */

export { OwedBrain } from "./brain.js";
export { INTENTS, type Intent, routeUtterance } from "./intents.js";
export type {
  ClockMessage,
  ErrorMessage,
  FrameMessage,
  ProactiveMessage,
  ScrubMessage,
  SessionMessage,
} from "./protocol.js";
export {
  type Established,
  openSession,
  RENEW_AT,
  type SessionHandle,
  type SessionOptions,
} from "./session.js";
