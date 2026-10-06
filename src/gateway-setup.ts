import type { IncomingMessage, ServerResponse } from "node:http";

import { credentialSlots, providerById, type Catalog, type CredentialSlot } from "./catalog.js";
import type { SessionCaller } from "./gateway-admin.js";
import type { CredentialRecord, GatewayStore, ModelChoice, UserRecord } from "./gateway-store.js";
import { readBody, sendError, sendJson } from "./http-util.js";
import { confirmedModels, type KeyChecker } from "./key-check.js";
import type { RateLimiter } from "./rate-limit.js";
import { wipe, type Vault } from "./vault.js";

/**
 * A user's setup of their own firstmate: the catalog on offer, their keys, and
 * their choice of provider and model.
 *
 * Keys are write-only. A key is checked against its provider (only at the
 * catalog's validation URL), sealed by the vault, and stored; no route ever
 * returns it, any part of it, or a hash of it. Nothing here logs a key, a
 * request body or a provider's response. The choice and keys are what the
 * user's managed firstmate is provisioned from; once setup is ready the user
 * starts and stops it here, and replacing or deleting a key it was delivered
 * restarts it onto the change.
 */

export interface SetupContext {
  store: GatewayStore;
  catalog: Catalog;
  vault: Vault;
  checker: KeyChecker;
  now: () => number;
  /** An owner of a declared (static) tenant: their firstmate is managed in configuration. */
  hasStaticTenant: (githubId: number) => boolean;
  /** The user's managed firstmate lifecycle: none until they start it. */
  firstmateState: (user: UserRecord) => string;
  /** Managed firstmates; null when tenant provisioning is not configured. */
  provisioning: {
    /** Whether the user may start theirs under the tenant cap. */
    canStart: (userId: string) => boolean;
    /** A desired state or a delivered credential changed: reconcile soon. */
    kick: () => void;
  } | null;
  /** Bounds key checks, which each make an outbound call: per user, and overall. */
  checkLimits: { perUser: RateLimiter; global: RateLimiter };
  log: (line: string) => void;
}

/** A key: 8 to 512 printable ASCII characters, no whitespace. */
const KEY_VALUE = /^[\x21-\x7e]{8,512}$/;
const CREDENTIAL_PATH = /^\/api\/me\/credentials\/([A-Z_][A-Z0-9_]{0,127})$/;
const START_PATH = "/api/me/firstmate/start";
const STOP_PATH = "/api/me/firstmate/stop";
const MAX_KEY_BODY = 2 * 1024;
const MAX_CHOICE_BODY = 1024;

/** Whether a path belongs to setup (and so never to the firstmate proxy). */
export function isSetupPath(pathname: string): boolean {
  return (
    pathname === "/api/catalog" ||
    pathname === "/api/me/firstmate" ||
    pathname === START_PATH ||
    pathname === STOP_PATH ||
    pathname === "/api/me/credentials" ||
    pathname.startsWith("/api/me/credentials/")
  );
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function catalogView(catalog: Catalog): Record<string, unknown> {
  return {
    harnesses: catalog.harnesses,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      key_name: provider.keyEnv,
      models: provider.models,
    })),
    github: catalog.github === null ? null : { key_name: catalog.github.keyEnv[0] },
  };
}

function credentialView(slots: Map<string, CredentialSlot>, record: CredentialRecord): Record<string, unknown> {
  return {
    name: record.name,
    provider: record.provider,
    added_at: iso(record.addedAt),
    validated_at: iso(record.validatedAt),
    // A key whose slot left the catalog stays stored but is no longer offered.
    status: slots.has(record.name) ? "valid" : "unavailable",
  };
}

function choiceView(choice: ModelChoice | null): Record<string, unknown> | null {
  if (choice === null) return null;
  return {
    harness: choice.harness,
    provider: choice.provider,
    model: choice.model,
    routine_model: choice.routineModel,
    updated_at: iso(choice.updatedAt),
  };
}

