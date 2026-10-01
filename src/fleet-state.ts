/**
 * Read firstmate's own fleet state, and nothing else.
 *
 * A herdr pane's `agent_status` describes the terminal's agent, not firstmate's
 * work: a pane can read `blocked` while firstmate has nothing in flight, no open
 * decision, and no gate. The Conversations badge must reflect firstmate's real
 * fleet instead, so this module reads the canonical `fm-bearings.v1` projection
 * and reduces it to the few fields a conversation state needs. A read that
 * cannot be served degrades to `null`; the caller shows an unknown state rather
 * than inventing work or a call on the captain.
 *
 * The snapshot is cached for a short interval because the Conversations list is
 * polled far more often than fleet state changes, and a bearings read is more
 * expensive than the herdr reads beside it. A failed read is never cached.
 */

import { FM_SCRIPTS, parseJsonOutput, type FirstmateClient } from "./firstmate.js";

export interface FleetWorker {
  id: string;
  name: string | null;
  state: string;
}

export interface FleetSecondmate {
  id: string;
  state: string;
}

export interface FleetState {
  in_flight: FleetWorker[];
  secondmates: FleetSecondmate[];
  decisions_open: number;
  gates: number;
}

export type FleetStateProvider = () => Promise<FleetState | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseWorkers(value: unknown): FleetWorker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FleetWorker[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === null) return [];
    return [{ id, name: asString(entry.name), state: asString(entry.state) ?? "unknown" }];
  });
}

function parseSecondmates(value: unknown): FleetSecondmate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FleetSecondmate[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === null) return [];
    return [{ id, state: asString(entry.state) ?? "unknown" }];
  });
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Reduce a parsed `fm-bearings.v1` object to the fields a conversation state
 * uses. Returns null when the value is not a bearings object at all; missing
 * surfaces are treated as empty rather than fatal.
 */
export function parseFleetState(raw: unknown): FleetState | null {
  if (!isRecord(raw)) return null;
  return {
    in_flight: parseWorkers(raw.in_flight),
    secondmates: parseSecondmates(raw.secondmates),
    decisions_open: count(raw.decisions_open),
    gates: count(raw.gates),
  };
}

export const DEFAULT_FLEET_CACHE_MS = 10_000;

/**
 * A single bearings read is bounded so a slow or hung script can never hold the
 * polling sessions response until Firstmate's own 60s child timeout. The bound
 * is short relative to the browser's 5s poll.
 */
export const DEFAULT_FLEET_READ_TIMEOUT_MS = 3_000;

export interface FleetStateProviderOptions {
  /** How long a successful read is served before reading again. */
  ttlMs?: number;
  /** How long one caller waits on a read before it yields null. */
  readTimeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Resolve null once `ms` elapses, else the promise's own value. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * A caching fleet-state provider over firstmate's bearings script. Concurrent
 * callers share one in-flight read, a success is cached for `ttlMs`, and any
 * failure (a non-zero exit, malformed JSON, an execution error) returns null
 * without caching so the next call retries. A caller that waits longer than
 * `readTimeoutMs` also gets null without caching, so a hung read degrades the
 * badge to `unknown` instead of stalling the caller; the shared in-flight read
 * keeps the number of script invocations at one.
 */
export function createFleetStateProvider(
  client: FirstmateClient,
  options: FleetStateProviderOptions = {},
): FleetStateProvider {
  const ttlMs = options.ttlMs ?? DEFAULT_FLEET_CACHE_MS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_FLEET_READ_TIMEOUT_MS;
  const now = options.now ?? ((): number => Date.now());
  let cached: FleetState | null = null;
  let cachedAt = 0;
  let inflight: Promise<FleetState | null> | null = null;

  const read = async (): Promise<FleetState | null> => {
    try {
      const result = await client.run(FM_SCRIPTS.bearings, ["--json"]);
      const parsed = parseJsonOutput(result.stdout);
      if (result.code !== 0 || parsed === null) return null;
      return parseFleetState(JSON.parse(parsed));
    } catch {
      return null;
    }
  };

  return async (): Promise<FleetState | null> => {
    if (cached !== null && now() - cachedAt < ttlMs) return cached;
    if (inflight === null) {
      inflight = read()
        .then((value) => {
          if (value !== null) {
            cached = value;
            cachedAt = now();
          }
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return withTimeout(inflight, readTimeoutMs);
  };
}
