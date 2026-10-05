import { readFileSync } from "node:fs";

/**
 * The provider and model catalog: what the admin offers and users pick from.
 *
 * It is declared in the repo (`tenants.catalog` in the Helm values) and the
 * chart renders it as JSON into the tenant-params ConfigMap the gateway mounts.
 * Each provider names the environment variable its key travels under, the one
 * URL that proves a key works, and the models on offer. The validation URLs
 * here are the only hosts the gateway ever sends a user's key to, so a user can
 * never point it anywhere else.
 */

/** How a key is presented to the provider's validation endpoint. */
export type KeyAuth = "bearer" | "x-api-key" | "x-goog-api-key";

export interface ValidateSpec {
  /** An https URL that answers 2xx for a working key and 401/403 for a bad one. */
  url: string;
  auth: KeyAuth;
  /** Extra non-secret request headers, e.g. anthropic-version. */
  headers: Record<string, string>;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** The environment variable the key is delivered under; also the credential's name. */
  keyEnv: string;
  validate: ValidateSpec;
  /** Model ids on offer, as the provider names them. */
  models: string[];
}

export interface CatalogGithub {
  /** Environment variable names the token is delivered under; the first names the credential. */
  keyEnv: string[];
  validate: ValidateSpec;
}

export interface Catalog {
  harnesses: string[];
  providers: CatalogProvider[];
  /** The optional per-user GitHub token, or null when the catalog offers none. */
  github: CatalogGithub | null;
}

/** A credential a user may store: a provider key or their GitHub token. */
export type CredentialSlot =
  | { name: string; kind: "provider"; provider: CatalogProvider }
  | { name: string; kind: "github"; github: CatalogGithub };

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface CatalogOptions {
  /**
   * Accept http:// validation URLs on a loopback host. Only tests set this, to
   * point validation at local fake providers; configuration never can.
   */
  allowLoopbackHttp?: boolean;
}

const KEY_AUTHS: readonly KeyAuth[] = ["bearer", "x-api-key", "x-goog-api-key"];
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HARNESS_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,256}$/;
const DISPLAY_NAME = /^[^\x00-\x1f\x7f]{1,64}$/;
/** Headers a catalog may not set: the key's own headers and anything routing-related. */
const RESERVED_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key", "host", "cookie", "content-length", "transfer-encoding", "connection"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseValidate(value: unknown, where: string, options: CatalogOptions): ValidateSpec {
  if (!isRecord(value)) throw new CatalogError(`${where}.validate must be an object with url and auth`);
  if (typeof value.url !== "string") throw new CatalogError(`${where}.validate.url is required`);
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new CatalogError(`${where}.validate.url is not a URL`);
  }
  const loopbackHttp = options.allowLoopbackHttp === true && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) throw new CatalogError(`${where}.validate.url must be https`);
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new CatalogError(`${where}.validate.url must not carry credentials or a fragment`);
  }
  const auth = value.auth;
  if (typeof auth !== "string" || !(KEY_AUTHS as readonly string[]).includes(auth)) {
    throw new CatalogError(`${where}.validate.auth must be one of ${KEY_AUTHS.join(", ")}`);
  }
  const headers: Record<string, string> = {};
  if (value.headers !== undefined && value.headers !== null) {
    if (!isRecord(value.headers)) throw new CatalogError(`${where}.validate.headers must be a map`);
    for (const [name, headerValue] of Object.entries(value.headers)) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
        throw new CatalogError(`${where}.validate.headers: ${name} is not an allowed header`);
      }
      if (typeof headerValue !== "string" || !HEADER_VALUE.test(headerValue)) {
        throw new CatalogError(`${where}.validate.headers.${name} must be a short printable string`);
      }
      headers[name.toLowerCase()] = headerValue;
    }
  }
  return { url: url.toString(), auth: auth as KeyAuth, headers };
}

function parseEnvName(value: unknown, what: string): string {
  if (typeof value !== "string" || !ENV_NAME.test(value)) {
    throw new CatalogError(`${what} must be an environment variable name`);
  }
  return value;
}

