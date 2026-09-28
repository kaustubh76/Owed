import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { useEffect, useRef } from "react";
import type { ViewPayload } from "./useBrain.js";

const HOST_INFO = { name: "Owed simulated home", version: "0.1.0" } as const;

/**
 * An Echo Show 8 rendered at its documented 768x480 base canvas.
 *
 * The card is a real MCP Apps view: HTML fetched from the server as a `ui://`
 * resource and handed to a sandboxed iframe, which is spoken to only over
 * postMessage. Omitting `allow-same-origin` gives the frame an opaque origin, so it
 * cannot reach anything belonging to this page.
 */
export function EchoShow({ view }: { view: ViewPayload | undefined }) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe || !view) return;

    let bridge: AppBridge | undefined;
    let cancelled = false;

    const onLoad = () => {
      const win = iframe.contentWindow;
      if (!win || cancelled) return;

      bridge = new AppBridge(null, HOST_INFO, {});
      bridge.oninitialized = () => {
        void (async () => {
          bridge?.setHostContext({ theme: "dark" });
          // The spec requires tool input to be sent once before any tool result.
          await bridge?.sendToolInput({ arguments: {} });
          await bridge?.sendToolResult(view.result as Parameters<AppBridge["sendToolResult"]>[0]);
        })();
      };
      void bridge.connect(new PostMessageTransport(win, win));
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      cancelled = true;
      iframe.removeEventListener("load", onLoad);
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
