/**
 * The parts of the views that are reusable as code rather than as a bundle.
 *
 * `package.json` has always pointed `main`, `types` and `exports["."]` at
 * `./dist/index.js`, and there was no `src/index.ts` — so `import "@owed/ui-views"`
 * failed while `@owed/ui-views/views/ledger/index.html` worked. The entry point was
 * declared and not built.
 *
 * What belongs here is the host-facing contract, not the cards: the three view URIs a
 * server registers, the theme the host passes down, the hook a view uses to receive its
 * tool result, and the labels and ordering the ledger card applies to a promise status.
 * The cards themselves stay out — they are React components compiled into single-file
 * bundles for a sandboxed iframe, and importing one into another app would be using them
 * for something they are not.
 */

export { STANCE_LABEL, UNWATCHED_REASON } from "./evidence/labels.js";
export { byAttention, KIND_LABEL, PERIOD_LABEL, STATUS_LABEL } from "./ledger/labels.js";
export { applyTheme } from "./shared/theme.js";
export {
  type OwedViewOptions,
  type OwedViewState,
  type ParseResult,
  useOwedView,
} from "./shared/useOwedView.js";

/**
 * The views this package builds, and the `ui://` URI each is served under.
 *
 * Declared here so a host does not have to spell the URIs out and get them subtly wrong;
 * `packages/mcp-server/src/views.ts` keeps the authoritative map and this agrees with it.
 */
export const VIEW_NAMES = ["ledger", "claim", "evidence"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

/** Where a built view lands, relative to the package root. */
export function viewEntry(name: ViewName): string {
  return `views/${name}/index.html`;
}
