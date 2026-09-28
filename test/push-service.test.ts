import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Firstmate } from "../src/firstmate.js";
import { PushStore } from "../src/push-store.js";
import {
  FirstmateEventSource,
  notificationFor,
  PushService,
  type PushBearingsSnapshot,
  type PushEventSource,
  type PushReceiptsSnapshot,
} from "../src/push-service.js";
import { generateVapidKeys, type PushMessage, type PushSendResult, type PushSubscription } from "../src/webpush.js";
import { FAKE_BIN, makeHome } from "./helpers.js";

function makeStore(): PushStore {
  const store = new PushStore(join(mkdtempSync(join(tmpdir(), "reach-svc-")), "push.json"));
  store.setVapid(generateVapidKeys());
  return store;
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

interface RecordedSend {
  endpoint: string;
  message: PushMessage;
}

function recordingSender(): {
  sent: RecordedSend[];
  send: (subscription: PushSubscription, message: PushMessage) => Promise<PushSendResult>;
} {
  const sent: RecordedSend[] = [];
  return {
    sent,
    async send(sub: PushSubscription, message: PushMessage): Promise<PushSendResult> {
      sent.push({ endpoint: sub.endpoint, message });
      const gone = sub.endpoint.includes("gone");
      return { status: gone ? 410 : 201, gone };
    },
  };
}

function stubSource(
  receiptPolls: PushReceiptsSnapshot[],
  bearingPolls: PushBearingsSnapshot[],
): PushEventSource {
  let index = 0;
  return {
    async receipts(): Promise<PushReceiptsSnapshot> {
      const entry = receiptPolls[Math.min(index, receiptPolls.length - 1)];
      if (entry === undefined) throw new Error("no receipt poll queued");
      return { replies: entry.replies, cursor: entry.cursor };
    },
    async bearings(): Promise<PushBearingsSnapshot> {
      const entry = bearingPolls[Math.min(index, bearingPolls.length - 1)];
      index += 1;
      if (entry === undefined) throw new Error("no bearings poll queued");
      return entry;
    },
  };
}

test("events map to short fixed notifications with a deep link", () => {
  assert.deepEqual(notificationFor({ kind: "reply", id: "n1" }), {
    title: "firstmate replied",
    body: "A reply to your queued instruction is ready.",
    url: "/?view=receipts",
    tag: "reply",
  });
  assert.deepEqual(notificationFor({ kind: "decision", id: "d1" }), {
    title: "Decision waiting",
    body: "firstmate is waiting on a captain decision.",
    url: "/?view=status",
    tag: "decision",
  });
  assert.deepEqual(notificationFor({ kind: "pr", id: "p1" }), {
    title: "PR ready for review",
    body: "A pull request is ready for review.",
    url: "/?view=status",
    tag: "pr",
  });
  assert.deepEqual(notificationFor({ kind: "blocked", id: "w1" }), {
    title: "Worker blocked",
    body: "A worker is blocked and needs attention.",
    url: "/?view=status",
    tag: "blocked",
  });
});

test("the poller notifies once per new event and not again on the next poll", async () => {
  const store = makeStore();
  store.addSubscription(subscription("https://push.example.net/a"));
  const sender = recordingSender();
  const source = stubSource(
    [
      { replies: [], cursor: "000000000001" },
      { replies: [{ id: "note-2", cursor: "000000000002" }], cursor: "000000000002" },
      { replies: [], cursor: "000000000002" },
    ],
    [
      { decisions: ["d1"], recordedPrs: [], workers: [] },
      { decisions: ["d1", "d2"], recordedPrs: [], workers: [] },
      { decisions: ["d1", "d2"], recordedPrs: [], workers: [] },
    ],
  );
  const service = new PushService({ store, sender, source, pollSeconds: 20 });

  const first = await service.pollOnce();
  assert.deepEqual(first.events, []);
  assert.equal(sender.sent.length, 0);

  const second = await service.pollOnce();
  assert.deepEqual(second.events.map((event) => event.kind).sort(), ["decision", "reply"]);
  assert.equal(sender.sent.length, 2);
  assert.equal(store.getState().replyCursor, "000000000002");

  const third = await service.pollOnce();
  assert.deepEqual(third.events, []);
  assert.equal(sender.sent.length, 2);
});

test("a test notification reaches every device and drops gone subscriptions", async () => {
  const store = makeStore();
  store.addSubscription(subscription("https://push.example.net/a"));
  store.addSubscription(subscription("https://push.example.net/b"));
  store.addSubscription(subscription("https://push.example.net/gone"));
  const sender = recordingSender();
  const service = new PushService({
    store,
    sender,
    source: stubSource([], []),
    pollSeconds: 20,
  });

  const summary = await service.sendTest();
  assert.equal(summary.sent, 2);
  assert.equal(summary.removed, 1);
  assert.equal(store.subscriptionCount(), 2);
  assert.equal(sender.sent[0]?.message.title, "Reach test");
});

test("resubscribing the same endpoint reports a replacement", () => {
  const service = new PushService({
    store: makeStore(),
    sender: recordingSender(),
    source: stubSource([], []),
    pollSeconds: 20,
  });
  assert.equal(service.addSubscription(subscription("https://push.example.net/a")).replaced, false);
  assert.equal(service.addSubscription(subscription("https://push.example.net/a")).replaced, true);
  assert.equal(service.removeSubscription("https://push.example.net/a"), true);
});

test("the firstmate event source reads only the documented fields", async () => {
  const home = makeHome();
  const firstmate = new Firstmate({ binDir: FAKE_BIN, env: { ...process.env, FM_HOME: home } });
  const source = new FirstmateEventSource(firstmate);

  const receipts = await source.receipts("");
  assert.deepEqual(receipts.replies, []);
  assert.equal(receipts.cursor, "");

  const bearings = await source.bearings();
  assert.deepEqual(bearings.decisions, []);
  assert.deepEqual(bearings.recordedPrs, []);
  assert.deepEqual(bearings.workers, [{ id: "w1", state: "working" }]);
});

test("the event source drops free text and keeps only ids, cursors, and states", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-events-"));
  const inbox = join(dir, "fm-inbox.sh");
  writeFileSync(
    inbox,
    `#!/usr/bin/env bash
cat <<'JSON'
{"schema":"fm-inbox-receipts.v1","replies":[{"id":"note-7","body":"a secret reply","cursor":"000000000007"}],"reply_cursor":"000000000007"}
JSON
`,
  );
  chmodSync(inbox, 0o755);
  const bearings = join(dir, "fm-bearings-snapshot.sh");
  writeFileSync(
    bearings,
    `#!/usr/bin/env bash
cat <<'JSON'
{"schema":"fm-bearings.v1","decisions_open":[{"id":"d1","summary":"a secret decision"}],"recorded_prs":[{"id":"task-3","url":"https://github.com/o/r/pull/3"}],"in_flight":[{"id":"w1","state":"blocked","doing":"a secret"}],"prs":"not_requested"}
JSON
`,
  );
  chmodSync(bearings, 0o755);

  const source = new FirstmateEventSource(new Firstmate({ binDir: dir, env: { ...process.env } }));
  assert.deepEqual((await source.receipts("")).replies, [{ id: "note-7", cursor: "000000000007" }]);
  assert.deepEqual(await source.bearings(), {
    decisions: ["d1"],
    recordedPrs: ["task-3"],
    workers: [{ id: "w1", state: "blocked" }],
  });
});
