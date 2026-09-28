import { createECDH, randomUUID } from "node:crypto";

import type { PushSubscription } from "./webpush.js";

/**
 * Mirrors firstmate's own `valid_request_id` contract in bin/fm-inbox.sh:
 * a non-empty token of at most 128 chars from [A-Za-z0-9._:-] that does not
 * start with a dot. Keeping the service's validation identical means a request
 * id that the service accepts can always be handed to firstmate unchanged.
 */
export function isValidRequestId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value.startsWith(".")) return false;
  return /^[A-Za-z0-9._:-]+$/.test(value);
}

export function newRequestId(): string {
  return randomUUID();
}

export const MAX_INSTRUCTION_BYTES = 32 * 1024;
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

/**
 * A push endpoint is the browser's own delivery URL. It must be an https URL:
 * the service POSTs to it, so a plaintext or non-URL value is refused.
 */
export function isValidPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PUSH_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

/**
 * Validate the subscription the browser posts back from `pushManager.subscribe`.
 * p256dh must be an uncompressed P-256 point and auth a 16-byte secret, both
 * base64url, matching the encodings RFC 8291 expects.
 */
export function isValidPushSubscription(value: unknown): value is PushSubscription {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!isValidPushEndpoint(record.endpoint)) return false;
  const keys = record.keys;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) return false;
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = keyRecord.p256dh;
  const auth = keyRecord.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return false;
  const p256dhBytes = decodeBase64Url(p256dh);
  const authBytes = decodeBase64Url(auth);
  if (p256dhBytes === null || p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) return false;
  if (authBytes === null || authBytes.length !== 16) return false;
  // Reject a point that is not actually on the P-256 curve before storing it.
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(p256dhBytes);
  } catch {
    return false;
  }
  return true;
}
