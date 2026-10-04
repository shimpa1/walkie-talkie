import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import type { AppConfig } from "../src/config.js";
import { Conversations } from "../src/conversations.js";
import type { ConversationStore } from "../src/conversation-store.js";
import { createFleetStateProvider } from "../src/fleet-state.js";
import { Firstmate, type FirstmateClient } from "../src/firstmate.js";
import { Herdr } from "../src/herdr.js";
import type { PushApi } from "../src/push-service.js";
import { createRequestHandler } from "../src/server.js";

const here = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
export const FIXTURES_DIR = resolve(REPO_ROOT, "test", "fixtures");
export const FAKE_BIN = resolve(FIXTURES_DIR, "bin");
export const PUBLIC_DIR = resolve(REPO_ROOT, "public");

export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "reach-home-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

export interface TestServer {
  url: string;
  home: string;
  close: () => Promise<void>;
}

export async function startTestServer(options: {
  token?: string;
  home?: string;
  binDir?: string;
  push?: PushApi;
  /** Fake herdr CLI for the Conversations routes; omit to leave herdr unresolved. */
  herdrBin?: string;
  herdrSession?: string;
  /** Optional agent store double for the Conversations history route. */
  conversationStore?: ConversationStore;
  /** Optional firstmate client double, overriding the binDir-backed one. */
  firstmate?: FirstmateClient;
  /** Overrides the receipts read bound so tests need not wait the default. */
  receiptsReadTimeoutMs?: number;
} = {}): Promise<TestServer> {
  const home = options.home ?? makeHome();
  const token = options.token ?? "test-token";
  const binDir = options.binDir ?? FAKE_BIN;

  const config: AppConfig = {
    mode: "standalone",
    gateway: null,
    fmHome: home,
    fmBin: binDir,
    host: "127.0.0.1",
    port: 0,
    token,
    publicDir: PUBLIC_DIR,
    allowPublicBind: false,
    configFile: null,
    vapidSubject: "mailto:test@localhost",
    vapidPublicKey: null,
    vapidPrivateKey: null,
    pushPollSeconds: 20,
    pushStorePath: join(home, "walkie-talkie.push.json"),
    herdrSession: options.herdrSession ?? "default",
    herdrBin: options.herdrBin ?? "herdr",
    opencodeDbPath: join(home, ".local", "share", "opencode", "opencode.db"),
  };
  const firstmate =
    options.firstmate ?? new Firstmate({ binDir, env: { ...process.env, FM_HOME: home } });
  const conversations = new Conversations(
    new Herdr({ binPath: config.herdrBin, session: config.herdrSession, env: { ...process.env, FM_HOME: home } }),
    options.conversationStore ?? null,
    createFleetStateProvider(firstmate),
  );
  const server: Server = createServer(
    createRequestHandler({
      config,
      firstmate,
      conversations,
      ...(options.receiptsReadTimeoutMs !== undefined
        ? { receiptsReadTimeoutMs: options.receiptsReadTimeoutMs }
        : {}),
      ...(options.push ? { push: options.push } : {}),
    }),
  );

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    home,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

export async function getJson(
  url: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url + path, { headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
