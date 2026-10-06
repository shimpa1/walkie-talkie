import type { IncomingMessage, ServerResponse } from "node:http";

import { bearerToken, constantTimeEqual } from "./auth.js";
import { validationOrigins } from "./catalog.js";
import type { AppConfig } from "./config.js";
import { clearCookie, LOGIN_COOKIE, parseCookies, serializeCookie, SESSION_COOKIE } from "./cookies.js";
import { handleAccountRoute, isAccountPath, type AccountContext, type SessionCaller } from "./gateway-admin.js";
import type { GatewayConfig, StaticTenant } from "./gateway-config.js";
import { matchProxyRoute, proxyToTenant } from "./gateway-proxy.js";
import { handleSetupRoute, isSetupPath, type SetupContext } from "./gateway-setup.js";
import {
  LOGIN_ATTEMPT_MS,
  randomToken,
  SESSION_ABSOLUTE_MS,
  type GatewayStore,
  type UserRecord,
} from "./gateway-store.js";
import { newCodeVerifier, OAuthError, type GithubIdentity } from "./github-oauth.js";
import { readBody, sendError, sendJson, serveStatic } from "./http-util.js";
import { KeyChecker } from "./key-check.js";
import { clientAddress, RateLimiter } from "./rate-limit.js";
import { tenantState, type FirstmateState } from "./reconciler.js";
import { tenantUpstream } from "./tenant-objects.js";

/**
 * The multi-user gateway: the public front door in front of many firstmates.
 *
 * It signs people in with GitHub, keeps their sessions, and forwards each
 * signed-in user's firstmate API calls only to that user's own firstmate. It
 * never runs firstmate scripts, never reads a firstmate home, and never stores
 * or logs what it forwards.
 *
 * Nobody signs themselves up. An account gets in when the operator declared it
 * (an admin, or the owner of a declared tenant), when an admin invited its
 * login, or when an admin approved the access request its first sign-in
 * recorded.
 *
 * A user's firstmate is either declared (a static tenant the operator runs) or
 * managed: provisioned by the gateway's reconciler from the user's own choice,
 * when tenant provisioning is configured. Either way the upstream comes only
 * from the session's user.
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
  /** Per-client and global limits on redeeming a device link code. */
  linkLimits?: { perClient: RateLimiter; global: RateLimiter };
  /** Per-user and global limits on checking a key with its provider. */
  keyCheckLimits?: { perUser: RateLimiter; global: RateLimiter };
  /** Overrides the key checker; tests bound its timeout. */
  keyChecker?: KeyChecker;
  /** Overrides where a managed tenant is reached (its in-cluster Service); tests point it at a local fake. */
  tenantUpstream?: (tid: string) => string;
  /** The tenant reconciler, kicked on every desired-state change; absent outside a cluster. */
  reconciler?: { kick: () => void } | null;
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
type SignInOutcome = "failed" | "expired" | "denied" | "not_invited" | "pending" | "suspended" | "busy";

export const SESSION_SCHEMA = "walkie-talkie-session.v1";

/** A firstmate the user has (declared, or managed and desired running). */
const STARTED_STATES = new Set<string>(["ready", "provisioning", "starting", "running", "crashloop"]);

const MAX_CODE_LENGTH = 512;
const MAX_STATE_LENGTH = 512;

export function defaultSignInLimits(now: () => number = Date.now): { perClient: RateLimiter; global: RateLimiter } {
  return {
    perClient: new RateLimiter({ capacity: 10, refillPerMinute: 10, now }),
    global: new RateLimiter({ capacity: 120, refillPerMinute: 120, now }),
  };
}

/**
 * Link codes carry about 40 bits and live five minutes; these limits make
 * guessing one hopeless.
 */
export function defaultLinkLimits(now: () => number = Date.now): { perClient: RateLimiter; global: RateLimiter } {
  return {
    perClient: new RateLimiter({ capacity: 5, refillPerMinute: 5, now }),
    global: new RateLimiter({ capacity: 30, refillPerMinute: 30, now }),
  };
}

