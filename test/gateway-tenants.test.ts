import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { SESSION_COOKIE } from "../src/cookies.js";
import type { TenantObserved, UserRecord } from "../src/gateway-store.js";
import { RateLimiter } from "../src/rate-limit.js";
import { TenantTokens } from "../src/tenant-tokens.js";
import { Vault } from "../src/vault.js";
import {
  ORIGIN,
  signIn,
  startFakeGithub,
  startFakeUpstream,
  startGateway,
  type FakeGithub,
  type FakeUpstream,
  type GatewayHarness,
} from "./gateway-helpers.js";
import { TENANT_MASTER, tenantCatalog, tenantParams } from "./tenant-fixtures.js";

const ADMIN = { id: 1001, login: "captain" };
const ALICE = { id: 4004, login: "alice" };
const BOB = { id: 5005, login: "bob" };
const KEYRING = `k1:${randomBytes(32).toString("base64")}`;

interface World {
  github: FakeGithub;
  captainPod: FakeUpstream;
  upstreams: Map<string, FakeUpstream>;
  gateway: GatewayHarness;
  tokens: TenantTokens;
  sessions: { admin: string; alice: string; bob: string };
  users: { alice: UserRecord; bob: UserRecord };
  call: (session: string | null, method: string, path: string, body?: unknown) => Promise<Response>;
  /** Start a user's managed firstmate as the reconciler would see it. */
  start: (user: UserRecord, observed: TenantObserved) => Promise<{ tid: string; upstream: FakeUpstream }>;
  close: () => Promise<void>;
}

