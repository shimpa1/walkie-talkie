import type { PushEventState } from "./push-store.js";

/**
 * Turn successive firstmate snapshots into notify-once events.
 *
 * Detection is deliberately limited to clear state transitions:
 *  - a receipt reply with a cursor newer than the stored one;
 *  - a decision or recorded PR id that was absent and is now present;
 *  - a worker whose state changed into (or newly appeared as) "blocked".
 *
 * The first observation is a silent baseline, so a fresh store or a restart
 * seeds the seen-set without replaying everything that already existed.
 */

export interface ReceiptReplyEvent {
  id: string;
  cursor: string;
}

export interface WorkerState {
  id: string;
  state: string;
}

export interface EventSnapshot {
  replies: ReceiptReplyEvent[];
  replyCursor: string;
  decisions: string[];
  recordedPrs: string[];
  workers: WorkerState[];
}

export type PushEvent =
  | { kind: "reply"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "pr"; id: string }
  | { kind: "blocked"; id: string };

export interface DiffResult {
  events: PushEvent[];
  next: PushEventState;
}

function currentMaxCursor(state: PushEventState, snapshot: EventSnapshot): string {
  let cursor = state.replyCursor;
  for (const reply of snapshot.replies) {
    if (reply.cursor > cursor) cursor = reply.cursor;
  }
  if (snapshot.replyCursor > cursor) cursor = snapshot.replyCursor;
  return cursor;
}

export function diffEvents(state: PushEventState, snapshot: EventSnapshot): DiffResult {
  const next: PushEventState = {
    initialized: true,
    replyCursor: currentMaxCursor(state, snapshot),
    decisions: [...new Set(snapshot.decisions)],
    workers: {},
    prs: [...new Set(snapshot.recordedPrs)],
  };

  if (!state.initialized) {
    for (const worker of snapshot.workers) next.workers[worker.id] = worker.state;
    return { events: [], next };
  }

  const events: PushEvent[] = [];

  for (const reply of snapshot.replies) {
    if (reply.cursor > state.replyCursor) events.push({ kind: "reply", id: reply.id });
  }

  const seenDecisions = new Set(state.decisions);
  for (const id of next.decisions) {
    if (!seenDecisions.has(id)) events.push({ kind: "decision", id });
  }

  const seenPrs = new Set(state.prs);
  for (const id of next.prs) {
    if (!seenPrs.has(id)) events.push({ kind: "pr", id });
  }

  for (const worker of snapshot.workers) {
    next.workers[worker.id] = worker.state;
    if (worker.state === "blocked" && state.workers[worker.id] !== "blocked") {
      events.push({ kind: "blocked", id: worker.id });
    }
  }

  return { events, next };
}
