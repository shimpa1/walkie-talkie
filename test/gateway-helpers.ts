import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Catalog } from "../src/catalog.js";
import type { AppConfig } from "../src/config.js";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../src/cookies.js";
import type { GatewayConfig, StaticTenant } from "../src/gateway-config.js";
import { createGatewayHandler, defaultSignInLimits } from "../src/gateway.js";
import { GatewayStore, type AuditEntry } from "../src/gateway-store.js";
import { GithubOAuth, type GithubIdentity } from "../src/github-oauth.js";
import type { KeyChecker } from "../src/key-check.js";
import type { RateLimiter } from "../src/rate-limit.js";
import type { Vault } from "../src/vault.js";
import { PUBLIC_DIR } from "./helpers.js";

export const ORIGIN = "https://walkie.example";
export const CLIENT_ID = "Iv1.testclientid";
export const CLIENT_SECRET = "canary-client-secret-5f2b9c";

/** Read the audit table straight from the database file, newest first. */
export async function readAudit(dbPath: string): Promise<AuditEntry[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT at, actor, action, subject, detail FROM audit ORDER BY id DESC").all();
    return rows.map((row) => ({
      at: Number(row.at),
      actor: row.actor === null ? null : String(row.actor),
      action: String(row.action),
      subject: row.subject === null ? null : String(row.subject),
      detail: row.detail === null ? null : (JSON.parse(String(row.detail)) as AuditEntry["detail"]),
    }));
  } finally {
    db.close();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface TokenExchange {
  clientId: string | null;
  clientSecret: string | null;
  code: string | null;
  redirectUri: string | null;
  codeVerifier: string | null;
}

/**
 * A stand-in for github.com and api.github.com. A test "authorizes" by calling
 * `issue`, which mints a code bound to the PKCE challenge the gateway sent; the
 * token endpoint then demands the matching verifier and client secret, exactly
 * as GitHub does.
 */
export interface FakeGithub {
  url: string;
  exchanges: TokenExchange[];
  /** Access tokens the fake has handed out (to prove none of them leaks). */
  issuedTokens: string[];
  issue: (identity: GithubIdentity, challenge: string) => string;
  /** Make every subsequent /user read fail with this status. */
  failUser: (status: number | null) => void;
  close: () => Promise<void>;
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const codes = new Map<string, { identity: GithubIdentity; challenge: string }>();
  const tokens = new Map<string, GithubIdentity>();
  const exchanges: TokenExchange[] = [];
  const issuedTokens: string[] = [];
  let userFailure: number | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://github.invalid");
      if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const form = new URLSearchParams(await readAll(req));
        const exchange: TokenExchange = {
          clientId: form.get("client_id"),
          clientSecret: form.get("client_secret"),
          code: form.get("code"),
          redirectUri: form.get("redirect_uri"),
          codeVerifier: form.get("code_verifier"),
        };
        exchanges.push(exchange);
        const grant = exchange.code === null ? undefined : codes.get(exchange.code);
        if (exchange.code !== null) codes.delete(exchange.code);
        const verifierOk =
          grant !== undefined &&
          exchange.codeVerifier !== null &&
          createHash("sha256").update(exchange.codeVerifier).digest("base64url") === grant.challenge;
        res.writeHead(200, { "content-type": "application/json" });
        if (grant === undefined || !verifierOk || exchange.clientSecret !== CLIENT_SECRET) {
          // GitHub reports a failed exchange as 200 with an error body.
          res.end(JSON.stringify({ error: "bad_verification_code", error_description: `leaky ${exchange.code}` }));
          return;
        }
        const token = `gho_${randomBytes(12).toString("hex")}`;
        tokens.set(token, grant.identity);
        issuedTokens.push(token);
        res.end(JSON.stringify({ access_token: token, token_type: "bearer", scope: "" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/user") {
        const auth = req.headers.authorization ?? "";
        const identity = tokens.get(auth.replace(/^Bearer /, ""));
        if (userFailure !== null || identity === undefined) {
          res.writeHead(userFailure ?? 401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: identity.id, login: identity.login, type: "User" }));
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
  const url = await listen(server);
  return {
    url,
    exchanges,
    issuedTokens,
    issue: (identity, challenge) => {
      const code = randomBytes(10).toString("hex");
      codes.set(code, { identity, challenge });
      return code;
    },
    failUser: (status) => {
      userFailure = status;
    },
    close: () => close(server),
  };
}

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A firstmate's walkie-talkie service that records what reached it. */
export interface FakeUpstream {
  url: string;
  name: string;
  requests: UpstreamRequest[];
  respond: (handler: ((req: UpstreamRequest, res: ServerResponse) => void) | null) => void;
  close: () => Promise<void>;
}

export async function startFakeUpstream(name: string): Promise<FakeUpstream> {
  const requests: UpstreamRequest[] = [];
  let handler: ((req: UpstreamRequest, res: ServerResponse) => void) | null = null;
  const server = createServer((req, res) => {
    void (async () => {
      const record: UpstreamRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: await readAll(req),
      };
      requests.push(record);
      if (handler !== null) {
        handler(record, res);
        return;
      }
      const body = JSON.stringify({ upstream: name, path: record.url });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "set-cookie": "upstream=should-not-pass; Path=/",
        "x-upstream-secret": "should-not-pass",
      });
      res.end(body);
    })();
  });
  const url = await listen(server);
  return {
    url,
    name,
    requests,
    respond: (next) => {
      handler = next;
    },
    close: () => close(server),
  };
}

