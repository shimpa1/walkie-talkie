import { CatalogError, loadCatalog, type Catalog } from "./catalog.js";
import { Vault, VaultError } from "./vault.js";

/**
 * Configuration for the multi-user gateway mode.
 *
 * In gateway mode the service is the public front door: it signs people in
 * with GitHub, keeps their sessions, and forwards each signed-in user's API
 * calls to that user's own firstmate. Non-secret settings may come from the
 * gitignored config file or the environment; the secrets (the GitHub OAuth
 * client secret, each static tenant's bearer token and the vault keyring) are
 * read from the environment only, so a secret never has to be written into a
 * file.
 */

export type ServiceMode = "standalone" | "gateway";

/**
 * A firstmate the gateway routes to but does not manage: an operator-declared
 * upstream owned by one GitHub account. The captain's existing pod is one.
 */
export interface StaticTenant {
  /** The owner's immutable GitHub numeric id. */
  githubId: number;
  /** Origin of that firstmate's walkie-talkie service, e.g. http://firstmate:8787. */
  upstream: string;
  /** Bearer token that upstream accepts (its FM_WT_TOKEN). */
  token: string;
}

export interface GatewayConfig {
  /** The public origin users load the app from; the OAuth callback and CSRF check use it. */
  publicOrigin: string;
  githubClientId: string;
  githubClientSecret: string;
  /** GitHub numeric ids that hold the admin role. Declared, never granted in the app. */
  admins: number[];
  staticTenants: StaticTenant[];
  /** SQLite file holding users, sessions and the audit log. */
  dbPath: string;
  /**
   * Accept the retiring shared bearer token (FM_WT_TOKEN) from a browser as
   * the first declared admin, so an installed phone keeps working until its
   * owner signs in with GitHub.
   */
  legacyBearer: boolean;
  /** Reverse-proxy hops in front of the service whose X-Forwarded-For is trusted. */
  trustedProxyHops: number;
  /**
   * An uninvited GitHub sign-in becomes a capped access request the admin can
   * approve or deny. False is strict invite-only: it is refused and nothing
   * is recorded.
   */
  accessRequests: boolean;
  /**
   * The provider and model catalog users set up their firstmate from, or null
   * when none is configured (then the setup routes are off).
   */
  catalog: Catalog | null;
  /** The credential vault, or null without a keyring. Required with a catalog. */
  vault: Vault | null;
}

export const DEFAULT_GATEWAY_DB = "walkie-talkie.gateway.db";
export const MAX_TRUSTED_PROXY_HOPS = 5;
export const DEFAULT_VAULT_ACTIVE_KEY = "k1";

export class GatewayConfigError extends Error {
  override name = "GatewayConfigError";
}

const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function parseMode(value: string | undefined): ServiceMode {
  if (value === undefined || value === "" || value === "standalone") return "standalone";
  if (value === "gateway") return "gateway";
  throw new GatewayConfigError(`FM_WT_MODE must be standalone or gateway, got ${value}`);
}

/** An https origin, or http on a loopback host for local development. */
export function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayConfigError(`FM_WT_PUBLIC_ORIGIN is not a URL: ${value}`);
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_ORIGIN_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw new GatewayConfigError("FM_WT_PUBLIC_ORIGIN must be an https origin (http only on localhost)");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new GatewayConfigError("FM_WT_PUBLIC_ORIGIN must be a bare origin with no path, query or credentials");
  }
  return url.origin;
}

export function parseGithubId(value: unknown, what: string): number {
  const id = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new GatewayConfigError(`${what} must be a positive GitHub numeric id`);
  }
  return id;
}

function parseAdmins(value: unknown): number[] {
  const entries =
    typeof value === "string"
      ? value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      : Array.isArray(value)
        ? value
        : value === undefined || value === null
          ? []
          : null;
  if (entries === null) throw new GatewayConfigError("admins must be a list of GitHub numeric ids");
  const ids = [...new Set(entries.map((entry) => parseGithubId(entry, "each admin")))];
  if (ids.length === 0) {
    throw new GatewayConfigError("gateway mode requires at least one admin GitHub id (FM_WT_ADMINS)");
  }
  return ids;
}