async function readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown> | null> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    sendError(res, 400, "request body must be application/json");
    return null;
  }
  let raw: string;
  try {
    raw = await readBody(req, limit);
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

/** Whether a key can use every wanted model: true when its provider listed none for it. */
function keyCanUse(keyModels: string[] | null, wanted: Array<string | null>): boolean {
  return keyModels === null || wanted.every((model) => model === null || keyModels.includes(model));
}

/** What the user's setup still misses; `ready` once their firstmate can be started. */
function setupStatus(ctx: SetupContext, user: UserRecord): { choice: ModelChoice | null; setup: Record<string, boolean> } {
  const choice = ctx.store.modelChoice(user.id);
  const provider = choice === null ? null : providerById(ctx.catalog, choice.provider);
  const key = provider === null ? null : ctx.store.credential(user.id, provider.keyEnv);
  const offered = (model: string | null): boolean => provider !== null && model !== null && provider.models.includes(model);
  const usable = (model: string | null): boolean => offered(model) && key !== null && keyCanUse(key.models, [model]);
  const routineModel = choice?.routineModel ?? null;
  const modelChosen = offered(choice?.model ?? null);
  const routineChosen = choice !== null && (routineModel === null || offered(routineModel));
  const modelAvailable = usable(choice?.model ?? null);
  const routineAvailable = choice !== null && (routineModel === null ? key !== null : usable(routineModel));
  return {
    choice,
    setup: {
      model_chosen: modelChosen,
      routine_chosen: routineChosen,
      key_saved: key !== null,
      model_available: modelAvailable,
      routine_available: routineAvailable,
      ready: modelAvailable && routineAvailable,
    },
  };
}

/** The user's setup as the app shows it: their choice, and what is still missing. */
function firstmateView(ctx: SetupContext, caller: SessionCaller): Record<string, unknown> {
  const { user } = caller;
  if (ctx.hasStaticTenant(user.githubId)) {
    return { managed: false, choice: null, setup: null };
  }
  const { choice, setup } = setupStatus(ctx, user);
  return {
    managed: true,
    choice: choiceView(choice),
    setup,
    // The managed firstmate's lifecycle: none until it is started.
    state: ctx.firstmateState(user),
    // Whether this gateway runs per-user firstmates, so Start is offered.
    provisioning: ctx.provisioning !== null,
  };
}

/**
 * Answer a setup route. The caller has already resolved a session and, for a
 * write, checked that it came from the app's own origin.
 */
export async function handleSetupRoute(
  ctx: SetupContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  caller: SessionCaller,
): Promise<void> {
  const method = req.method ?? "GET";
  const isRead = method === "GET" || method === "HEAD";
  const me = caller.user;
  const slots = credentialSlots(ctx.catalog);

  if (pathname === "/api/catalog") {
    if (!isRead) return sendError(res, 405, "method not allowed");
    return sendJson(res, 200, JSON.stringify({ catalog: catalogView(ctx.catalog) }));
  }

  if (pathname === "/api/me/firstmate") {
    if (isRead) return sendJson(res, 200, JSON.stringify(firstmateView(ctx, caller)));
    if (method !== "PUT") return sendError(res, 405, "method not allowed");
    if (ctx.hasStaticTenant(me.githubId)) return sendError(res, 409, "managed_by_config");
    const body = await readJson(req, res, MAX_CHOICE_BODY);
    if (body === null) return;
    return chooseModel(ctx, res, caller, body);
  }

  if (pathname === START_PATH || pathname === STOP_PATH) {
    if (method !== "POST") return sendError(res, 405, "method not allowed");
    if (ctx.hasStaticTenant(me.githubId)) return sendError(res, 409, "managed_by_config");
    if (ctx.provisioning === null) return sendError(res, 409, "not_available");
    return pathname === START_PATH
      ? startFirstmate(ctx, ctx.provisioning, res, caller)
      : stopFirstmate(ctx, ctx.provisioning, res, caller);
  }

  if (pathname === "/api/me/credentials") {
    if (!isRead) return sendError(res, 405, "method not allowed");
    const credentials = ctx.store.listCredentials(me.id).map((record) => credentialView(slots, record));
    return sendJson(res, 200, JSON.stringify({ credentials }));
  }

  const match = CREDENTIAL_PATH.exec(pathname);
  if (match === null) return sendError(res, 404, "not found");
  const name = match[1] ?? "";

  if (method === "DELETE") {
    if (!ctx.store.deleteCredential(me.id, name)) return sendError(res, 404, "no_credential");
    ctx.store.audit({ at: ctx.now(), actor: me.id, action: "credential.deleted", subject: me.id, detail: { name } });
    ctx.log(`credential deleted: user ${me.id} ${name}`);
    deliveredCredentialChanged(ctx, me, name, true);
    return sendJson(res, 200, JSON.stringify({ deleted: true }));
  }
  if (method !== "PUT") return sendError(res, 405, "method not allowed");

  const slot = slots.get(name);
  if (slot === undefined) return sendError(res, 404, "unknown_credential");
  if (ctx.hasStaticTenant(me.githubId)) return sendError(res, 409, "managed_by_config");
  const body = await readJson(req, res, MAX_KEY_BODY);
  if (body === null) return;
  return saveKey(ctx, res, caller, slot, body);
}

async function saveKey(
  ctx: SetupContext,
  res: ServerResponse,
  caller: SessionCaller,
  slot: CredentialSlot,
  body: Record<string, unknown>,
): Promise<void> {
  const me = caller.user;
  const value = body.value;
  // The value is never echoed: a malformed one gets the same fixed message.
  if (typeof value !== "string" || !KEY_VALUE.test(value)) return sendError(res, 400, "invalid_key_format");
  if (!ctx.checkLimits.perUser.allow(me.id) || !ctx.checkLimits.global.allow("*")) {
    return sendError(res, 429, "busy");
  }

  const spec = slot.kind === "provider" ? slot.provider.validate : slot.github.validate;
  const providerId = slot.kind === "provider" ? slot.provider.id : "github";
  const checked = await ctx.checker.check(spec, value);
  const at = ctx.now();
  if (checked.status !== "valid") {
    ctx.store.audit({
      at,
      actor: me.id,
      action: "credential.refused",
      subject: me.id,
      detail: { name: slot.name, provider: providerId, outcome: checked.status },
    });
    ctx.log(`credential refused: user ${me.id} ${slot.name} (${checked.status})`);
    return checked.status === "invalid"
      ? sendError(res, 422, "key_rejected")
      : sendError(res, 502, "provider_unreachable");
  }

  const models = slot.kind === "provider" ? confirmedModels(slot.provider.models, checked.listed) : null;
  const plaintext = Buffer.from(value, "utf8");
  let record: CredentialRecord;
  try {
    record = ctx.store.putCredential(me.id, slot.name, providerId, ctx.vault.seal(me.id, slot.name, plaintext), models, at);
  } finally {
    wipe(plaintext);
  }
  ctx.store.audit({
    at,
    actor: me.id,
    action: "credential.saved",
    subject: me.id,
    detail: { name: slot.name, provider: providerId, kid: ctx.vault.activeKid },
  });
  ctx.log(`credential saved: user ${me.id} ${slot.name} (kid ${ctx.vault.activeKid})`);
  deliveredCredentialChanged(ctx, me, slot.name, false);
  sendJson(
    res,
    200,
    JSON.stringify({ credential: credentialView(credentialSlots(ctx.catalog), record), models }),
  );
}

function chooseModel(ctx: SetupContext, res: ServerResponse, caller: SessionCaller, body: Record<string, unknown>): void {
  const me = caller.user;
  const providerId = typeof body.provider === "string" ? body.provider : "";
  const provider = providerById(ctx.catalog, providerId);
  if (provider === null) return sendError(res, 400, "unknown_provider");
  const model = typeof body.model === "string" ? body.model : "";
  if (!provider.models.includes(model)) return sendError(res, 400, "unknown_model");
  const routineRaw = body.routine_model;
  let routineModel: string | null = null;
  if (routineRaw !== undefined && routineRaw !== null && routineRaw !== "") {
    if (typeof routineRaw !== "string" || !provider.models.includes(routineRaw)) {
      return sendError(res, 400, "unknown_model");
    }
    routineModel = routineRaw;
  }
  const harnessRaw = body.harness;
  const harness = harnessRaw === undefined || harnessRaw === null || harnessRaw === "" ? ctx.catalog.harnesses[0] : harnessRaw;
  if (typeof harness !== "string" || !ctx.catalog.harnesses.includes(harness)) {
    return sendError(res, 400, "unknown_harness");
  }

  // A model choice needs the provider's key first, and the provider must have
  // listed the models for that key when it was checked (where it lists any).
  const key = ctx.store.credential(me.id, provider.keyEnv);
  if (key === null) return sendError(res, 409, "key_required");
  if (!keyCanUse(key.models, [model, routineModel])) return sendError(res, 422, "model_unavailable");

  const at = ctx.now();
  ctx.store.setModelChoice(me.id, { harness, provider: provider.id, model, routineModel }, at);
  ctx.store.audit({
    at,
    actor: me.id,
    action: "firstmate.choice",
    subject: me.id,
    detail: { harness, provider: provider.id, model, ...(routineModel === null ? {} : { routine_model: routineModel }) },
  });
  ctx.provisioning?.kick();
  sendJson(res, 200, JSON.stringify(firstmateView(ctx, caller)));
}

type Provisioning = NonNullable<SetupContext["provisioning"]>;

/** Start the user's managed firstmate: setup must be ready and the tenant cap leave room. */
function startFirstmate(ctx: SetupContext, provisioning: Provisioning, res: ServerResponse, caller: SessionCaller): void {
  const me = caller.user;
  const { choice, setup } = setupStatus(ctx, me);
  if (choice !== null && !setup.key_saved) return sendError(res, 409, "key_required");
  if (!setup.ready) return sendError(res, 409, "setup_incomplete");
  if (!provisioning.canStart(me.id)) return sendError(res, 409, "capacity_reached");
  const at = ctx.now();
  const tenant = ctx.store.ensureTenant(me.id, at);
  ctx.store.setTenantDesired(me.id, "running", at);
  ctx.store.audit({ at, actor: me.id, action: "firstmate.started", subject: me.id, detail: { tid: tenant.tid } });
  ctx.log(`firstmate started: user ${me.id} tenant=${tenant.tid}`);
  provisioning.kick();
  sendJson(res, 200, JSON.stringify(firstmateView(ctx, caller)));
}

/** Stop the user's managed firstmate: scaled to zero, its home and objects kept. */
function stopFirstmate(ctx: SetupContext, provisioning: Provisioning, res: ServerResponse, caller: SessionCaller): void {
  const me = caller.user;
  const tenant = ctx.store.tenantByUser(me.id);
  if (tenant === null || tenant.desired === "none") return sendError(res, 409, "firstmate_not_started");
  const at = ctx.now();
  ctx.store.setTenantDesired(me.id, "stopped", at);
  ctx.store.audit({ at, actor: me.id, action: "firstmate.stopped", subject: me.id, detail: { tid: tenant.tid } });
  ctx.log(`firstmate stopped: user ${me.id} tenant=${tenant.tid}`);
  provisioning.kick();
  sendJson(res, 200, JSON.stringify(firstmateView(ctx, caller)));
}

/**
 * A credential the user's firstmate was delivered changed. Replacing it, or
 * deleting the GitHub token, restarts the pod so it fetches again and never
 * keeps the old value; deleting the chosen provider's key stops a running
 * firstmate, which cannot run without it.
 */
function deliveredCredentialChanged(ctx: SetupContext, user: UserRecord, name: string, deleted: boolean): void {
  if (ctx.provisioning === null) return;
  const choice = ctx.store.modelChoice(user.id);
  const provider = choice === null ? null : providerById(ctx.catalog, choice.provider);
  if (deleted && name === provider?.keyEnv) {
    const tenant = ctx.store.tenantByUser(user.id);
    if (tenant === null || tenant.desired !== "running") return;
    const at = ctx.now();
    ctx.store.setTenantDesired(user.id, "stopped", at);
    ctx.store.audit({ at, actor: user.id, action: "firstmate.stopped", subject: user.id, detail: { tid: tenant.tid } });
    ctx.log(`firstmate stopped: user ${user.id} tenant=${tenant.tid} (key deleted)`);
    ctx.provisioning.kick();
    return;
  }
  if (name !== provider?.keyEnv && name !== ctx.catalog.github?.keyEnv[0]) return;
  ctx.store.bumpTenantConfig(user.id, ctx.now());
  ctx.provisioning.kick();
}
