import type { IncomingMessage, ServerResponse } from "node:http";

import { clearCookie, SESSION_COOKIE } from "./cookies.js";
import { GatewayStore, type UserRecord } from "./gateway-store.js";
import { readBody, sendError, sendJson } from "./http-util.js";

/**
 * The gateway's own account and admin API: a user's signed-in devices, and the
 * admin's invites, access requests and users.
 *
 * Every route here needs a real GitHub session; the retiring shared token never
 * reaches them. Admin routes also need a declared admin. Nothing here reads or
 * returns any firstmate's content, and nothing returns a secret: devices are
 * named by a handle derived from the session hash, never by the session id.
 */

export interface AccountContext {
  store: GatewayStore;
  now: () => number;
  isAdmin: (githubId: number) => boolean;
  /** Admins and static tenant owners: managed in configuration, not here. */
  isDeclared: (githubId: number) => boolean;
  hasFirstmate: (githubId: number) => boolean;
  log: (line: string) => void;
}

/** The signed-in caller of an account route. */
export interface SessionCaller {
  user: UserRecord;
  sessionId: string;
}

const MAX_JSON_BODY = 4 * 1024;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const USER_PATH = /^\/api\/admin\/users\/(u_[A-Za-z0-9_-]{1,32})(?:\/(suspend|resume))?$/;
const INVITE_PATH = /^\/api\/admin\/invites\/(inv_[A-Za-z0-9_-]{1,32})$/;
const REQUEST_PATH = /^\/api\/admin\/requests\/(\d{1,15})\/(approve|deny)$/;
const DEVICE_PATH = /^\/api\/me\/devices\/([0-9a-f]{16})$/;

/** Whether a path belongs to this module (and so never to the firstmate proxy). */
export function isAccountPath(pathname: string): boolean {
  return pathname === "/api/me" || pathname.startsWith("/api/me/") || pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    sendError(res, 400, "request body must be application/json");
    return null;
  }
  let raw: string;
  try {
    raw = await readBody(req, MAX_JSON_BODY);
  } catch {
    sendError(res, 413, "request body too large");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(res, 400, "request body is not valid JSON");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, 400, "request body must be a JSON object");
    return null;
  }
  return parsed as Record<string, unknown>;
}

function userView(ctx: AccountContext, user: UserRecord, sessions?: number): Record<string, unknown> {
  return {
    id: user.id,
    login: user.login,
    github_id: user.githubId,
    state: user.state,
    admin: ctx.isAdmin(user.githubId),
    declared: ctx.isDeclared(user.githubId),
    firstmate: ctx.hasFirstmate(user.githubId) ? "ready" : "none",
    created_at: new Date(user.createdAt).toISOString(),
    last_login_at: user.lastLoginAt === null ? null : new Date(user.lastLoginAt).toISOString(),
    ...(sessions !== undefined ? { sessions } : {}),
  };
}

/**
 * Answer an account or admin route. The caller has already resolved a session
 * and, for a write, checked that it came from the app's own origin.
 */