/** An http(s) origin for an in-cluster upstream; no path, query or credentials. */
export function parseUpstream(value: unknown): string {
  if (typeof value !== "string") throw new GatewayConfigError("a static tenant upstream must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayConfigError(`a static tenant upstream is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayConfigError("a static tenant upstream must be http or https");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new GatewayConfigError("a static tenant upstream must be a bare origin with no path, query or credentials");
  }
  return url.origin;
}

function parseStaticTenants(value: unknown, env: NodeJS.ProcessEnv): StaticTenant[] {
  let entries: unknown = value;
  if (typeof value === "string") {
    if (value.trim() === "") return [];
    try {
      entries = JSON.parse(value);
    } catch {
      throw new GatewayConfigError("FM_WT_STATIC_TENANTS must be a JSON array");
    }
  }
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new GatewayConfigError("staticTenants must be an array");
  const seen = new Set<number>();
  return entries.map((entry): StaticTenant => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new GatewayConfigError("each static tenant must be an object");
    }
    const record = entry as Record<string, unknown>;
    const githubId = parseGithubId(record.githubId, "a static tenant githubId");
    if (seen.has(githubId)) {
      throw new GatewayConfigError(`static tenant githubId ${githubId} is declared twice`);
    }
    seen.add(githubId);
    const upstream = parseUpstream(record.upstream);
    const tokenEnv = record.tokenEnv;
    if (typeof tokenEnv !== "string" || !ENV_NAME_PATTERN.test(tokenEnv)) {
      throw new GatewayConfigError(
        `static tenant ${githubId} needs tokenEnv: the name of the environment variable holding its bearer token`,
      );
    }
    const token = env[tokenEnv]?.trim() ?? "";
    if (token.length === 0) {
      throw new GatewayConfigError(`static tenant ${githubId}: environment variable ${tokenEnv} is empty`);
    }
    return { githubId, upstream, token };
  });
}

function parseHops(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const hops = typeof value === "string" ? Number(value) : value;
  if (typeof hops !== "number" || !Number.isInteger(hops) || hops < 0 || hops > MAX_TRUSTED_PROXY_HOPS) {
    throw new GatewayConfigError(`FM_WT_TRUSTED_PROXY_HOPS must be an integer between 0 and ${MAX_TRUSTED_PROXY_HOPS}`);
  }
  return hops;
}

function parseBool(value: unknown, what: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "1" || value === "true") return true;
  if (value === false || value === "0" || value === "false") return false;
  throw new GatewayConfigError(`${what} must be 0/1 or true/false`);
}

function pick(envValue: string | undefined, fileValue: unknown): unknown {
  const trimmed = envValue?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : fileValue;
}

export interface GatewayFileConfig {
  publicOrigin?: unknown;
  githubClientId?: unknown;
  admins?: unknown;
  staticTenants?: unknown;
  gatewayDb?: unknown;
  legacyBearer?: unknown;
  trustedProxyHops?: unknown;
  accessRequests?: unknown;
  catalog?: unknown;
  vaultActiveKey?: unknown;
}

/**
 * The credential vault from FM_WT_VAULT_KEYS (environment only: it is the key
 * material) and the active key id, which is not secret. Null without a keyring.
 */
export function resolveVault(env: NodeJS.ProcessEnv, file: GatewayFileConfig): Vault | null {
  const keyring = env.FM_WT_VAULT_KEYS?.trim() ?? "";
  if (keyring === "") return null;
  const active = pick(env.FM_WT_VAULT_ACTIVE_KEY, file.vaultActiveKey) ?? DEFAULT_VAULT_ACTIVE_KEY;
  if (typeof active !== "string") throw new GatewayConfigError("vaultActiveKey must be a key id");
  try {
    return Vault.fromSettings(keyring, active);
  } catch (error) {
    throw new GatewayConfigError(`FM_WT_VAULT_KEYS: ${error instanceof VaultError ? error.message : "invalid"}`);
  }
}