async function world(maxTenants = 5): Promise<World> {
  const github = await startFakeGithub();
  const captainPod = await startFakeUpstream("captain");
  const upstreams = new Map<string, FakeUpstream>();
  const tokens = new TenantTokens(TENANT_MASTER);
  const generous = (): RateLimiter => new RateLimiter({ capacity: 1000, refillPerMinute: 1000 });
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    staticTenants: [{ githubId: ADMIN.id, upstream: captainPod.url, token: "captain-token" }],
    catalog: tenantCatalog(),
    vault: Vault.fromSettings(KEYRING, "k1"),
    tenants: { params: tenantParams({ maxTenants }), tokens, internalPort: 8788 },
    tenantUpstream: (tid) => upstreams.get(tid)?.url ?? "http://127.0.0.1:9",
    signInLimits: { perClient: generous(), global: generous() },
  });
  const call: World["call"] = (session, method, path, body) =>
    fetch(`${gateway.url}${path}`, {
      method,
      headers: {
        ...(session === null ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
        ...(method !== "GET" && method !== "HEAD" ? { origin: ORIGIN } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const admin = (await signIn(gateway, github, ADMIN)).session;
  assert.ok(admin);
  for (const login of [ALICE.login, BOB.login]) {
    assert.equal((await call(admin, "POST", "/api/admin/invites", { login })).status, 201);
  }
  const alice = (await signIn(gateway, github, ALICE)).session;
  const bob = (await signIn(gateway, github, BOB)).session;
  assert.ok(alice && bob);
  const aliceUser = gateway.store.userByGithubId(ALICE.id);
  const bobUser = gateway.store.userByGithubId(BOB.id);
  assert.ok(aliceUser && bobUser);
  const start: World["start"] = async (user, observed) => {
    gateway.store.setModelChoice(user.id, { harness: "opencode", provider: "anthropic", model: "claude-sonnet-5-5", routineModel: null }, 0);
    const tenant = gateway.store.ensureTenant(user.id, 0);
    gateway.store.setTenantDesired(user.id, "running", 0);
    if (observed !== "none") gateway.store.recordTenantObserved(tenant.tid, observed, 0);
    const upstream = upstreams.get(tenant.tid) ?? (await startFakeUpstream(user.login));
    upstreams.set(tenant.tid, upstream);
    return { tid: tenant.tid, upstream };
  };
  return {
    github,
    captainPod,
    upstreams,
    gateway,
    tokens,
    sessions: { admin, alice, bob },
    users: { alice: aliceUser, bob: bobUser },
    call,
    start,
    close: async () => {
      await gateway.close();
      for (const upstream of upstreams.values()) await upstream.close();
      await captainPod.close();
      await github.close();
    },
  };
}

test("a running managed firstmate is reached only by its owner, with that tenant's own derived token", async () => {
  const w = await world();
  try {
    const alice = await w.start(w.users.alice, "running");
    const bob = await w.start(w.users.bob, "running");

    const response = await w.call(w.sessions.alice, "GET", "/api/status");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { upstream: "alice", path: "/api/status" });
    assert.equal(alice.upstream.requests.length, 1);
    assert.equal(alice.upstream.requests[0]?.headers.authorization, `Bearer ${w.tokens.apiToken(alice.tid)}`);
    assert.equal(alice.upstream.requests[0]?.headers.cookie, undefined);

    const note = await w.call(w.sessions.bob, "POST", "/api/note", { text: "hi", requestId: "r1" });
    assert.equal(note.status, 200);
    assert.equal(bob.upstream.requests[0]?.headers.authorization, `Bearer ${w.tokens.apiToken(bob.tid)}`);
    assert.equal(alice.upstream.requests.length, 1, "Bob never reaches Alice's firstmate");

    // The captain still reaches only the static pod.
    assert.equal((await w.call(w.sessions.admin, "GET", "/api/status")).status, 200);
    assert.equal(w.captainPod.requests[0]?.headers.authorization, "Bearer captain-token");
    assert.equal(alice.upstream.requests.length + bob.upstream.requests.length, 2);
  } finally {
    await w.close();
  }
});

test("a managed firstmate that is not running answers 409 with its state, and nothing is forwarded", async () => {
  const w = await world();
  try {
    const none = await w.call(w.sessions.alice, "GET", "/api/status");
    assert.equal(none.status, 409);
    assert.deepEqual(await none.json(), { error: "firstmate_not_provisioned" });

    const { upstream } = await w.start(w.users.alice, "none");
    for (const [observed, state] of [
      ["none", "provisioning"],
      ["pending", "starting"],
      ["crashloop", "crashloop"],
    ] as const) {
      const tenant = w.gateway.store.tenantByUser(w.users.alice.id);
      assert.ok(tenant);
      w.gateway.store.recordTenantObserved(tenant.tid, observed, 1);
      const response = await w.call(w.sessions.alice, "GET", "/api/status");
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "firstmate_not_running", state });
    }
    w.gateway.store.setTenantDesired(w.users.alice.id, "stopped", 2);
    const stopped = await w.call(w.sessions.alice, "GET", "/api/health");
    assert.deepEqual(await stopped.json(), { error: "firstmate_not_running", state: "stopping" });
    assert.equal(upstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("the session probe and the setup view report the managed firstmate's lifecycle", async () => {
  const w = await world();
  try {
    const before = (await (await w.call(w.sessions.alice, "GET", "/auth/session")).json()) as { user: Record<string, unknown> };
    assert.deepEqual(before.user, { login: "alice", admin: false, firstmate: "none", firstmate_state: "none", setup: true });

    await w.start(w.users.alice, "pending");
    const starting = (await (await w.call(w.sessions.alice, "GET", "/auth/session")).json()) as { user: Record<string, unknown> };
    assert.equal(starting.user.firstmate, "ready", "a started firstmate opens the app on Status");
    assert.equal(starting.user.firstmate_state, "starting");
    const view = (await (await w.call(w.sessions.alice, "GET", "/api/me/firstmate")).json()) as Record<string, unknown>;
    assert.equal(view.state, "starting");

    const captain = (await (await w.call(w.sessions.admin, "GET", "/auth/session")).json()) as { user: Record<string, unknown> };
    assert.equal(captain.user.firstmate, "ready");
    assert.equal(captain.user.firstmate_state, "running");

    const users = (await (await w.call(w.sessions.admin, "GET", "/api/admin/users")).json()) as { users: Array<Record<string, unknown>> };
    assert.deepEqual(
      users.users.map((user) => [user.login, user.firstmate]).sort(),
      [
        ["alice", "starting"],
        ["bob", "none"],
        ["captain", "ready"],
      ],
    );
  } finally {
    await w.close();
  }
});

test("approving or inviting past maxTenants is refused; a declared firstmate's owner does not count", async () => {
  const w = await world(3);
  try {
    // alice and bob are managed users; the captain owns the static pod.
    assert.equal((await w.call(w.sessions.admin, "POST", "/api/admin/invites", { login: "carol" })).status, 201);
    const full = await w.call(w.sessions.admin, "POST", "/api/admin/invites", { login: "dave" });
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "capacity_reached" });

    // An access request waits, and cannot be approved while the cap is reached.
    const erin = { id: 7007, login: "erin" };
    assert.equal((await signIn(w.gateway, w.github, erin)).location, "/?signin=pending");
    const approve = await w.call(w.sessions.admin, "POST", `/api/admin/requests/${erin.id}/approve`);
    assert.equal(approve.status, 409);
    assert.deepEqual(await approve.json(), { error: "capacity_reached" });

    // Freeing a slot (revoking carol's invite) lets the approval through.
    const invites = (await (await w.call(w.sessions.admin, "GET", "/api/admin/invites")).json()) as { invites: Array<{ id: string }> };
    const carol = invites.invites[0];
    assert.ok(carol);
    assert.equal((await w.call(w.sessions.admin, "DELETE", `/api/admin/invites/${carol.id}`)).status, 200);
    assert.equal((await w.call(w.sessions.admin, "POST", `/api/admin/requests/${erin.id}/approve`)).status, 200);
  } finally {
    await w.close();
  }
});
