import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { SESSION_COOKIE } from "../src/cookies.js";
import type { TenantObserved, UserRecord } from "../src/gateway-store.js";
import type { KeyChecker } from "../src/key-check.js";
import { KubeClient } from "../src/kube.js";
import { RateLimiter } from "../src/rate-limit.js";
import { TenantReconciler } from "../src/reconciler.js";
import { CONFIG_VERSION_ANNOTATION, tenantNames } from "../src/tenant-objects.js";
import { TenantTokens } from "../src/tenant-tokens.js";
import { Vault } from "../src/vault.js";
import { startFakeKube } from "./fake-kube.js";
import {
  ORIGIN,
  readAudit,
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
  /** How often the gateway kicked the reconciler. */
  kicks: () => number;
  /** Give a user a saved provider key and a model choice, so their setup is ready. */
  ready: (user: UserRecord) => void;
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
  const vault = Vault.fromSettings(KEYRING, "k1");
  let kicks = 0;
  const checker = { check: async () => ({ status: "valid", listed: null }) } as unknown as KeyChecker;
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    staticTenants: [{ githubId: ADMIN.id, upstream: captainPod.url, token: "captain-token" }],
    catalog: tenantCatalog(),
    vault,
    keyChecker: checker,
    keyCheckLimits: { perUser: generous(), global: generous() },
    tenants: { params: tenantParams({ maxTenants }), tokens, internalPort: 8788 },
    tenantUpstream: (tid) => upstreams.get(tid)?.url ?? "http://127.0.0.1:9",
    reconciler: {
      kick: () => {
        kicks += 1;
      },
    },
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
  const ready: World["ready"] = (user) => {
    const sealed = vault.seal(user.id, "ANTHROPIC_API_KEY", Buffer.from("sk-ant-ready-key-0001"));
    gateway.store.putCredential(user.id, "ANTHROPIC_API_KEY", "anthropic", sealed, null, 0);
    gateway.store.setModelChoice(user.id, { harness: "opencode", provider: "anthropic", model: "claude-sonnet-5-5", routineModel: null }, 0);
  };
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
    kicks: () => kicks,
    ready,
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

test("a user starts and stops their own managed firstmate once setup is ready; each change kicks the reconciler", async () => {
  const w = await world();
  try {
    const notReady = await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start");
    assert.equal(notReady.status, 409);
    assert.deepEqual(await notReady.json(), { error: "setup_incomplete" });
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id), null, "nothing is provisioned before setup is ready");

    // A key alone is not enough; a chosen model makes setup ready.
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: "sk-ant-alice-key-1" })).status, 200);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 409);
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-sonnet-5-5" })).status, 200);

    const kicksBefore = w.kicks();
    const started = await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start");
    assert.equal(started.status, 200);
    assert.equal(((await started.json()) as Record<string, unknown>).state, "provisioning");
    const tenant = w.gateway.store.tenantByUser(w.users.alice.id);
    assert.equal(tenant?.desired, "running");
    assert.equal(w.kicks(), kicksBefore + 1);
    const audit = await readAudit(w.gateway.config.gateway?.dbPath ?? "");
    assert.ok(audit.some((entry) => entry.action === "firstmate.started" && entry.subject === w.users.alice.id));

    // A cross-site write and a read are refused.
    const crossSite = await fetch(`${w.gateway.url}/api/me/firstmate/stop`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${w.sessions.alice}`, origin: "https://evil.example" },
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await w.call(w.sessions.alice, "GET", "/api/me/firstmate/start")).status, 405);
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.desired, "running");

    const stopped = await w.call(w.sessions.alice, "POST", "/api/me/firstmate/stop");
    assert.equal(stopped.status, 200);
    assert.equal(((await stopped.json()) as Record<string, unknown>).state, "stopping");
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.desired, "stopped");
    assert.equal(w.kicks(), kicksBefore + 2);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.tid, tenant?.tid, "the same tenant starts again");

    // Bob never started one; the captain's is declared in configuration.
    const bobStop = await w.call(w.sessions.bob, "POST", "/api/me/firstmate/stop");
    assert.equal(bobStop.status, 409);
    assert.deepEqual(await bobStop.json(), { error: "firstmate_not_started" });
    const captain = await w.call(w.sessions.admin, "POST", "/api/me/firstmate/start");
    assert.equal(captain.status, 409);
    assert.deepEqual(await captain.json(), { error: "managed_by_config" });
  } finally {
    await w.close();
  }
});

test("without tenant provisioning configured, start and stop are not available", async () => {
  const github = await startFakeGithub();
  const generous = (): RateLimiter => new RateLimiter({ capacity: 1000, refillPerMinute: 1000 });
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    catalog: tenantCatalog(),
    vault: Vault.fromSettings(KEYRING, "k1"),
    signInLimits: { perClient: generous(), global: generous() },
  });
  try {
    const admin = (await signIn(gateway, github, ADMIN)).session;
    assert.ok(admin);
    const response = await fetch(`${gateway.url}/api/me/firstmate/start`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${admin}`, origin: ORIGIN },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "not_available" });
  } finally {
    await gateway.close();
    await github.close();
  }
});