export async function handleAccountRoute(
  ctx: AccountContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  caller: SessionCaller,
): Promise<void> {
  const method = req.method ?? "GET";
  const { store } = ctx;
  const me = caller.user;

  // ---- the caller's own devices --------------------------------------------
  if (pathname === "/api/me/devices") {
    if (method === "GET" || method === "HEAD") {
      const devices = store.listDevices(me.id, caller.sessionId).map((device) => ({
        id: device.id,
        label: device.label,
        created_at: new Date(device.createdAt).toISOString(),
        last_seen_at: new Date(device.lastSeenAt).toISOString(),
        current: device.current,
      }));
      return sendJson(res, 200, JSON.stringify({ devices }));
    }
    if (method === "DELETE") {
      const removed = store.deleteOtherDevices(me.id, caller.sessionId);
      store.audit({ at: ctx.now(), actor: me.id, action: "devices.signed_out_others", subject: me.id, detail: { removed } });
      return sendJson(res, 200, JSON.stringify({ removed }));
    }
    return sendError(res, 405, "method not allowed");
  }
  const device = DEVICE_PATH.exec(pathname);
  if (device) {
    if (method !== "DELETE") return sendError(res, 405, "method not allowed");
    const handle = device[1] ?? "";
    const current = handle === GatewayStore.deviceHandle(caller.sessionId);
    const removed = store.deleteDevice(me.id, handle);
    if (!removed) return sendError(res, 404, "no such device");
    store.audit({ at: ctx.now(), actor: me.id, action: "device.signed_out", subject: me.id, detail: { current } });
    if (current) res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
    return sendJson(res, 200, JSON.stringify({ removed: true, current }));
  }

  if (!pathname.startsWith("/api/admin")) return sendError(res, 404, "not found");
  if (!ctx.isAdmin(me.githubId)) return sendError(res, 403, "admin only");

  // ---- users ---------------------------------------------------------------
  if (pathname === "/api/admin/users") {
    if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method not allowed");
    const users = store.listUsers().map((user) => userView(ctx, user, user.sessions));
    return sendJson(res, 200, JSON.stringify({ users }));
  }
  const userMatch = USER_PATH.exec(pathname);
  if (userMatch) {
    const [, userId = "", verb] = userMatch;
    const target = store.userById(userId);
    if (target === null) return sendError(res, 404, "no such user");
    const at = ctx.now();
    if (verb === undefined) {
      if (method !== "DELETE") return sendError(res, 405, "method not allowed");
    } else if (method !== "POST") {
      return sendError(res, 405, "method not allowed");
    }
    if (verb !== "resume") {
      if (target.id === me.id) return sendError(res, 409, "you cannot suspend or remove yourself");
      if (ctx.isDeclared(target.githubId)) {
        return sendError(res, 409, "this account is declared in the configuration; change it there");
      }
    }
    if (verb === undefined) {
      store.deleteUser(target.id);
      store.audit({ at, actor: me.id, action: "user.removed", subject: target.id, detail: { github_id: target.githubId } });
      ctx.log(`user ${target.id} removed by ${me.id}`);
      return sendJson(res, 200, JSON.stringify({ removed: true }));
    }
    const state = verb === "suspend" ? "suspended" : "active";
    store.setUserState(target.id, state);
    store.audit({ at, actor: me.id, action: verb === "suspend" ? "user.suspended" : "user.resumed", subject: target.id, detail: null });
    const updated = store.userById(target.id);
    return sendJson(res, 200, JSON.stringify({ user: updated === null ? null : userView(ctx, updated) }));
  }

  // ---- invites -------------------------------------------------------------
  if (pathname === "/api/admin/invites") {
    if (method === "GET" || method === "HEAD") {
      const invites = store.listInvites(ctx.now()).map((invite) => ({
        id: invite.id,
        login: invite.login,
        created_at: new Date(invite.createdAt).toISOString(),
        expires_at: new Date(invite.expiresAt).toISOString(),
      }));
      return sendJson(res, 200, JSON.stringify({ invites }));
    }
    if (method !== "POST") return sendError(res, 405, "method not allowed");
    const body = await readJsonObject(req, res);
    if (body === null) return;
    const login = typeof body.login === "string" ? body.login.trim().replace(/^@/, "") : "";
    if (!GITHUB_LOGIN.test(login)) return sendError(res, 400, "login must be a GitHub login");
    if (store.userByLogin(login) !== null) return sendError(res, 409, "that GitHub account is already a user");
    const at = ctx.now();
    const invite = store.createInvite(login, me.id, at);
    store.audit({ at, actor: me.id, action: "invite.created", subject: invite.id, detail: { login: invite.login } });
    return sendJson(
      res,
      201,
      JSON.stringify({
        invite: {
          id: invite.id,
          login: invite.login,
          created_at: new Date(invite.createdAt).toISOString(),
          expires_at: new Date(invite.expiresAt).toISOString(),
        },
      }),
    );
  }
  const inviteMatch = INVITE_PATH.exec(pathname);
  if (inviteMatch) {
    if (method !== "DELETE") return sendError(res, 405, "method not allowed");
    const id = inviteMatch[1] ?? "";
    const at = ctx.now();
    if (!store.revokeInvite(id, at)) return sendError(res, 404, "no such open invite");
    store.audit({ at, actor: me.id, action: "invite.revoked", subject: id, detail: null });
    return sendJson(res, 200, JSON.stringify({ revoked: true }));
  }

  // ---- access requests -----------------------------------------------------
  if (pathname === "/api/admin/requests") {
    if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method not allowed");
    const requests = store.listAccessRequests(ctx.now()).map((request) => ({
      github_id: request.githubId,
      login: request.login,
      requested_at: new Date(request.requestedAt).toISOString(),
    }));
    return sendJson(res, 200, JSON.stringify({ requests }));
  }
  const requestMatch = REQUEST_PATH.exec(pathname);
  if (requestMatch) {
    if (method !== "POST") return sendError(res, 405, "method not allowed");
    const githubId = Number(requestMatch[1]);
    const at = ctx.now();
    if (requestMatch[2] === "approve") {
      const user = store.approveAccessRequest(githubId, at);
      if (user === null) return sendError(res, 404, "no such pending request");
      store.audit({ at, actor: me.id, action: "access.approved", subject: user.id, detail: { github_id: githubId } });
      return sendJson(res, 200, JSON.stringify({ user: userView(ctx, user) }));
    }
    if (!store.denyAccessRequest(githubId, me.id, at)) return sendError(res, 404, "no such pending request");
    store.audit({ at, actor: me.id, action: "access.denied", subject: null, detail: { github_id: githubId } });
    return sendJson(res, 200, JSON.stringify({ denied: true }));
  }

  // ---- audit ---------------------------------------------------------------
  if (pathname === "/api/admin/audit") {
    if (method !== "GET" && method !== "HEAD") return sendError(res, 405, "method not allowed");
    const entries = store.recentAudit(100).map((entry) => ({
      at: new Date(entry.at).toISOString(),
      actor: entry.actor,
      action: entry.action,
      subject: entry.subject,
      detail: entry.detail,
    }));
    return sendJson(res, 200, JSON.stringify({ entries }));
  }

  sendError(res, 404, "not found");
}
