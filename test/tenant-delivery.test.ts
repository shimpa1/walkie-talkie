import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { GatewayStore, type UserRecord } from "../src/gateway-store.js";
import { RateLimiter } from "../src/rate-limit.js";
import { createDeliveryHandler } from "../src/tenant-delivery.js";
import { newTenantId, TenantTokenError, TenantTokens, TID_PATTERN } from "../src/tenant-tokens.js";
import { Vault } from "../src/vault.js";
import { TENANT_MASTER, tenantCatalog } from "./tenant-fixtures.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const KEYRING = `k1:${randomBytes(32).toString("base64")}`;
/** Planted secrets: each must reach only its owner's own firstmate, and never a log. */
const ALICE_KEY = `sk-ant-alice-${randomBytes(8).toString("hex")}`;
const ALICE_GH = `github_pat_alice_${randomBytes(8).toString("hex")}`;
const BOB_KEY = `sk-ant-bob-${randomBytes(8).toString("hex")}`;

interface Harness {
  url: string;
  store: GatewayStore;
  tokens: TenantTokens;
  logs: string[];
  alice: { user: UserRecord; tid: string };
  bob: { user: UserRecord; tid: string };
  fetchCredentials: (token: string | null, init?: RequestInit, path?: string) => Promise<Response>;
  close: () => Promise<void>;
}

async function harness(limiter?: RateLimiter): Promise<Harness> {
  const store = GatewayStore.open(await import("node:sqlite"), ":memory:");
  const vault = Vault.fromSettings(KEYRING, "k1");
  const tokens = new TenantTokens(TENANT_MASTER);
  const logs: string[] = [];
  const seed = (githubId: number, login: string, key: string, github: string | null): { user: UserRecord; tid: string } => {
    const user = store.createUser(githubId, login, NOW);
    store.putCredential(user.id, "ANTHROPIC_API_KEY", "anthropic", vault.seal(user.id, "ANTHROPIC_API_KEY", Buffer.from(key)), null, NOW);
    if (github !== null) store.putCredential(user.id, "GH_TOKEN", "github", vault.seal(user.id, "GH_TOKEN", Buffer.from(github)), null, NOW);
    store.setModelChoice(user.id, { harness: "opencode", provider: "anthropic", model: "claude-sonnet-5-5", routineModel: null }, NOW);
    const tenant = store.ensureTenant(user.id, NOW);
    store.setTenantDesired(user.id, "running", NOW);
    return { user, tid: tenant.tid };
  };
  const alice = seed(4004, "alice", ALICE_KEY, ALICE_GH);
  const bob = seed(5005, "bob", BOB_KEY, null);
  const server: Server = createServer(
    createDeliveryHandler({ store, vault, catalog: tenantCatalog(), tokens, now: () => NOW, log: (line) => logs.push(line), ...(limiter ? { limiter } : {}) }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    store,
    tokens,
    logs,
    alice,
    bob,
    fetchCredentials: (token, init = {}, path = "/internal/v1/credentials") =>
      fetch(`${url}${path}`, { ...init, headers: token === null ? {} : { authorization: `Bearer ${token}` } }),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

function assertNoSecretLogged(h: Harness): void {
  const all = h.logs.join("\n");
  for (const secret of [ALICE_KEY, ALICE_GH, BOB_KEY, h.tokens.credentialToken(h.alice.tid), h.tokens.credentialToken(h.bob.tid)]) {
    assert.equal(all.includes(secret), false, "no key or token is logged");
  }
}

test("a running tenant fetches its own provider key and GitHub token, under every catalog name, no-store", async () => {
  const h = await harness();
  try {
    const response = await h.fetchCredentials(h.tokens.credentialToken(h.alice.tid));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      env: { ANTHROPIC_API_KEY: ALICE_KEY, GH_TOKEN: ALICE_GH, GITHUB_TOKEN: ALICE_GH },
    });
    assert.deepEqual(h.logs, [`tenant=${h.alice.tid} delivered n=2`]);
    const audit = h.store.recentAudit(1)[0];
    assert.deepEqual(audit, { at: NOW, actor: null, action: "credentials.delivered", subject: h.alice.user.id, detail: { tid: h.alice.tid, n: 2 } });
  } finally {
    await h.close();
  }
});

test("each tenant gets only its own keys; a token for one tenant never opens another's", async () => {
  const h = await harness();
  try {
    const bob = await h.fetchCredentials(h.tokens.credentialToken(h.bob.tid));
    assert.deepEqual(await bob.json(), { env: { ANTHROPIC_API_KEY: BOB_KEY } });

    // Alice's MAC under Bob's id, and Bob's id with Alice's whole token: both refused.
    const aliceMac = h.tokens.credentialToken(h.alice.tid).split(".")[1];
    for (const forged of [`${h.bob.tid}.${aliceMac}`, `${h.bob.tid}.${h.tokens.credentialToken(h.alice.tid)}`]) {
      const response = await h.fetchCredentials(forged);
      assert.equal(response.status, 401);
      assert.equal((await response.text()).includes(BOB_KEY), false);
    }
    // No query parameter or header can point a delivery elsewhere.
    const steered = await fetch(`${h.url}/internal/v1/credentials?tid=${h.bob.tid}&user=${h.bob.user.id}`, {
      headers: { authorization: `Bearer ${h.tokens.credentialToken(h.alice.tid)}`, "x-tenant": h.bob.tid },
    });
    assert.deepEqual(((await steered.json()) as { env: Record<string, string> }).env.ANTHROPIC_API_KEY, ALICE_KEY);
    assertNoSecretLogged(h);
  } finally {
    await h.close();
  }
});

test("delivery is refused without a valid token, for a suspended user, and for a firstmate not desired running", async () => {
  const h = await harness();
  try {
    const other = new TenantTokens(`${TENANT_MASTER}-a-different-master`);
    for (const token of [null, "", "garbage", h.tokens.apiToken(h.alice.tid), other.credentialToken(h.alice.tid)]) {
      const response = await h.fetchCredentials(token);
      assert.equal(response.status, 401, `token ${token === null ? "none" : "bad"}`);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }

    h.store.setUserState(h.alice.user.id, "suspended");
    const suspended = await h.fetchCredentials(h.tokens.credentialToken(h.alice.tid));
    assert.equal(suspended.status, 403);
    assert.deepEqual(await suspended.json(), { error: "suspended" });
    h.store.setUserState(h.alice.user.id, "active");

    for (const desired of ["stopped", "none"] as const) {
      h.store.setTenantDesired(h.alice.user.id, desired, NOW);
      const response = await h.fetchCredentials(h.tokens.credentialToken(h.alice.tid));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "not_running" });
    }

    // A removed user's tenant is gone with them.
    h.store.deleteUser(h.bob.user.id, 0);
    const removed = await h.fetchCredentials(h.tokens.credentialToken(h.bob.tid));
    assert.equal(removed.status, 403);
    assertNoSecretLogged(h);
  } finally {
    await h.close();
  }
});

