import { test } from "node:test";
import assert from "node:assert/strict";

import { diffEvents, type EventSnapshot, type PushEvent } from "../src/push-events.js";
import { emptyEventState } from "../src/push-store.js";

function snapshot(partial: Partial<EventSnapshot> = {}): EventSnapshot {
  return {
    replies: [],
    replyCursor: "",
    decisions: [],
    recordedPrs: [],
    workers: [],
    ...partial,
  };
}

function kinds(events: PushEvent[]): string[] {
  return events.map((event) => event.kind).sort();
}

test("the first observation is a silent baseline", () => {
  const first = diffEvents(
    emptyEventState(),
    snapshot({
      replies: [{ id: "note-1", cursor: "000000000001" }],
      replyCursor: "000000000001",
      decisions: ["decision-1"],
      recordedPrs: ["pr-1"],
      workers: [{ id: "w1", state: "blocked" }],
    }),
  );
  assert.deepEqual(first.events, []);
  assert.equal(first.next.initialized, true);
  assert.equal(first.next.replyCursor, "000000000001");
  assert.deepEqual(first.next.decisions, ["decision-1"]);
  assert.deepEqual(first.next.prs, ["pr-1"]);
  assert.deepEqual(first.next.workers, { w1: "blocked" });
});

test("each new event notifies once and not again on the next poll", () => {
  const base = diffEvents(
    emptyEventState(),
    snapshot({ decisions: ["decision-1"], workers: [{ id: "w1", state: "working" }] }),
  ).next;

  const changed = snapshot({
    replies: [{ id: "note-9", cursor: "000000000009" }],
    replyCursor: "000000000009",
    decisions: ["decision-1", "decision-2"],
    recordedPrs: ["pr-7"],
    workers: [
      { id: "w1", state: "working" },
      { id: "w2", state: "blocked" },
    ],
  });

  const first = diffEvents(base, changed);
  assert.deepEqual(kinds(first.events), ["blocked", "decision", "pr", "reply"]);

  const second = diffEvents(first.next, changed);
  assert.deepEqual(second.events, []);
});

test("a worker notifies only on the transition into blocked", () => {
  const working = diffEvents(
    emptyEventState(),
    snapshot({ workers: [{ id: "w1", state: "working" }] }),
  ).next;

  const blocked = diffEvents(working, snapshot({ workers: [{ id: "w1", state: "blocked" }] }));
  assert.deepEqual(kinds(blocked.events), ["blocked"]);

  const stillBlocked = diffEvents(blocked.next, snapshot({ workers: [{ id: "w1", state: "blocked" }] }));
  assert.deepEqual(stillBlocked.events, []);

  const recovered = diffEvents(stillBlocked.next, snapshot({ workers: [{ id: "w1", state: "working" }] }));
  assert.deepEqual(recovered.events, []);
  const again = diffEvents(recovered.next, snapshot({ workers: [{ id: "w1", state: "blocked" }] }));
  assert.deepEqual(kinds(again.events), ["blocked"]);
});

test("a resolved decision can notify again when it reopens", () => {
  const base = diffEvents(emptyEventState(), snapshot({ decisions: ["d1"] })).next;
  const closed = diffEvents(base, snapshot({ decisions: [] }));
  assert.deepEqual(closed.events, []);
  assert.deepEqual(closed.next.decisions, []);
  const reopened = diffEvents(closed.next, snapshot({ decisions: ["d1"] }));
  assert.deepEqual(kinds(reopened.events), ["decision"]);
});

test("an old reply cursor is not replayed after a restart", () => {
  const persisted = diffEvents(
    emptyEventState(),
    snapshot({ replies: [{ id: "n1", cursor: "000000000005" }], replyCursor: "000000000005" }),
  ).next;
  // A restart reuses the persisted cursor; the source only returns newer replies.
  const restart = diffEvents(persisted, snapshot({ replies: [], replyCursor: "000000000005" }));
  assert.deepEqual(restart.events, []);
});