test("starting past maxTenants is refused, counting removed users' retained home volumes; a held tenant may always start again", async () => {
  const w = await world(3);
  try {
    // Two removed users whose home volumes are still in the cluster.
    for (const [id, login] of [[8008, "dave"], [9009, "erin"]] as const) {
      const user = w.gateway.store.createUser(id, login, 0);
      w.gateway.store.ensureTenant(user.id, 0);
      w.gateway.store.setTenantDesired(user.id, "stopped", 0);
      w.gateway.store.deleteUser(user.id, 0);
    }
    assert.equal(w.gateway.store.listRetainedTenants().length, 2);

    // alice and bob plus two retained volumes exceed the cap of three.
    const invite = await w.call(w.sessions.admin, "POST", "/api/admin/invites", { login: "carol" });
    assert.equal(invite.status, 409);
    assert.deepEqual(await invite.json(), { error: "capacity_reached" });

    w.ready(w.users.alice);
    w.ready(w.users.bob);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    const full = await w.call(w.sessions.bob, "POST", "/api/me/firstmate/start");
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), { error: "capacity_reached" });
    assert.equal(w.gateway.store.tenantByUser(w.users.bob.id), null);

    // Alice's tenant already holds its slot: stopping and starting again is fine.
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/stop")).status, 200);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
  } finally {
    await w.close();
  }
});

test("removing a user keeps their tenant as retained, so its home volume stays tracked", async () => {
  const w = await world();
  try {
    w.ready(w.users.alice);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    const tid = w.gateway.store.tenantByUser(w.users.alice.id)?.tid;
    assert.ok(tid);
    const kicksBefore = w.kicks();
    assert.equal((await w.call(w.sessions.admin, "DELETE", `/api/admin/users/${w.users.alice.id}`)).status, 200);
    assert.equal(w.gateway.store.tenantByTid(tid), null);
    assert.deepEqual(
      w.gateway.store.listRetainedTenants().map((retained) => retained.tid),
      [tid],
    );
    assert.equal(w.kicks(), kicksBefore + 1, "the reconciler prunes the removed tenant's objects soon");
  } finally {
    await w.close();
  }
});

test("replacing a delivered key or deleting the GitHub token restarts the running firstmate; deleting its provider key stops it", async () => {
  const w = await world();
  const fake = await startFakeKube("firstmate-tenants");
  const reconciler = new TenantReconciler({
    store: w.gateway.store,
    kube: new KubeClient({ server: fake.url, namespace: "firstmate-tenants", token: () => fake.token }),
    params: tenantParams(),
    catalog: tenantCatalog(),
    tokens: w.tokens,
    now: () => 0,
    log: () => {},
  });
  try {
    w.ready(w.users.alice);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    const tid = w.gateway.store.tenantByUser(w.users.alice.id)?.tid ?? "";
    const rollout = async (): Promise<string> => {
      await reconciler.reconcileOnce();
      const set = fake.get("statefulsets", tenantNames(tid).workload) as { spec: { template: { metadata: { annotations: Record<string, string> } } } };
      return set.spec.template.metadata.annotations[CONFIG_VERSION_ANNOTATION] ?? "";
    };
    const version = (): number => w.gateway.store.tenantByUser(w.users.alice.id)?.configVersion ?? 0;
    assert.equal(await rollout(), "1");

    const steps: Array<[string, string, number]> = [
      ["PUT", "ANTHROPIC_API_KEY", 2],
      ["PUT", "OPENROUTER_API_KEY", 2],
      ["PUT", "GH_TOKEN", 3],
      ["DELETE", "GH_TOKEN", 4],
      ["DELETE", "OPENROUTER_API_KEY", 4],
    ];
    for (const [method, name, expected] of steps) {
      const [kicksBefore, versionBefore] = [w.kicks(), version()];
      const body = method === "PUT" ? { value: `replacement-${name.toLowerCase()}` } : undefined;
      assert.equal((await w.call(w.sessions.alice, method, `/api/me/credentials/${name}`, body)).status, 200, `${method} ${name}`);
      assert.equal(version(), expected, `${method} ${name}`);
      assert.equal(w.kicks() - kicksBefore, expected > versionBefore ? 1 : 0, `${method} ${name} kicks only when delivered`);
      assert.equal(await rollout(), String(expected), `the pod template follows ${method} ${name}`);
    }

    const kicksBefore = w.kicks();
    assert.equal((await w.call(w.sessions.alice, "DELETE", "/api/me/credentials/ANTHROPIC_API_KEY")).status, 200);
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.desired, "stopped");
    assert.equal(version(), 4, "deleting the provider key stops the firstmate rather than restarting it");
    assert.equal(w.kicks(), kicksBefore + 1);
    assert.equal(await rollout(), "4");
    const set = fake.get("statefulsets", tenantNames(tid).workload) as { spec: { replicas: number } };
    assert.equal(set.spec.replicas, 0);
    const audit = await readAudit(w.gateway.config.gateway?.dbPath ?? "");
    assert.ok(audit.some((entry) => entry.action === "firstmate.stopped" && entry.subject === w.users.alice.id));

    const noKey = await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start");
    assert.equal(noKey.status, 409);
    assert.deepEqual(await noKey.json(), { error: "key_required" });
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.desired, "stopped");

    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: "replacement-again" })).status, 200);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    assert.equal(w.gateway.store.tenantByUser(w.users.alice.id)?.desired, "running");
    await rollout();
    assert.equal((fake.get("statefulsets", tenantNames(tid).workload) as { spec: { replicas: number } }).spec.replicas, 1);
  } finally {
    await reconciler.stop();
    await fake.close();
    await w.close();
  }
});

