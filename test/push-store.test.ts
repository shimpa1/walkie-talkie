import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PushStore } from "../src/push-store.js";
import { generateVapidKeys, type PushSubscription } from "../src/webpush.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "reach-push-")), "push.json");
}

function subscription(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } };
}

test("subscriptions add, persist, and reload from disk", () => {
  const path = storePath();
  const store = new PushStore(path);
  store.addSubscription(subscription("https://push.example.net/a"));

  const reopened = new PushStore(path);
  assert.equal(reopened.subscriptionCount(), 1);
  assert.equal(reopened.listSubscriptions()[0]?.endpoint, "https://push.example.net/a");
});

test("the same endpoint replaces rather than duplicates", () => {
  const store = new PushStore(storePath());
  store.addSubscription(subscription("https://push.example.net/a"));
  store.addSubscription({ endpoint: "https://push.example.net/a", keys: { p256dh: "new", auth: "new" } });
  assert.equal(store.subscriptionCount(), 1);
  assert.equal(store.listSubscriptions()[0]?.keys.p256dh, "new");
});

test("removing a subscription persists", () => {
  const path = storePath();
  const store = new PushStore(path);
  store.addSubscription(subscription("https://push.example.net/a"));
  store.addSubscription(subscription("https://push.example.net/b"));

  assert.equal(store.removeSubscription("https://push.example.net/a"), true);
  assert.equal(store.removeSubscription("https://push.example.net/a"), false);
  assert.equal(new PushStore(path).subscriptionCount(), 1);
});

test("VAPID keys persist across reopen", () => {
  const path = storePath();
  const keys = generateVapidKeys();
  new PushStore(path).setVapid(keys);
  assert.deepEqual(new PushStore(path).getVapid(), keys);
});

test("event state persists across reopen", () => {
  const path = storePath();
  const store = new PushStore(path);
  store.setState({
    initialized: true,
    replyCursor: "000000000004",
    decisions: ["d1"],
    workers: { w1: "blocked" },
    prs: ["p1"],
  });

  const reopened = new PushStore(path).getState();
  assert.equal(reopened.initialized, true);
  assert.equal(reopened.replyCursor, "000000000004");
  assert.deepEqual(reopened.decisions, ["d1"]);
  assert.deepEqual(reopened.workers, { w1: "blocked" });
  assert.deepEqual(reopened.prs, ["p1"]);
});

test("the store file is written owner-only", () => {
  const path = storePath();
  new PushStore(path).addSubscription(subscription("https://push.example.net/a"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a corrupt store file degrades to empty state", () => {
  const path = storePath();
  const store = new PushStore(path);
  store.addSubscription(subscription("https://push.example.net/a"));
  writeFileSync(path, "{ not json");
  const reopened = new PushStore(path);
  assert.equal(reopened.subscriptionCount(), 0);
  assert.equal(reopened.getState().initialized, false);
});
