/**
 * Firstmate's own live state, read from signals that are true from this
 * service's container.
 *
 * `fm-inbox.sh ready` decides whether firstmate can receive a note from the
 * session lock's pid. When this service runs in its own container beside
 * firstmate (the Kubernetes deployment), that pid lives in another process
 * namespace: the lock reads `stale`, the wake consumer `unknown`, and
 * `can_receive` false while firstmate is in fact draining notes. This module
 * corrects exactly that case from two signals readable across containers -
 * herdr's view of the primary pane (herdr's server runs beside firstmate and
 * reports an `agent` only while the agent process is alive) and the watcher's
 * beacon age in the shared home - without ever looking at firstmate's
 * processes or environment.
 *
 * The same reads drive one shared live-state view, so the Status tab and a
 * queued conversation agree on whether firstmate is busy or idle.
 */

import type { Conversations, ConversationSession } from "./conversations.js";
import { FM_SCRIPTS, parseJsonOutput, type FirstmateClient } from "./firstmate.js";
import { withTimeout } from "./timeout.js";

/** firstmate's own guard grace (`FM_GUARD_GRACE`) for a fresh watcher beacon. */
export const WATCHER_BEACON_GRACE_SECONDS = 300;

/** Bound on each read behind the live state, so a hung read cannot stall a poll. */
export const DEFAULT_LIVE_READ_TIMEOUT_MS = 3_000;

export const CROSS_CONTAINER_BASIS = "herdr-primary-agent-and-watcher-beacon";
export const CROSS_CONTAINER_DIAGNOSTIC_SCOPE = "walkie-talkie-process-namespace";
export const CROSS_CONTAINER_DIAGNOSTIC_NOTE =
  "The lock PID is not observable from this container; raw lock and wake_consumer diagnostics describe " +
  "the walkie-talkie process namespace. Effective readiness is based on Herdr's primary agent and the watcher beacon.";

/** The primary pane as herdr reports it, or null when herdr lists none. */
export interface PrimaryPane {
  id: string;
  /** The agent herdr sees running in the pane; null when none is running. */
  agent: string | null;
  /** herdr's agent status for the pane: working, idle, blocked, done, ... */
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function primaryPane(sessions: readonly ConversationSession[]): PrimaryPane | null {
  const primary = sessions.find((session) => session.kind === "primary");
  if (primary === undefined) return null;
  return { id: primary.id, agent: primary.agent, status: primary.status };
}

/**
 * Correct a `fm-primary-ready.v1` document whose `can_receive` is false only
 * because the lock holder is invisible from this container. The correction
 * applies when the lock reads stale/unknown without a live harness, the wake
 * consumer could not be classified (`unknown`, never `down`), herdr shows the
 * primary pane's agent running, and the watcher beacon is within firstmate's
 * guard grace. Any other document is returned unchanged.
 */
export function correctReadiness(ready: unknown, primary: PrimaryPane | null | undefined): unknown {
  if (!isRecord(ready) || ready.can_receive === true) return ready;
  if (primary === undefined || primary === null || primary.agent === null) return ready;
  const lock = isRecord(ready.lock) ? ready.lock : {};
  const consumer = isRecord(ready.wake_consumer) ? ready.wake_consumer : {};
  if (lock.state !== "stale" && lock.state !== "unknown") return ready;
  if (lock.live_harness === true) return ready;
  if (consumer.state !== "unknown") return ready;
  const age = consumer.beacon_age_seconds;
  if (typeof age !== "number" || age < 0 || age > WATCHER_BEACON_GRACE_SECONDS) return ready;
  return {
    ...ready,
    can_receive: true,
    can_receive_basis: CROSS_CONTAINER_BASIS,
    diagnostic_scope: CROSS_CONTAINER_DIAGNOSTIC_SCOPE,
    diagnostic_note: CROSS_CONTAINER_DIAGNOSTIC_NOTE,
  };
}

export interface FirstmateQueue {
  /** Notes firstmate has not acknowledged yet. */
  queued: number;
  /** When the oldest unacknowledged note was queued, as the inbox recorded it. */
  oldest_queued_at: string | null;
}

export interface FirstmateLiveState {
  schema: "walkie-talkie-firstmate.v1";
  observed_at: string;
  /**
   * busy: the primary agent is working; idle: running and ready for input;
   * blocked: herdr saw an approval or question prompt; not_running; unknown.
   */
  activity: "busy" | "idle" | "blocked" | "not_running" | "unknown";
  primary: PrimaryPane | null;
  can_receive: boolean | "unknown";
  watcher_beacon_age_seconds: number | null;
  /** null when the receipts read failed. */
  queue: FirstmateQueue | null;
}

export function activityOf(primary: PrimaryPane | null | undefined): FirstmateLiveState["activity"] {
  if (primary === undefined) return "unknown";
  if (primary === null || primary.agent === null) return "not_running";
  if (primary.status === "working") return "busy";
  if (primary.status === "blocked") return "blocked";
  if (primary.status === "idle" || primary.status === "done") return "idle";
  return "unknown";
}

export function queueOf(receipts: unknown): FirstmateQueue | null {
  if (!isRecord(receipts) || !Array.isArray(receipts.pending)) return null;
  let queued = 0;
  let oldest: string | null = null;
  for (const note of receipts.pending) {
    if (!isRecord(note) || note.acknowledged === true) continue;
    queued += 1;
    const at = typeof note.at === "string" ? note.at : null;
    if (at !== null && (oldest === null || Date.parse(at) < Date.parse(oldest))) oldest = at;
  }
  return { queued, oldest_queued_at: oldest };
}

async function readJson(client: FirstmateClient, args: string[], timeoutMs: number): Promise<unknown> {
  const result = await withTimeout(client.run(FM_SCRIPTS.inbox, args), timeoutMs);
  if (result === null || result.code !== 0) return null;
  const parsed = parseJsonOutput(result.stdout);
  return parsed === null ? null : (JSON.parse(parsed) as unknown);
}

/** The primary pane, null when herdr lists none, undefined when herdr cannot be read. */
export async function readPrimary(
  conversations: Conversations | undefined,
  timeoutMs: number = DEFAULT_LIVE_READ_TIMEOUT_MS,
): Promise<PrimaryPane | null | undefined> {
  if (conversations === undefined) return undefined;
  const sessions = await withTimeout(conversations.panes(), timeoutMs);
  return sessions === null ? undefined : primaryPane(sessions);
}

export async function readLiveState(
  client: FirstmateClient,
  conversations: Conversations | undefined,
  timeoutMs: number = DEFAULT_LIVE_READ_TIMEOUT_MS,
): Promise<FirstmateLiveState> {
  const [primary, ready, receipts] = await Promise.all([
    readPrimary(conversations, timeoutMs),
    readJson(client, ["ready"], timeoutMs).catch(() => null),
    readJson(client, ["receipts"], timeoutMs).catch(() => null),
  ]);
  const corrected = correctReadiness(ready, primary);
  const consumer = isRecord(corrected) && isRecord(corrected.wake_consumer) ? corrected.wake_consumer : {};
  const canReceive = isRecord(corrected) && typeof corrected.can_receive === "boolean" ? corrected.can_receive : "unknown";
  return {
    schema: "walkie-talkie-firstmate.v1",
    observed_at: new Date().toISOString(),
    activity: activityOf(primary),
    primary: primary ?? null,
    can_receive: canReceive,
    watcher_beacon_age_seconds:
      typeof consumer.beacon_age_seconds === "number" ? consumer.beacon_age_seconds : null,
    queue: queueOf(receipts),
  };
}
