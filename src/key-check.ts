import type { ValidateSpec } from "./catalog.js";

/**
 * Checks a user's key against its provider before the gateway stores it.
 *
 * One GET to the catalog's validation URL, with the key in the declared
 * header. The URL comes only from the catalog and its origin must be one the
 * catalog declares, so a user cannot make the gateway call any other host. The
 * request is https, bounded by a timeout, and never follows a redirect.
 *
 * 2xx is valid, 401/403 is invalid, and anything else (another status, a
 * redirect, a network error, a timeout) is unverified. A provider's response
 * body is read only on success, only to learn which models the key can use,
 * and is never logged or returned: some providers echo part of the key in
 * their error text.
 */

export type KeyCheck =
  | {
      status: "valid";
      /** Model ids the provider listed for this key, or null when it lists none. */
      listed: string[] | null;
    }
  | { status: "invalid" }
  | { status: "unverified" };

export interface KeyCheckerOptions {
  /** The only origins a key may be sent to (the catalog's validation URLs). */
  allowedOrigins: Set<string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** A models listing larger than this is not read; the key is still valid. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

function keyHeaders(spec: ValidateSpec, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "walkie-talkie",
    ...spec.headers,
  };
  if (spec.auth === "bearer") headers.authorization = `Bearer ${key}`;
  else headers[spec.auth] = key;
  return headers;
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LISTING_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Model ids from an OpenAI-style `data[].id` or a Google-style `models[].name` listing. */
export function listedModels(body: string | null): string[] | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const ids: string[] = [];
  if (Array.isArray(record.data)) {
    for (const entry of record.data) {
      const id = (entry as Record<string, unknown> | null)?.id;
      if (typeof id === "string") ids.push(id);
    }
  }
  if (Array.isArray(record.models)) {
    for (const entry of record.models) {
      const name = (entry as Record<string, unknown> | null)?.name;
      if (typeof name === "string") ids.push(name.replace(/^models\//, ""));
    }
  }
  return ids.length === 0 ? null : ids;
}

/**
 * Which of the catalog's `models` a provider listing confirms. A listed id
 * matches a model exactly, or as a dated snapshot of it (`<model>-YYYYMMDD`),
 * which is how some providers list an alias. Null when there is no listing.
 */
export function confirmedModels(models: string[], listed: string[] | null): string[] | null {
  if (listed === null) return null;
  const set = new Set(listed);
  return models.filter(
    (model) => set.has(model) || listed.some((id) => id.startsWith(`${model}-`) && /^\d{8}$/.test(id.slice(model.length + 1))),
  );
}

export class KeyChecker {
  private readonly allowedOrigins: Set<string>;
  private readonly timeoutMs: number;

  constructor(options: KeyCheckerOptions) {
    this.allowedOrigins = options.allowedOrigins;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(spec: ValidateSpec, key: string): Promise<KeyCheck> {
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      return { status: "unverified" };
    }
    // Defense in depth: the spec comes from the parsed catalog, but a key is
    // never sent anywhere the catalog does not declare.
    if (!this.allowedOrigins.has(url.origin)) return { status: "unverified" };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: keyHeaders(spec, key),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: "unverified" };
    }
    if (response.status >= 200 && response.status < 300) {
      let body: string | null = null;
      try {
        body = await readCapped(response);
      } catch {
        body = null;
      }
      return { status: "valid", listed: listedModels(body) };
    }
    try {
      await response.body?.cancel();
    } catch {
      // Nothing from the body is wanted.
    }
    if (response.status === 401 || response.status === 403) return { status: "invalid" };
    return { status: "unverified" };
  }
}
