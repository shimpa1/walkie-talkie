import type { IncomingMessage } from "node:http";

/**
 * A token bucket per key, plus helpers to pick the key. The gateway applies it
 * to the unauthenticated sign-in routes so they cannot be hammered. State is
 * in memory and bounded: past `maxKeys` the stalest key is dropped.
 */

export interface RateLimiterOptions {
  /** Burst size: requests allowed at once. */
  capacity: number;
  /** Tokens restored per minute. */
  refillPerMinute: number;
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMinute / 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Take one token for `key`; false when the bucket is empty. */
  allow(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, updatedAt: now };
      if (this.buckets.size >= this.maxKeys) {
        const stalest = this.buckets.keys().next().value;
        if (stalest !== undefined) this.buckets.delete(stalest);
      }
    } else {
      // Re-insert so iteration order tracks recency for the eviction above.
      this.buckets.delete(key);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
      bucket.updatedAt = now;
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

/**
 * The client address. With `trustedHops` reverse proxies in front, each of them
 * appended the address it saw to X-Forwarded-For, so the entry `trustedHops`
 * from the end is the one the outermost trusted proxy saw; anything left of it
 * is client-supplied and ignored. With no trusted hops the socket peer is used.
 */
export function clientAddress(req: IncomingMessage, trustedHops: number): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (trustedHops <= 0) return peer;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string") return peer;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const index = entries.length - trustedHops;
  const chosen = index >= 0 ? entries[index] : undefined;
  return chosen !== undefined && chosen.length <= 64 ? chosen : peer;
}
