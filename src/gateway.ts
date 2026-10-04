import type { IncomingMessage, ServerResponse } from "node:http";

import { bearerToken, constantTimeEqual } from "./auth.js";
import type { AppConfig } from "./config.js";
import { clearCookie, LOGIN_COOKIE, parseCookies, serializeCookie, SESSION_COOKIE } from "./cookies.js";
import type { GatewayConfig, StaticTenant } from "./gateway-config.js";
import { matchProxyRoute, proxyToTenant } from "./gateway-proxy.js";
import { LOGIN_ATTEMPT_MS, randomToken, SESSION_ABSOLUTE_MS, type GatewayStore } from "./gateway-store.js";
import { newCodeVerifier, OAuthError, type GithubIdentity } from "./github-oauth.js";
import { sendError, sendJson, serveStatic } from "./http-util.js";
import { clientAddress, RateLimiter } from "./rate-limit.js";

/**
 * The multi-user gateway: the public front door in front of many firstmates.
 *
 * It signs people in with GitHub, keeps their sessions, and forwards each
 * signed-in user's firstmate API calls only to that user's own firstmate. It
 * never runs firstmate scripts, never reads a firstmate home, and never stores
 * or logs what it forwards.
 *
 * Who may sign in is declared, not self-served: an admin, or the owner of a
 * declared tenant. Anyone else is refused at the door.
 */

/** The sign-in client the gateway needs; GithubOAuth implements it. */
export interface SignInProvider {
  authorizeUrl(state: string, verifier: string): string;
  identify(code: string, verifier: string): Promise<GithubIdentity>;
}

export interface GatewayDeps {
  config: AppConfig;
  store: GatewayStore;
  oauth: SignInProvider;
  now?: () => number;
  log?: (line: string) => void;
  proxyTimeoutMs?: number;
  /** Per-client and global limits on the sign-in routes. */
  signInLimits?: { perClient: RateLimiter; global: RateLimiter };
}

/** Who a request acts for. */
interface Principal {
  githubId: number;
  /** The signed-in user, or null for the legacy shared token. */
  userId: string | null;
  login: string | null;
  via: "session" | "legacy";
}

/** Why a sign-in ended without a session; the app shows a message for each. */
type SignInOutcome = "failed" | "expired" | "denied" | "not_invited" | "busy";

export const SESSION_SCHEMA = "walkie-talkie-session.v1";

const MAX_CODE_LENGTH = 512;
const MAX_STATE_LENGTH = 512;

export function defaultSignInLimits(now: () => number = Date.now): { perClient: RateLimiter; global: RateLimiter } {
  return {
    perClient: new RateLimiter({ capacity: 10, refillPerMinute: 10, now }),
    global: new RateLimiter({ capacity: 120, refillPerMinute: 120, now }),
  };
}