/** The gateway store path, as the gateway and the `vault` CLI both resolve it. */
export function resolveGatewayDbPath(
  env: NodeJS.ProcessEnv,
  file: GatewayFileConfig,
  resolvePath: (path: string) => string,
): string {
  const dbRaw = pick(env.FM_WT_GATEWAY_DB, file.gatewayDb) ?? DEFAULT_GATEWAY_DB;
  if (typeof dbRaw !== "string" || dbRaw === "") {
    throw new GatewayConfigError("gatewayDb must be a path");
  }
  return resolvePath(dbRaw);
}

/**
 * Resolve the gateway settings. `resolvePath` turns a relative database path
 * into an absolute one the same way the rest of the configuration does.
 */
export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv,
  file: GatewayFileConfig,
  token: string,
  resolvePath: (path: string) => string,
): GatewayConfig {
  const originRaw = pick(env.FM_WT_PUBLIC_ORIGIN, file.publicOrigin);
  if (typeof originRaw !== "string" || originRaw === "") {
    throw new GatewayConfigError("gateway mode requires FM_WT_PUBLIC_ORIGIN, the https origin users open");
  }
  const publicOrigin = parsePublicOrigin(originRaw);

  const clientId = pick(env.FM_WT_GITHUB_CLIENT_ID, file.githubClientId);
  if (typeof clientId !== "string" || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new GatewayConfigError("gateway mode requires FM_WT_GITHUB_CLIENT_ID, the GitHub OAuth App client id");
  }
  // The client secret is environment-only, never read from the config file.
  const clientSecret = env.FM_WT_GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (clientSecret.length === 0) {
    throw new GatewayConfigError("gateway mode requires FM_WT_GITHUB_CLIENT_SECRET in the environment");
  }

  const admins = parseAdmins(pick(env.FM_WT_ADMINS, file.admins));
  const staticTenants = parseStaticTenants(pick(env.FM_WT_STATIC_TENANTS, file.staticTenants), env);

  const dbPath = resolveGatewayDbPath(env, file, resolvePath);

  const legacyBearer = parseBool(pick(env.FM_WT_LEGACY_BEARER, file.legacyBearer), "FM_WT_LEGACY_BEARER") ?? false;
  if (legacyBearer && token.trim().length === 0) {
    throw new GatewayConfigError("FM_WT_LEGACY_BEARER needs FM_WT_TOKEN, the shared token it keeps accepting");
  }

  const vault = resolveVault(env, file);
  const catalogRaw = pick(env.FM_WT_CATALOG, file.catalog);
  let catalog: Catalog | null = null;
  if (catalogRaw !== undefined && catalogRaw !== null && catalogRaw !== "") {
    if (typeof catalogRaw !== "string") throw new GatewayConfigError("FM_WT_CATALOG must be the path of the catalog JSON");
    try {
      catalog = loadCatalog(resolvePath(catalogRaw));
    } catch (error) {
      throw new GatewayConfigError(error instanceof CatalogError ? error.message : String(error));
    }
    if (vault === null) {
      throw new GatewayConfigError("FM_WT_CATALOG needs FM_WT_VAULT_KEYS: users' keys are only ever stored encrypted");
    }
  }

  return {
    publicOrigin,
    githubClientId: clientId,
    githubClientSecret: clientSecret,
    admins,
    staticTenants,
    dbPath,
    legacyBearer,
    trustedProxyHops: parseHops(pick(env.FM_WT_TRUSTED_PROXY_HOPS, file.trustedProxyHops)),
    accessRequests:
      parseBool(pick(env.FM_WT_ACCESS_REQUESTS, file.accessRequests), "FM_WT_ACCESS_REQUESTS") ?? true,
    catalog,
    vault,
  };
}