test("a tenant without its provider key is refused rather than started keyless", async () => {
  const h = await harness();
  try {
    h.store.deleteCredential(h.alice.user.id, "ANTHROPIC_API_KEY");
    const response = await h.fetchCredentials(h.tokens.credentialToken(h.alice.tid));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "key_missing" });
    assert.equal((await h.fetchCredentials(h.tokens.credentialToken(h.bob.tid))).status, 200);
  } finally {
    await h.close();
  }
});

test("only GET on the one route is served", async () => {
  const h = await harness();
  try {
    const token = h.tokens.credentialToken(h.alice.tid);
    assert.equal((await h.fetchCredentials(token, { method: "POST" })).status, 405);
    for (const path of ["/", "/api/status", "/internal/v1/credentials/x", "/healthz", "/auth/session"]) {
      assert.equal((await h.fetchCredentials(token, {}, path)).status, 404, path);
    }
  } finally {
    await h.close();
  }
});

test("fetches are rate-limited per tenant", async () => {
  const h = await harness(new RateLimiter({ capacity: 2, refillPerMinute: 1, now: () => NOW }));
  try {
    const token = h.tokens.credentialToken(h.alice.tid);
    assert.equal((await h.fetchCredentials(token)).status, 200);
    assert.equal((await h.fetchCredentials(token)).status, 200);
    assert.equal((await h.fetchCredentials(token)).status, 429);
    assert.equal((await h.fetchCredentials(h.tokens.credentialToken(h.bob.tid))).status, 200);
  } finally {
    await h.close();
  }
});

test("tenant tokens are deterministic per tenant, distinct across tenants, and need a real master", () => {
  const tokens = new TenantTokens(TENANT_MASTER);
  const again = new TenantTokens(TENANT_MASTER);
  assert.equal(tokens.apiToken("uaaaaaaa"), again.apiToken("uaaaaaaa"));
  assert.equal(tokens.credentialToken("uaaaaaaa"), again.credentialToken("uaaaaaaa"));
  assert.notEqual(tokens.apiToken("uaaaaaaa"), tokens.apiToken("ubbbbbbb"));
  assert.notEqual(tokens.apiToken("uaaaaaaa"), tokens.credentialToken("uaaaaaaa").split(".")[1]);
  assert.match(tokens.credentialToken("uaaaaaaa"), /^uaaaaaaa\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.verifyCredentialToken(tokens.credentialToken("uaaaaaaa")), "uaaaaaaa");
  assert.equal(tokens.verifyCredentialToken(`${tokens.credentialToken("uaaaaaaa")}x`), null);
  assert.equal(tokens.verifyCredentialToken("UAAAAAAA.x"), null);
  assert.throws(() => new TenantTokens("short"), TenantTokenError);
  for (let i = 0; i < 50; i += 1) assert.match(newTenantId(), TID_PATTERN);
});