/** A coarse device name for the session list; never the full User-Agent. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "Browser";
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-length": "0",
  };
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function signInRedirect(res: ServerResponse, outcome: SignInOutcome, cookies: string[] = []): void {
  redirect(res, `/?signin=${outcome}`, cookies);
}

export function createGatewayHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const gateway = deps.config.gateway;
  if (gateway === null) throw new Error("createGatewayHandler needs a gateway configuration");
  const gw: GatewayConfig = gateway;
  const { store, oauth } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => {});
  const limits = deps.signInLimits ?? defaultSignInLimits(now);
  const tenants = new Map<number, StaticTenant>(gw.staticTenants.map((tenant) => [tenant.githubId, tenant]));
  const declared = new Set<number>([...gw.admins, ...tenants.keys()]);
  const legacyAdmin = gw.admins[0];

  const isAdmin = (githubId: number): boolean => gw.admins.includes(githubId);

  /** Same-origin check for a cookie-authenticated write (CSRF defense). */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (typeof origin === "string") return origin === gw.publicOrigin;
    return req.headers["sec-fetch-site"] === "same-origin";
  };

  const signInAllowed = (req: IncomingMessage): boolean => {
    const client = clientAddress(req, gw.trustedProxyHops);
    return limits.perClient.allow(client) && limits.global.allow("*");
  };

  const sessionPrincipal = (req: IncomingMessage): Principal | null => {
    const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (id === undefined || id === "") return null;
    const session = store.touchSession(id, now());
    if (session === null) return null;
    const user = store.userById(session.userId);
    if (user === null || user.state !== "active") return null;
    return { githubId: user.githubId, userId: user.id, login: user.login, via: "session" };
  };

  const legacyPrincipal = (req: IncomingMessage): Principal | null => {
    if (!gw.legacyBearer || legacyAdmin === undefined) return null;
    const presented = bearerToken(req.headers.authorization);
    if (presented === null || !constantTimeEqual(presented, deps.config.token)) return null;
    return { githubId: legacyAdmin, userId: null, login: null, via: "legacy" };
  };

  return (req, res): void => {
    void handle(req, res).catch((error: unknown) => {
      log(`unhandled gateway error: ${error instanceof Error ? error.name : "error"}`);
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const isRead = method === "GET" || method === "HEAD";

    if (pathname === "/healthz") {
      if (!isRead) return sendError(res, 405, "method not allowed");
      return sendJson(res, 200, JSON.stringify({ ok: true }));
    }

    if (pathname === "/auth/session") {
      if (!isRead) return sendError(res, 405, "method not allowed");
      return sessionInfo(req, res);
    }
    if (pathname === "/auth/github/start") {
      if (!isRead) return sendError(res, 405, "method not allowed");
      return startSignIn(req, res);
    }
    if (pathname === "/auth/github/callback") {
      if (!isRead) return sendError(res, 405, "method not allowed");
      return finishSignIn(req, res, url);
    }
    if (pathname === "/auth/logout") {
      if (method !== "POST") return sendError(res, 405, "method not allowed");
      return signOut(req, res);
    }
    if (pathname.startsWith("/auth/")) return sendError(res, 404, "not found");

    if (pathname.startsWith("/api/")) return api(req, res, url);

    if (!isRead) return sendError(res, 405, "method not allowed");
    await serveStatic(deps.config.publicDir, res, pathname);
  }

  /** Open probe the app uses to learn the mode and whether it is signed in. */
  function sessionInfo(req: IncomingMessage, res: ServerResponse): void {
    const principal = sessionPrincipal(req);
    const user =
      principal === null
        ? null
        : {
            login: principal.login,
            admin: isAdmin(principal.githubId),
            firstmate: tenants.has(principal.githubId) ? "ready" : "none",
          };
    sendJson(
      res,
      200,
      JSON.stringify({
        schema: SESSION_SCHEMA,
        mode: "gateway",
        signed_in: principal !== null,
        user,
        legacy_bearer: gw.legacyBearer,
      }),
    );
  }

  function startSignIn(req: IncomingMessage, res: ServerResponse): void {
    if (!signInAllowed(req)) return signInRedirect(res, "busy");
    const state = randomToken(32);
    const verifier = newCodeVerifier();
    const attempt = store.createLoginAttempt(state, verifier, now());
    if (attempt === null) return signInRedirect(res, "busy");
    redirect(res, oauth.authorizeUrl(state, verifier), [
      serializeCookie(LOGIN_COOKIE, attempt, LOGIN_ATTEMPT_MS / 1000),
    ]);
  }

  async function finishSignIn(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const cleared = [clearCookie(LOGIN_COOKIE)];
    if (!signInAllowed(req)) return signInRedirect(res, "busy", cleared);

    const attempt = parseCookies(req.headers.cookie).get(LOGIN_COOKIE) ?? "";
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const verifier =
      state.length <= MAX_STATE_LENGTH ? store.consumeLoginAttempt(attempt, state, now()) : null;

    if (url.searchParams.has("error")) return signInRedirect(res, verifier === null ? "expired" : "denied", cleared);
    if (verifier === null) return signInRedirect(res, "expired", cleared);
    if (code.length === 0 || code.length > MAX_CODE_LENGTH) return signInRedirect(res, "failed", cleared);

    let identity: GithubIdentity;
    try {
      identity = await oauth.identify(code, verifier);
    } catch (error) {
      log(`github sign-in failed: ${error instanceof OAuthError ? error.message : "unexpected error"}`);
      return signInRedirect(res, "failed", cleared);
    }

    const at = now();
    let user = store.userByGithubId(identity.id);
    if (user === null && declared.has(identity.id)) {
      user = store.createUser(identity.id, identity.login, at);
      store.audit({ at, actor: null, action: "user.created", subject: user.id, detail: { github_id: identity.id, reason: "declared" } });
    }
    if (user === null) {
      store.audit({ at, actor: null, action: "signin.refused", subject: null, detail: { github_id: identity.id, reason: "not_invited" } });
      log(`sign-in refused: github ${identity.id} is not invited`);
      return signInRedirect(res, "not_invited", cleared);
    }

    store.recordLogin(user.id, identity.login, at);
    const label = deviceLabel(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
    const sessionId = store.createSession(user.id, label, at);
    store.audit({ at, actor: user.id, action: "signin", subject: user.id, detail: { device: label } });
    log(`signed in: user ${user.id}`);
    redirect(res, "/", [...cleared, serializeCookie(SESSION_COOKIE, sessionId, SESSION_ABSOLUTE_MS / 1000)]);
  }

  function signOut(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req)) return sendError(res, 403, "cross-site request refused");
    const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (id !== undefined && id !== "") {
      const principal = sessionPrincipal(req);
      if (store.deleteSession(id) && principal !== null) {
        store.audit({ at: now(), actor: principal.userId, action: "signout", subject: principal.userId, detail: null });
      }
    }
    res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
    sendJson(res, 200, JSON.stringify({ ok: true }));
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const principal = sessionPrincipal(req) ?? legacyPrincipal(req);
    if (principal === null) return sendError(res, 401, "signed_out");

    const route = matchProxyRoute(url.pathname);
    if (route === null) return sendError(res, 404, "not found");
    const method = req.method ?? "GET";
    if (!route.methods.includes(method)) return sendError(res, 405, "method not allowed");
    // A cookie rides along on any request the browser makes, so a write must
    // prove it came from this app. The legacy bearer header cannot be forged
    // cross-site, so it needs no such check.
    if (principal.via === "session" && method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
      return sendError(res, 403, "cross-site request refused");
    }

    const tenant = tenants.get(principal.githubId);
    if (tenant === undefined) return sendError(res, 409, "firstmate_not_provisioned");

    if (principal.via === "legacy") res.setHeader("x-wt-legacy-auth", "deprecated");
    await proxyToTenant(
      req,
      res,
      { upstream: tenant.upstream, token: tenant.token },
      { pathname: url.pathname, search: url.search },
      route,
      {
        log,
        label: String(principal.githubId),
        ...(deps.proxyTimeoutMs !== undefined ? { timeoutMs: deps.proxyTimeoutMs } : {}),
      },
    );
  }
}
