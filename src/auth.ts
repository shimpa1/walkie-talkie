import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Compare two secrets without leaking their contents or length through timing.
 * Both values are hashed to a fixed 32 bytes first so `timingSafeEqual` never
 * throws on mismatched lengths, then compared in constant time.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Extract the bearer token from an Authorization header. Returns null when the
 * header is missing or not a bearer scheme. Never throws on attacker input.
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  if (!match || match[1] === undefined) return null;
  return match[1].trim();
}

export function isAuthorized(
  header: string | string[] | undefined,
  expected: string,
): boolean {
  const presented = bearerToken(header);
  if (presented === null) return false;
  return constantTimeEqual(presented, expected);
}