/** Validate a catalog document. Every rule here is also enforced at chart render time. */
export function parseCatalog(value: unknown, options: CatalogOptions = {}): Catalog {
  if (!isRecord(value)) throw new CatalogError("the catalog must be an object");

  if (!Array.isArray(value.harnesses) || value.harnesses.length === 0) {
    throw new CatalogError("catalog.harnesses must list at least one harness");
  }
  const harnesses: string[] = [];
  for (const entry of value.harnesses) {
    const name = isRecord(entry) ? entry.name : entry;
    if (typeof name !== "string" || !HARNESS_NAME.test(name)) {
      throw new CatalogError("each catalog.harnesses entry needs a name");
    }
    if (harnesses.includes(name)) throw new CatalogError(`catalog.harnesses: ${name} is listed twice`);
    harnesses.push(name);
  }

  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw new CatalogError("catalog.providers must list at least one provider");
  }
  const envNames = new Set<string>();
  const providers: CatalogProvider[] = value.providers.map((entry, index): CatalogProvider => {
    const where = `catalog.providers[${index}]`;
    if (!isRecord(entry)) throw new CatalogError(`${where} must be an object`);
    const id = entry.id;
    if (typeof id !== "string" || !PROVIDER_ID.test(id)) {
      throw new CatalogError(`${where}.id must be a lowercase provider id`);
    }
    const name = entry.name === undefined || entry.name === null ? id : entry.name;
    if (typeof name !== "string" || !DISPLAY_NAME.test(name)) {
      throw new CatalogError(`${where}.name must be a short display name`);
    }
    const keyEnv = parseEnvName(entry.keyEnv, `${where}.keyEnv`);
    if (envNames.has(keyEnv)) throw new CatalogError(`${where}.keyEnv ${keyEnv} is used twice`);
    envNames.add(keyEnv);
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      throw new CatalogError(`${where}.models must list at least one model`);
    }
    const models: string[] = [];
    for (const model of entry.models) {
      if (typeof model !== "string" || !MODEL_ID.test(model)) {
        throw new CatalogError(`${where}.models: each model must be a model id`);
      }
      if (models.includes(model)) throw new CatalogError(`${where}.models: ${model} is listed twice`);
      models.push(model);
    }
    return { id, name, keyEnv, validate: parseValidate(entry.validate, where, options), models };
  });
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new CatalogError(`catalog.providers: ${provider.id} is declared twice`);
    ids.add(provider.id);
  }

  let github: CatalogGithub | null = null;
  if (value.github !== undefined && value.github !== null) {
    if (!isRecord(value.github)) throw new CatalogError("catalog.github must be an object");
    const rawEnv = value.github.keyEnv;
    const list = typeof rawEnv === "string" ? [rawEnv] : rawEnv;
    if (!Array.isArray(list) || list.length === 0) {
      throw new CatalogError("catalog.github.keyEnv must name at least one environment variable");
    }
    const keyEnv: string[] = [];
    for (const name of list) {
      const env = parseEnvName(name, "catalog.github.keyEnv");
      if (envNames.has(env) || keyEnv.includes(env)) throw new CatalogError(`catalog.github.keyEnv ${env} is used twice`);
      keyEnv.push(env);
    }
    github = { keyEnv, validate: parseValidate(value.github.validate, "catalog.github", options) };
  }

  return { harnesses, providers, github };
}

/** Read and validate the catalog file the chart mounts. */
export function loadCatalog(path: string): Catalog {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new CatalogError(`cannot read the catalog ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CatalogError(`the catalog ${path} is not valid JSON`);
  }
  return parseCatalog(parsed);
}

/** Every credential a user may store, by name. */
export function credentialSlots(catalog: Catalog): Map<string, CredentialSlot> {
  const slots = new Map<string, CredentialSlot>();
  for (const provider of catalog.providers) {
    slots.set(provider.keyEnv, { name: provider.keyEnv, kind: "provider", provider });
  }
  const github = catalog.github;
  const githubName = github?.keyEnv[0];
  if (github !== null && githubName !== undefined) slots.set(githubName, { name: githubName, kind: "github", github });
  return slots;
}

/** The origins the gateway may send a key to: exactly the catalog's validation URLs. */
export function validationOrigins(catalog: Catalog): Set<string> {
  const origins = new Set<string>();
  for (const provider of catalog.providers) origins.add(new URL(provider.validate.url).origin);
  if (catalog.github !== null) origins.add(new URL(catalog.github.validate.url).origin);
  return origins;
}

export function providerById(catalog: Catalog, id: string): CatalogProvider | null {
  return catalog.providers.find((provider) => provider.id === id) ?? null;
}