/** Each key check is an outbound call to a provider, so it is bounded per user and overall. */
export function defaultKeyCheckLimits(now: () => number = Date.now): { perUser: RateLimiter; global: RateLimiter } {
  return {
    perUser: new RateLimiter({ capacity: 10, refillPerMinute: 10, now }),
    global: new RateLimiter({ capacity: 60, refillPerMinute: 60, now }),
  };
}

const MAX_LINK_BODY = 1024;

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
  const linkLimits = deps.linkLimits ?? defaultLinkLimits(now);
  const tenants = new Map<number, StaticTenant>(gw.staticTenants.map((tenant) => [tenant.githubId, tenant]));
  const declared = new Set<number>([...gw.admins, ...tenants.keys()]);
  const legacyAdmin = gw.admins[0];

  const managed = gw.tenants;
  const isAdmin = (githubId: number): boolean => gw.admins.includes(githubId);

  /** A managed user's firstmate lifecycle; a declared one is always ready. */
  const firstmateState = (user: UserRecord): FirstmateState | "ready" => {
    if (tenants.has(user.githubId)) return "ready";
    if (managed === null) return "none";
    return tenantState(store.tenantByUser(user.id));
  };

  const kick = (): void => deps.reconciler?.kick();

  /**
   * Admission: with provisioning on, every user without a declared firstmate
   * may get a managed one, so approving or inviting past `maxTenants` is
   * refused. Open invites count, since each becomes a user on sign-in, and so
   * do removed users' tenants whose home volume is still in the cluster.
   */
  const admissionOpen = (): boolean => {
    if (managed === null) return true;
    const users = store.listUsers().filter((user) => !tenants.has(user.githubId)).length;
    const held = users + store.listInvites(now()).length + store.listRetainedTenants().length;
    return held < managed.params.maxTenants;
  };

  /**
   * Starting: a tenant that already holds its resources may always start
   * again; a new one needs room beside every other tenant and every retained
   * home volume.
   */
  const canStart = (userId: string): boolean => {
    if (managed === null) return false;
    const own = store.tenantByUser(userId);
    if (own !== null && own.desired !== "none") return true;
    return store.countActiveTenants() + store.listRetainedTenants().length < managed.params.maxTenants;
  };

  const account: AccountContext = {
    store,
    now,
    isAdmin,
    isDeclared: (githubId) => declared.has(githubId),
    firstmateState,
    admissionOpen,
    kick,
    log,
  };
  // Setup (catalog, keys, model choice) is on when a catalog is configured;
  // configuration refuses a catalog without a vault.
  const setup: SetupContext | null =
    gw.catalog === null || gw.vault === null
      ? null
      : {
          store,
          catalog: gw.catalog,
          vault: gw.vault,
          checker: deps.keyChecker ?? new KeyChecker({ allowedOrigins: validationOrigins(gw.catalog) }),
          now,
          hasStaticTenant: (githubId) => tenants.has(githubId),
          firstmateState: (user) => {
            const state = firstmateState(user);
            return state === "ready" ? "running" : state;
          },
          provisioning: managed === null ? null : { canStart, kick },
          checkLimits: deps.keyCheckLimits ?? defaultKeyCheckLimits(now),
          log,
        };

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

  const sessionCaller = (req: IncomingMessage): SessionCaller | null => {
    const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (id === undefined || id === "") return null;
    const session = store.touchSession(id, now());
    if (session === null) return null;
    const user = store.userById(session.userId);
    if (user === null || user.state !== "active") return null;
    return { user, sessionId: id };
  };

  const sessionPrincipal = (req: IncomingMessage): Principal | null => {
    const caller = sessionCaller(req);
    if (caller === null) return null;
    const { user } = caller;
    return { githubId: user.githubId, userId: user.id, login: user.login, via: "session" };
  };

  /** Issue a session cookie for `user` on this device. */
  const issueSession = (req: IncomingMessage, user: UserRecord, at: number, how: string): string => {
    const label = deviceLabel(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
    const sessionId = store.createSession(user.id, label, at);
    store.audit({ at, actor: user.id, action: how, subject: user.id, detail: { device: label } });
    log(`${how}: user ${user.id}`);
    return serializeCookie(SESSION_COOKIE, sessionId, SESSION_ABSOLUTE_MS / 1000);
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
    if (pathname === "/auth/link/code") {
      if (method !== "POST") return sendError(res, 405, "method not allowed");
      return mintLinkCode(req, res);
    }
    if (pathname === "/auth/link/redeem") {
      if (method !== "POST") return sendError(res, 405, "method not allowed");
      return redeemLinkCode(req, res);
    }
    if (pathname.startsWith("/auth/")) return sendError(res, 404, "not found");

    if (pathname.startsWith("/api/")) return api(req, res, url);

    if (!isRead) return sendError(res, 405, "method not allowed");
    await serveStatic(deps.config.publicDir, res, pathname);
  }

  /** Open probe the app uses to learn the mode and whether it is signed in. */
  function sessionInfo(req: IncomingMessage, res: ServerResponse): void {
    const caller = sessionCaller(req);
    let user: Record<string, unknown> | null = null;
    if (caller !== null) {
      const state = firstmateState(caller.user);
      user = {
        login: caller.user.login,
        admin: isAdmin(caller.user.githubId),
        // "ready": the app opens on Status (a declared firstmate, or a managed
        // one the user started); "none": it opens on Setup.
        firstmate: STARTED_STATES.has(state) ? "ready" : "none",
        firstmate_state: state === "ready" ? "running" : state,
        // Whether this user sets up their own firstmate (provider, key, model).
        setup: setup !== null && !tenants.has(caller.user.githubId),
      };
    }
    sendJson(
      res,
      200,
      JSON.stringify({
        schema: SESSION_SCHEMA,
        mode: "gateway",
        signed_in: caller !== null,
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
    const user = admit(identity, at);
    if (typeof user === "string") return signInRedirect(res, user, cleared);

    store.recordLogin(user.id, identity.login, at);
    redirect(res, "/", [...cleared, issueSession(req, user, at, "signin")]);
  }

  /**
   * Decide whether a GitHub account gets in, in order: an existing user (unless
   * suspended); a declared account; an open invite for its login; otherwise
   * its first sign-in becomes an access request (when enabled) and it waits.
   */
  function admit(identity: GithubIdentity, at: number): UserRecord | SignInOutcome {
    const existing = store.userByGithubId(identity.id);
    if (existing !== null) {
      if (existing.state === "active") return existing;
      store.audit({ at, actor: existing.id, action: "signin.refused", subject: existing.id, detail: { reason: existing.state } });
      return "suspended";
    }
    if (declared.has(identity.id)) {
      const user = store.createUser(identity.id, identity.login, at);
      store.audit({ at, actor: null, action: "user.created", subject: user.id, detail: { github_id: identity.id, reason: "declared" } });
      return user;
    }
    const invited = store.redeemInvite(identity.id, identity.login, at);
    if (invited !== null) {
      store.audit({
        at,
        actor: invited.invite.createdBy,
        action: "invite.redeemed",
        subject: invited.user.id,
        detail: { github_id: identity.id, invite: invited.invite.id },
      });
      return invited.user;
    }
    if (gw.accessRequests) {
      const outcome = store.recordAccessRequest(identity.id, identity.login, at);
      if (outcome === "pending") {
        store.audit({ at, actor: null, action: "access.requested", subject: null, detail: { github_id: identity.id } });
        log(`access requested: github ${identity.id}`);
        return "pending";
      }
      store.audit({ at, actor: null, action: "signin.refused", subject: null, detail: { github_id: identity.id, reason: outcome === "denied" ? "denied" : "requests_full" } });
      log(`sign-in refused: github ${identity.id} (${outcome === "denied" ? "request denied" : "request queue full"})`);
      return "not_invited";
    }
    store.audit({ at, actor: null, action: "signin.refused", subject: null, detail: { github_id: identity.id, reason: "not_invited" } });
    log(`sign-in refused: github ${identity.id} is not invited`);
    return "not_invited";
  }

  /** A signed-in user mints a one-time code to sign another device in as themselves. */
  function mintLinkCode(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req)) return sendError(res, 403, "cross-site request refused");
    const caller = sessionCaller(req);
    if (caller === null) return sendError(res, 401, "signed_out");
    const at = now();
    const { code, expiresAt } = store.createLinkCode(caller.user.id, at);
    store.audit({ at, actor: caller.user.id, action: "device.link_code", subject: caller.user.id, detail: null });
    sendJson(
      res,
      200,
      JSON.stringify({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: new Date(expiresAt).toISOString() }),
    );
  }

  /** Another device spends a link code for its own session. */
  async function redeemLinkCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same-origin only: a cross-site post could otherwise sign a victim's
    // browser into an attacker's account.
    if (!sameOrigin(req)) return sendError(res, 403, "cross-site request refused");
    const client = clientAddress(req, gw.trustedProxyHops);
    if (!linkLimits.perClient.allow(client) || !linkLimits.global.allow("*")) {
      return sendError(res, 429, "busy");
    }
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
      return sendError(res, 400, "request body must be application/json");
    }
    let code: unknown;
    try {
      code = (JSON.parse(await readBody(req, MAX_LINK_BODY)) as Record<string, unknown> | null)?.code;
    } catch {
      return sendError(res, 400, "invalid_code");
    }
    const at = now();
    const userId = typeof code === "string" ? store.redeemLinkCode(code, at) : null;
    const user = userId === null ? null : store.userById(userId);
    if (user === null) return sendError(res, 400, "invalid_code");
    res.setHeader("set-cookie", issueSession(req, user, at, "device.linked"));
    sendJson(res, 200, JSON.stringify({ ok: true }));
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

  /**
   * The caller's own firstmate, from the session alone: a declared upstream,
   * or the managed tenant's in-cluster Service with its derived token. A
   * managed firstmate that is not running yet answers with its state instead.
   */
  function upstreamFor(principal: Principal): { upstream: string; token: string } | FirstmateState {
    const declaredTenant = tenants.get(principal.githubId);
    if (declaredTenant !== undefined) return { upstream: declaredTenant.upstream, token: declaredTenant.token };
    if (managed === null || principal.userId === null) return "none";
    const tenant = store.tenantByUser(principal.userId);
    const state = tenantState(tenant);
    if (tenant === null || state !== "running") return state;
    const upstream = deps.tenantUpstream?.(tenant.tid) ?? tenantUpstream(managed.params, tenant.tid);
    return { upstream, token: managed.tokens.apiToken(tenant.tid) };
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (isSetupPath(url.pathname)) {
      // Like the account routes: a real GitHub session only, never the shared token.
      const caller = sessionCaller(req);
      if (caller === null) return sendError(res, 401, "signed_out");
      if (setup === null) return sendError(res, 404, "not found");
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
        return sendError(res, 403, "cross-site request refused");
      }
      return handleSetupRoute(setup, req, res, url.pathname, caller);
    }
    if (isAccountPath(url.pathname)) {
      // The gateway's own account and admin routes take a real GitHub session
      // only; the retiring shared token never reaches them.
      const caller = sessionCaller(req);
      if (caller === null) return sendError(res, 401, "signed_out");
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
        return sendError(res, 403, "cross-site request refused");
      }
      return handleAccountRoute(account, req, res, url.pathname, caller);
    }

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

    const target = upstreamFor(principal);
    if (typeof target === "string") {
      if (target === "none") return sendError(res, 409, "firstmate_not_provisioned");
      return sendJson(res, 409, JSON.stringify({ error: "firstmate_not_running", state: target }));
    }

    if (principal.via === "legacy") res.setHeader("x-wt-legacy-auth", "deprecated");
    await proxyToTenant(
      req,
      res,
      target,
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