export interface GatewayHarness {
  url: string;
  store: GatewayStore;
  logs: string[];
  config: AppConfig;
  advance: (ms: number) => void;
  /** Close the store early (to read the flushed file); close() then skips it. */
  closeStore: () => void;
  close: () => Promise<void>;
}

export interface GatewayOptions {
  github: FakeGithub;
  admins?: number[];
  staticTenants?: StaticTenant[];
  legacyBearer?: boolean;
  token?: string;
  dbPath?: string;
  trustedProxyHops?: number;
  accessRequests?: boolean;
  signInLimits?: { perClient: RateLimiter; global: RateLimiter };
  linkLimits?: { perClient: RateLimiter; global: RateLimiter };
  proxyTimeoutMs?: number;
  catalog?: Catalog | null;
  vault?: Vault | null;
  keyChecker?: KeyChecker;
  keyCheckLimits?: { perUser: RateLimiter; global: RateLimiter };
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHarness> {
  let clock = Date.parse("2026-10-04T12:00:00Z");
  const now = (): number => clock;
  const dbPath = options.dbPath ?? join(mkdtempSync(join(tmpdir(), "wt-gateway-")), "gateway.db");
  const gateway: GatewayConfig = {
    publicOrigin: ORIGIN,
    githubClientId: CLIENT_ID,
    githubClientSecret: CLIENT_SECRET,
    admins: options.admins ?? [1001],
    staticTenants: options.staticTenants ?? [],
    dbPath,
    legacyBearer: options.legacyBearer ?? false,
    trustedProxyHops: options.trustedProxyHops ?? 0,
    accessRequests: options.accessRequests ?? true,
    catalog: options.catalog ?? null,
    vault: options.vault ?? null,
  };
  const config: AppConfig = {
    mode: "gateway",
    gateway,
    fmHome: "/nonexistent",
    fmBin: "/nonexistent/bin",
    host: "127.0.0.1",
    port: 0,
    token: options.token ?? "",
    publicDir: PUBLIC_DIR,
    allowPublicBind: false,
    configFile: null,
    vapidSubject: "mailto:test@localhost",
    vapidPublicKey: null,
    vapidPrivateKey: null,
    pushPollSeconds: 20,
    pushStorePath: "/nonexistent/push.json",
    herdrSession: "default",
    herdrBin: "herdr",
    opencodeDbPath: "/nonexistent/opencode.db",
  };
  const sqlite = await import("node:sqlite");
  const store = GatewayStore.open(sqlite, dbPath);
  const oauth = new GithubOAuth({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: `${ORIGIN}/auth/github/callback`,
    endpoints: {
      authorizeUrl: `${options.github.url}/login/oauth/authorize`,
      tokenUrl: `${options.github.url}/login/oauth/access_token`,
      apiUrl: options.github.url,
    },
  });
  const logs: string[] = [];
  let storeClosed = false;
  const server = createServer(
    createGatewayHandler({
      config,
      store,
      oauth,
      now,
      log: (line) => logs.push(line),
      signInLimits: options.signInLimits ?? defaultSignInLimits(now),
      ...(options.linkLimits !== undefined ? { linkLimits: options.linkLimits } : {}),
      ...(options.proxyTimeoutMs !== undefined ? { proxyTimeoutMs: options.proxyTimeoutMs } : {}),
      ...(options.keyChecker !== undefined ? { keyChecker: options.keyChecker } : {}),
      ...(options.keyCheckLimits !== undefined ? { keyCheckLimits: options.keyCheckLimits } : {}),
    }),
  );
  const url = await listen(server);
  return {
    url,
    store,
    logs,
    config,
    advance: (ms) => {
      clock += ms;
    },
    closeStore: () => {
      if (!storeClosed) store.close();
      storeClosed = true;
    },
    close: async () => {
      await close(server);
      if (!storeClosed) store.close();
      storeClosed = true;
    },
  };
}

/** A Set-Cookie value by cookie name, with its attributes. */
export function setCookie(response: Response, name: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) return cookie;
  }
  return null;
}

export function cookieValue(response: Response, name: string): string | null {
  const cookie = setCookie(response, name);
  if (cookie === null) return null;
  return cookie.slice(name.length + 1).split(";")[0] ?? null;
}

export interface SignInResult {
  callback: Response;
  /** The `__Host-wt_session` value, or null when no session was issued. */
  session: string | null;
  /** Where the callback redirected. */
  location: string | null;
}

/**
 * Drive the whole browser sign-in: start, "approve" on the fake GitHub, and
 * return through the callback with the pre-auth cookie.
 */
export async function signIn(
  gateway: GatewayHarness,
  github: FakeGithub,
  identity: GithubIdentity,
  tamper: { state?: string; cookie?: string | null; code?: string } = {},
): Promise<SignInResult> {
  const start = await fetch(`${gateway.url}/auth/github/start`, { redirect: "manual" });
  const authorize = new URL(start.headers.get("location") ?? "");
  const loginCookie = cookieValue(start, LOGIN_COOKIE);
  const challenge = authorize.searchParams.get("code_challenge") ?? "";
  const code = tamper.code ?? github.issue(identity, challenge);
  const state = tamper.state ?? authorize.searchParams.get("state") ?? "";
  const cookie = tamper.cookie === undefined ? loginCookie : tamper.cookie;
  const callback = await fetch(
    `${gateway.url}/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    {
      redirect: "manual",
      headers: cookie === null ? {} : { cookie: `${LOGIN_COOKIE}=${cookie}` },
    },
  );
  return {
    callback,
    session: cookieValue(callback, SESSION_COOKIE),
    location: callback.headers.get("location"),
  };
}

export function sessionHeaders(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${session}`, ...extra };
}
