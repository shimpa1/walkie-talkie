import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";

import type { PushApi } from "../src/push-service.js";
import type { PushSendSummary } from "../src/push-service.js";
import type { PushSubscription } from "../src/webpush.js";
import { getJson, startTestServer } from "./helpers.js";

function validSubscription(endpoint = "https://push.example.net/abc"): PushSubscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}

interface StubPush extends PushApi {
  added: PushSubscription[];
  removed: string[];
}

function stubPush(publicKey = "test-vapid-public-key"): StubPush {
  const added: PushSubscription[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    publicKey: () => publicKey,
    addSubscription: (subscription: PushSubscription) => {
      added.push(subscription);
      return { ok: true as const, replaced: false };
    },
    removeSubscription: (endpoint: string) => {
      removed.push(endpoint);
      return true;
    },
    sendTest: async (): Promise<PushSendSummary> => ({ sent: 2, failed: 0, removed: 1 }),
  };
}

async function postJson(
  url: string,
  path: string,
  token: string | undefined,
  body: unknown,
  contentType = "application/json",
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url + path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("push config is open and returns only the public key", async () => {
  const push = stubPush();
  const server = await startTestServer({ token: "t", push });
  try {
    const result = await getJson(server.url, "/api/push/config");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { publicKey: "test-vapid-public-key" });

    const wrongMethod = await fetch(`${server.url}/api/push/config`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await server.close();
  }
});

test("push endpoints report 503 when push is not configured", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const config = await getJson(server.url, "/api/push/config");
    assert.equal(config.status, 503);
    const subscribe = await postJson(server.url, "/api/push/subscribe", "t", validSubscription());
    assert.equal(subscribe.status, 503);
  } finally {
    await server.close();
  }
});

test("subscribe, unsubscribe, and test all require the bearer token", async () => {
  const server = await startTestServer({ token: "t", push: stubPush() });
  try {
    const subscribe = await postJson(server.url, "/api/push/subscribe", undefined, validSubscription());
    assert.equal(subscribe.status, 401);
    const unsubscribe = await postJson(server.url, "/api/push/unsubscribe", undefined, {
      endpoint: "https://push.example.net/abc",
    });
    assert.equal(unsubscribe.status, 401);
    const test = await postJson(server.url, "/api/push/test", undefined, {});
    assert.equal(test.status, 401);
  } finally {
    await server.close();
  }
});

test("a valid subscription is stored and a test reaches it", async () => {
  const push = stubPush();
  const server = await startTestServer({ token: "t", push });
  try {
    const subscription = validSubscription();
    const subscribe = await postJson(server.url, "/api/push/subscribe", "t", subscription);
    assert.equal(subscribe.status, 200);
    assert.deepEqual(subscribe.body, { ok: true, replaced: false });
    assert.deepEqual(push.added, [subscription]);

    const test = await postJson(server.url, "/api/push/test", "t", {});
    assert.equal(test.status, 200);
    assert.deepEqual(test.body, { sent: 2, failed: 0, removed: 1 });

    const unsubscribe = await postJson(server.url, "/api/push/unsubscribe", "t", {
      endpoint: subscription.endpoint,
    });
    assert.equal(unsubscribe.status, 200);
    assert.deepEqual(unsubscribe.body, { removed: true });
    assert.deepEqual(push.removed, [subscription.endpoint]);
  } finally {
    await server.close();
  }
});

test("invalid subscriptions are rejected without touching the store", async () => {
  const push = stubPush();
  const server = await startTestServer({ token: "t", push });
  try {
    const insecure = { ...validSubscription(), endpoint: "http://push.example.net/abc" };
    assert.equal((await postJson(server.url, "/api/push/subscribe", "t", insecure)).status, 400);

    const subscription = validSubscription();
    const badPoint = { ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } };
    assert.equal((await postJson(server.url, "/api/push/subscribe", "t", badPoint)).status, 400);

    const badAuth = { ...subscription, keys: { ...subscription.keys, auth: "AAAA" } };
    assert.equal((await postJson(server.url, "/api/push/subscribe", "t", badAuth)).status, 400);

    const offCurve = {
      ...subscription,
      keys: {
        ...subscription.keys,
        p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString("base64url"),
      },
    };
    assert.equal((await postJson(server.url, "/api/push/subscribe", "t", offCurve)).status, 400);

    const missingKeys = { endpoint: subscription.endpoint };
    assert.equal((await postJson(server.url, "/api/push/subscribe", "t", missingKeys)).status, 400);

    const notJson = await postJson(server.url, "/api/push/subscribe", "t", "plain", "text/plain");
    assert.equal(notJson.status, 400);

    assert.deepEqual(push.added, []);
  } finally {
    await server.close();
  }
});

test("unsubscribe rejects a missing or invalid endpoint", async () => {
  const push = stubPush();
  const server = await startTestServer({ token: "t", push });
  try {
    assert.equal((await postJson(server.url, "/api/push/unsubscribe", "t", {})).status, 400);
    assert.equal(
      (await postJson(server.url, "/api/push/unsubscribe", "t", { endpoint: "nope" })).status,
      400,
    );
    assert.deepEqual(push.removed, []);
  } finally {
    await server.close();
  }
});