test("an admin sees removed users' retained homes and can purge one now, confirming it by name", async () => {
  const w = await world();
  try {
    w.ready(w.users.alice);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/firstmate/start")).status, 200);
    const tid = w.gateway.store.tenantByUser(w.users.alice.id)?.tid;
    assert.ok(tid);
    assert.equal((await w.call(w.sessions.admin, "DELETE", `/api/admin/users/${w.users.alice.id}`)).status, 200);

    assert.equal((await w.call(w.sessions.bob, "GET", "/api/admin/retained")).status, 403);
    const listed = (await (await w.call(w.sessions.admin, "GET", "/api/admin/retained")).json()) as { retained: Array<Record<string, unknown>> };
    assert.equal(listed.retained.length, 1);
    const entry = listed.retained[0] ?? {};
    assert.equal(entry.tid, tid);
    assert.equal(entry.login, "alice");
    assert.equal(entry.purge_requested, false);
    assert.equal(Date.parse(String(entry.purge_at)) - Date.parse(String(entry.removed_at)), 30 * 24 * 60 * 60 * 1000);

    const mismatch = await w.call(w.sessions.admin, "POST", `/api/admin/retained/${tid}/purge`, { confirm: "uaaaaaaa" });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { error: "confirm_mismatch" });
    assert.equal((await w.call(w.sessions.admin, "POST", "/api/admin/retained/uzzzzzzz/purge", { confirm: "uzzzzzzz" })).status, 404);
    assert.equal((await w.call(w.sessions.bob, "POST", `/api/admin/retained/${tid}/purge`, { confirm: tid })).status, 403);

    const kicksBefore = w.kicks();
    const purge = await w.call(w.sessions.admin, "POST", `/api/admin/retained/${tid}/purge`, { confirm: tid });
    assert.equal(purge.status, 200);
    assert.deepEqual(await purge.json(), { purge: "requested" });
    assert.equal(w.kicks(), kicksBefore + 1, "the reconciler deletes it soon");
    const after = (await (await w.call(w.sessions.admin, "GET", "/api/admin/retained")).json()) as { retained: Array<Record<string, unknown>> };
    assert.equal(after.retained[0]?.purge_requested, true);
    // Until the volume is gone it still holds a slot.
    assert.equal(w.gateway.store.listRetainedTenants().length, 1);
  } finally {
    await w.close();
  }
});

test("a new access request is pushed to each admin's own devices through the admin's firstmate, once", async () => {
  const w = await world();
  try {
    const notices = (): typeof w.captainPod.requests => w.captainPod.requests.filter((request) => request.url === "/api/push/notify");
    const stranger = { id: 7007, login: "stranger" };
    assert.equal((await signIn(w.gateway, w.github, stranger)).location, "/?signin=pending");
    for (let i = 0; i < 100 && notices().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notices().length, 1);
    const notice = notices()[0];
    assert.equal(notice?.method, "POST");
    assert.equal(notice?.headers.authorization, "Bearer captain-token");
    assert.deepEqual(JSON.parse(notice?.body ?? "{}"), {
      title: "Access request",
      body: "@stranger asked to use walkie-talkie.",
      url: "/?view=admin",
      tag: "access-request",
    });
    assert.ok(w.gateway.logs.some((line) => line === `access request notice: admin github ${ADMIN.id} -> HTTP 200`));

    // Signing in again while the request waits notifies nobody again.
    assert.equal((await signIn(w.gateway, w.github, stranger)).location, "/?signin=pending");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notices().length, 1);

    // The notice route is never forwarded from a browser.
    const forwarded = await w.call(w.sessions.admin, "POST", "/api/push/notify", { title: "x", body: "y" });
    assert.equal(forwarded.status, 404);
    assert.equal(notices().length, 1);
  } finally {
    await w.close();
  }
});
