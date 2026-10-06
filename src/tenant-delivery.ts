import type { IncomingMessage, ServerResponse } from "node:http";

import { bearerToken } from "./auth.js";
import { providerById, type Catalog } from "./catalog.js";
import type { GatewayStore } from "./gateway-store.js";
import { sendError, sendJson } from "./http-util.js";
import { RateLimiter } from "./rate-limit.js";
import { CREDENTIALS_PATH } from "./tenant-objects.js";
import type { TenantTokens } from "./tenant-tokens.js";
import { wipe, type Vault } from "./vault.js";

/**
 * Credential delivery: the gateway's internal port, where a managed tenant's
 * runtime fetches its own keys once at start (pull, so no provider key is ever
 * written to a Kubernetes Secret).
 *
 * The only route is `GET /internal/v1/credentials`. The caller presents its
 * credential token, `<tid>.<HMAC>`; the tenant id inside it is the only thing
 * that selects whose keys are opened, so one tenant can never ask for
 * another's. The tenant's owner must be active and the tenant desired running.
 * The answer is `{"env": {NAME: value}}`: the key of the chosen provider under
 * its catalog name, and the user's GitHub token, if saved, under every GitHub
 * name. It is `no-store`, and nothing is logged but the tenant id and a count.
 *
 * This port is never on the HTTPRoute: its Service is cluster-internal and a
 * NetworkPolicy admits only the tenant namespace.
 */

export interface DeliveryContext {
  store: GatewayStore;
  vault: Vault;
  catalog: Catalog;
  tokens: TenantTokens;
  now: () => number;
  log: (line: string) => void;
  /** Per-tenant bound on fetches; a runtime fetches once per start. */
  limiter?: RateLimiter;
}

export function defaultDeliveryLimiter(now: () => number = Date.now): RateLimiter {
  return new RateLimiter({ capacity: 10, refillPerMinute: 10, now });
}

export function createDeliveryHandler(ctx: DeliveryContext): (req: IncomingMessage, res: ServerResponse) => void {
  const limiter = ctx.limiter ?? defaultDeliveryLimiter(ctx.now);
  return (req, res) => {
    try {
      deliver(ctx, limiter, req, res);
    } catch (error) {
      ctx.log(`credential delivery failed: ${error instanceof Error ? error.name : "error"}`);
      if (!res.headersSent) sendError(res, 500, "unavailable");
      else res.end();
    }
  };
}

function deliver(ctx: DeliveryContext, limiter: RateLimiter, req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://internal.invalid").pathname;
  if (pathname !== CREDENTIALS_PATH) return sendError(res, 404, "not found");
  if (req.method !== "GET") return sendError(res, 405, "method not allowed");

  const presented = bearerToken(req.headers.authorization);
  const tid = presented === null ? null : ctx.tokens.verifyCredentialToken(presented);
  if (tid === null) {
    ctx.log("credential delivery refused: unknown token");
    return sendError(res, 401, "unauthorized");
  }
  if (!limiter.allow(tid)) return sendError(res, 429, "busy");

  const owner = ctx.store.tenantByTid(tid);
  if (owner === null || owner.desired !== "running") {
    ctx.log(`tenant=${tid} delivery refused: not running`);
    return sendError(res, 403, "not_running");
  }
  if (owner.userState !== "active") {
    ctx.log(`tenant=${tid} delivery refused: suspended`);
    return sendError(res, 403, "suspended");
  }
  const choice = ctx.store.modelChoice(owner.userId);
  const provider = choice === null ? null : providerById(ctx.catalog, choice.provider);
  if (provider === null) {
    ctx.log(`tenant=${tid} delivery refused: no provider chosen`);
    return sendError(res, 409, "no_choice");
  }

  // The provider key is required: a runtime without it would start keyless.
  const names: Array<[string, string[]]> = [[provider.keyEnv, [provider.keyEnv]]];
  const github = ctx.catalog.github;
  const githubName = github?.keyEnv[0];
  if (github !== null && githubName !== undefined) names.push([githubName, github.keyEnv]);

  const env: Record<string, string> = {};
  let count = 0;
  for (const [slot, envNames] of names) {
    const sealed = ctx.store.sealedCredential(owner.userId, slot);
    if (sealed === null) {
      if (slot === provider.keyEnv) {
        ctx.log(`tenant=${tid} delivery refused: no ${slot} saved`);
        return sendError(res, 409, "key_missing");
      }
      continue;
    }
    let plaintext: Buffer | null = null;
    try {
      plaintext = ctx.vault.open(owner.userId, slot, sealed);
      const value = plaintext.toString("utf8");
      for (const name of envNames) env[name] = value;
      count += 1;
    } catch (error) {
      ctx.log(`tenant=${tid} delivery failed: ${slot} did not open (${error instanceof Error ? error.message : "error"})`);
      return sendError(res, 500, "unavailable");
    } finally {
      wipe(plaintext);
    }
  }

  ctx.store.audit({ at: ctx.now(), actor: null, action: "credentials.delivered", subject: owner.userId, detail: { tid, n: count } });
  ctx.log(`tenant=${tid} delivered n=${count}`);
  sendJson(res, 200, JSON.stringify({ env }));
}
