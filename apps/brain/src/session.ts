import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type FrameListener = (direction: "out" | "in", message: unknown) => void;

export interface SessionOptions {
  url: URL;
  accessToken: string;
  onFrame: FrameListener;
}

/**
 * Connect to the Owed MCP server, tapping every JSON-RPC frame on the way past.
 *
 * The protocol inspector shows exactly these frames. Capturing them at the transport
 * rather than reconstructing them from results is what makes the inspector a
 * recording instead of a plausible-looking narration (plan §4.1).
 */
export async function connectSession({
  url,
  accessToken,
  onFrame,
}: SessionOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });

  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    onFrame("out", message);
    return send(message, options);
  };

  const client = new Client({ name: "owed-brain", version: "0.1.0" });
  await client.connect(transport);

  // `connect` installs the client's own handler; wrap it once it is in place.
  const installed = transport.onmessage?.bind(transport);
  transport.onmessage = (message) => {
    onFrame("in", message);
    installed?.(message);
  };

  return client;
}
