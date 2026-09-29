import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FixedClock, MemoryEventStore, SeededIdGen } from "@owed/core";
import { createOwedApp } from "../app.js";
import { type AuthConfig, defaultAuthConfig } from "../auth/config.js";
import { linkAccount } from "../auth/link.js";
import type { OwedDeps } from "../deps.js";
import { inProcessMerchants } from "../merchants/inProcess.js";
import {
  CURRENCY,
  HOUSEHOLD_ID,
  STORYBOARD_QUERY_AT,
  storyboardEvents,
} from "../seed/storyboard.js";

export interface Harness {
  baseUrl: URL;
  mcpUrl: URL;
  authConfig: AuthConfig;
  clock: FixedClock;
  deps: OwedDeps;
  /** Complete a real authorization-code + PKCE link and return the access token. */
  link(clientId?: string): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Defaults to on, because that is how the server actually runs. */
  auth?: boolean;
  now?: string;
  secret?: string;
}

/**
 * Boot the real app on an ephemeral port.
 *
 * Tests talk to it over real HTTP with the real client rather than poking handlers,
 * so anything a host would hit — middleware order, headers, status codes — is covered.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const idGen = new SeededIdGen();
  const store = new MemoryEventStore();
  await store.append(await storyboardEvents(idGen));

  const clock = new FixedClock(options.now ?? STORYBOARD_QUERY_AT);
  const deps: OwedDeps = {
    store,
    clock,
    householdId: HOUSEHOLD_ID,
    currency: CURRENCY,
    idGen,
    merchants: inProcessMerchants(),
  };

  // The port is only known after listen, so bind first and build the config against it.
  const placeholder = new URL("http://127.0.0.1:0");
  let authConfig = defaultAuthConfig(placeholder, options.secret ?? "test-secret");

  const app = createOwedApp({
    deps,
    ...(options.auth === false ? {} : { auth: { config: proxyConfig(() => authConfig) } }),
    scrubbableClock: clock,
  });

  const http = await new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

  const { port } = http.address() as AddressInfo;
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  authConfig = defaultAuthConfig(baseUrl, options.secret ?? "test-secret");

  return {
    baseUrl,
    mcpUrl: new URL("/mcp", baseUrl),
    authConfig,
    clock,
    deps,
    link: async (clientId = "owed-simulated-home") => {
      const result = await linkAccount({ baseUrl, clientId });
      return result.accessToken;
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/**
 * The authorization server's own URLs depend on the port it ends up on, so the
 * config is read lazily rather than captured before `listen` resolves.
 */
function proxyConfig(read: () => AuthConfig): AuthConfig {
  return new Proxy({} as AuthConfig, {
    get: (_target, property) => Reflect.get(read(), property),
    has: (_target, property) => Reflect.has(read(), property),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(read(), property),
  });
}
