import { createHmac, randomBytes } from "node:crypto";

import { constantTimeEqual } from "./auth.js";

/**
 * Per-tenant internal tokens, derived from one master secret
 * (`FM_WT_TENANT_TOKEN_SECRET`, held only by the gateway).
 *
 * Each managed tenant has two:
 *
 * - `api`: the bearer the gateway presents to the tenant's walkie-talkie
 *   sidecar (its `FM_WT_TOKEN`);
 * - `credentials`: what the tenant's runtime presents to the gateway's
 *   internal port to fetch its own keys at start: `<tid>.<HMAC>`.
 *
 * Because both are a pure function of the master and the tenant id, a tenant's
 * Secret can be re-rendered from nothing, which keeps reconciliation
 * stateless. A token for one tenant says nothing about another's, and a
 * credential token names its tenant itself, so no request field can point a
 * delivery at a different tenant.
 */

/** Tenant ids: `u` and 7 symbols with no 0/O or 1/l, DNS-safe and opaque. */
export const TID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const TID_PATTERN = /^u[a-km-np-z2-9]{7}$/;
const CREDENTIAL_LABEL = "wt-tenant-cred/v1:";
const API_LABEL = "wt-tenant-api/v1:";
/** The master must carry real entropy: base64 of 32 random bytes is 44 characters. */
export const MIN_MASTER_LENGTH = 32;

export class TenantTokenError extends Error {
  override name = "TenantTokenError";
}

/** A fresh tenant id. 32 symbols, 5 bits each: masking keeps the draw uniform. */
export function newTenantId(): string {
  let tid = "u";
  for (const byte of randomBytes(7)) tid += TID_ALPHABET[byte & 31];
  return tid;
}

export class TenantTokens {
  private readonly master: Buffer;

  constructor(master: string) {
    const trimmed = master.trim();
    if (trimmed.length < MIN_MASTER_LENGTH) {
      throw new TenantTokenError(
        `the tenant-token secret must be at least ${MIN_MASTER_LENGTH} characters (openssl rand -base64 32)`,
      );
    }
    this.master = Buffer.from(trimmed, "utf8");
  }

  private mac(label: string, tid: string): string {
    return createHmac("sha256", this.master).update(`${label}${tid}`, "utf8").digest("base64url");
  }

  /** The bearer the gateway presents to this tenant's sidecar. */
  apiToken(tid: string): string {
    return this.mac(API_LABEL, tid);
  }

  /** The bearer this tenant's runtime presents to fetch its credentials. */
  credentialToken(tid: string): string {
    return `${tid}.${this.mac(CREDENTIAL_LABEL, tid)}`;
  }

  /**
   * A short, one-way fingerprint of the master, carried in every tenant pod's
   * template: rotating the master changes it, so each tenant restarts once
   * onto its new tokens. It reveals nothing usable about the master.
   */
  epoch(): string {
    return createHmac("sha256", this.master).update("wt-tenant-epoch/v1", "utf8").digest("hex").slice(0, 16);
  }

  /**
   * The tenant a presented credential token was minted for, or null. The MAC
   * is compared in constant time; a malformed token never reaches it.
   */
  verifyCredentialToken(presented: string): string | null {
    if (presented.length > 128) return null;
    const dot = presented.indexOf(".");
    if (dot === -1) return null;
    const tid = presented.slice(0, dot);
    if (!TID_PATTERN.test(tid)) return null;
    return constantTimeEqual(presented, this.credentialToken(tid)) ? tid : null;
  }
}
