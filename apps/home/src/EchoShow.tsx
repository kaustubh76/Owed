import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { useEffect, useRef } from "react";
import type { ViewPayload } from "./useBrain.js";

const HOST_INFO = { name: "Owed simulated home", version: "0.1.0" } as const;

const LIGHT = "(prefers-color-scheme: light)";

/** What the host should tell the view, from the viewer's own setting. */
function preferredTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT).matches ? "light" : "dark";
}

/**
 * An Echo Show 8 rendered at its documented 768x480 base canvas.
 *
 * The card is a real MCP Apps view: HTML fetched from the server as a `ui://`
 * resource and handed to a sandboxed iframe, which is spoken to only over
 * postMessage. Omitting `allow-same-origin` gives the frame an opaque origin, so it
 * cannot reach anything belonging to this page.
 *
 * The theme comes from the viewer rather than a constant. `ui-views` ships a complete
 * light palette and `applyTheme` has always honoured it, but this host sent a hardcoded
 * `"dark"` — so half the design system was unreachable and no check ever rendered it. A
 * real host passes its own appearance down, and `setHostContext` is how the spec says to
 * do it, so this follows `prefers-color-scheme` and keeps following it if it changes.
 */
export function EchoShow({ view }: { view: ViewPayload | undefined }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !view) return;

    let bridge: AppBridge | undefined;
    let cancelled = false;
    let media: MediaQueryList | undefined;
    const onSchemeChange = () => bridge?.setHostContext({ theme: preferredTheme() });

    const onLoad = () => {
      const win = iframe.contentWindow;
      if (!win || cancelled) return;

      bridge = new AppBridge(null, HOST_INFO, {});
      bridge.oninitialized = () => {
        void (async () => {
          bridge?.setHostContext({ theme: preferredTheme() });
          // The spec requires tool input to be sent once before any tool result.
          await bridge?.sendToolInput({ arguments: {} });
          await bridge?.sendToolResult(view.result as Parameters<AppBridge["sendToolResult"]>[0]);
        })();
      };
      void bridge.connect(new PostMessageTransport(win, win));

      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        media = window.matchMedia(LIGHT);
        media.addEventListener("change", onSchemeChange);
      }
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      cancelled = true;
      iframe.removeEventListener("load", onLoad);
      media?.removeEventListener("change", onSchemeChange);
      void bridge?.close();
    };
  }, [view]);

  return (
    <div className="echo">
      <div className="echo__bezel">
        {view ? (
          <iframe
            key={view.uri}
            ref={frameRef}
            className="echo__screen"
            title="Owed card"
            srcDoc={view.html}
            sandbox="allow-scripts"
          />
        ) : (
          <div className="echo__idle">
            <span className="echo__idle-dot" />
            Ask Owed what you are owed.
          </div>
        )}
      </div>
      <p className="echo__label">Echo Show 8 &middot; 768 &times; 480 base canvas</p>
    </div>
  );
}
