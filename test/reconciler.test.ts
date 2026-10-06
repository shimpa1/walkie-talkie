import { test } from "node:test";
import assert from "node:assert/strict";

import { GatewayStore, type UserRecord } from "../src/gateway-store.js";
import { KINDS, KubeClient, KubeError } from "../src/kube.js";
import { podObserved, tenantState, TenantReconciler } from "../src/reconciler.js";
import { MANAGED_BY, MANAGED_BY_LABEL, TENANT_LABEL, tenantNames, type KubeObject } from "../src/tenant-objects.js";
import { TenantTokens } from "../src/tenant-tokens.js";
import { GATEWAY_ROLE, startFakeKube, verbOf, type FakeKube } from "./fake-kube.js";
import { TENANT_MASTER, tenantCatalog, tenantParams } from "./tenant-fixtures.js";

const NAMESPACE = "firstmate-tenants";
const NOW = Date.parse("2026-10-05T12:00:00Z");

type Json = Record<string, any>;

interface Harness {
  fake: FakeKube;
  store: GatewayStore;
  reconciler: TenantReconciler;
  logs: string[];
  tokens: TenantTokens;
  /** A reconciler over the same cluster and store with another token master. */
  withTokens: (tokens: TenantTokens) => TenantReconciler;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const fake = await startFakeKube(NAMESPACE);
  const store = GatewayStore.open(await import("node:sqlite"), ":memory:");
  const logs: string[] = [];
  const tokens = new TenantTokens(TENANT_MASTER);
  const kube = new KubeClient({ server: fake.url, namespace: NAMESPACE, token: () => fake.token });
  let clock = NOW;
  const withTokens = (master: TenantTokens): TenantReconciler =>
    new TenantReconciler({
      store,
      kube,
      params: tenantParams(),
      catalog: tenantCatalog(),
      tokens: master,
      now: () => clock,
      log: (line) => logs.push(line),
    });
  const reconciler = withTokens(tokens);
  return {
    fake,
    store,
    reconciler,
    logs,
    tokens,
    withTokens,
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      await reconciler.stop();
      store.close();
      await fake.close();
    },
  };
}

/** A user who chose a model and started their firstmate. */
function startedUser(store: GatewayStore, githubId: number, login: string, desired: "running" | "stopped" = "running"): { user: UserRecord; tid: string } {
  const user = store.createUser(githubId, login, NOW);
  store.setModelChoice(user.id, { harness: "opencode", provider: "anthropic", model: "claude-sonnet-5-5", routineModel: null }, NOW);
  const tenant = store.ensureTenant(user.id, NOW);
  store.setTenantDesired(user.id, desired, NOW);
  return { user, tid: tenant.tid };
}

function statefulSet(fake: FakeKube, tid: string): Json | undefined {
  return fake.get("statefulsets", tenantNames(tid).workload) as Json | undefined;
}

function readyPod(tid: string, ready: boolean, waiting?: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${tenantNames(tid).workload}-0`,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY, [TENANT_LABEL]: tid, "app.kubernetes.io/name": "firstmate-tenant" },
    },
    status: {
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      containerStatuses: waiting === undefined ? [] : [{ name: "firstmate", state: { waiting: { reason: waiting } } }],
    },
  };
}

/** Every call the reconciler made is one the chart's Role grants, in the tenant namespace. */
function assertOnlyGrantedCalls(fake: FakeKube): void {
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) {
    assert.equal(call.namespace, NAMESPACE, `${call.method} ${call.path} stays in the tenant namespace`);
    assert.ok(["GET", "PATCH", "DELETE"].includes(call.method), `${call.method} ${call.path} uses no other method`);
    assert.doesNotMatch(call.path, /\/(exec|attach|portforward|log|proxy|eviction|binding)$/, `${call.path} is no subresource`);
    assert.doesNotMatch(call.path, /rbac|clusterrole|\/namespaces\/[^/]+$/, `${call.path} is no RBAC or namespace call`);
    const verbs = GATEWAY_ROLE[call.resource];
    assert.ok(verbs, `${call.resource} is a resource the Role names`);
    assert.ok(verbs.includes(verbOf(call)), `${verbOf(call)} ${call.resource} is granted`);
    assert.equal(call.authorization, `Bearer ${fake.token}`);
    if (call.method === "PATCH") {
      assert.equal(call.contentType, "application/apply-patch+yaml");
      assert.equal(call.query.get("fieldManager"), "walkie-talkie-gateway");
      assert.equal(call.query.get("force"), "true");
    }
  }
}

test("a started firstmate is created with server-side apply: its Secret, ConfigMap, Service and StatefulSet", async () => {
  const h = await harness();
  try {
    const { tid } = startedUser(h.store, 4004, "alice");
    const result = await h.reconciler.reconcileOnce();
    assert.equal(result.applied, 4);
    assert.equal(result.errors, 0);
    const names = tenantNames(tid);
    assert.ok(h.fake.get("secrets", names.tokens));
    assert.ok(h.fake.get("configmaps", names.agents));
    assert.ok(h.fake.get("services", names.workload));
    assert.equal(statefulSet(h.fake, tid)?.spec.replicas, 1);
    // No pod yet: still starting.
    assert.equal(result.observed[tid], "pending");
    assert.equal(tenantState(h.store.tenantByUser(h.store.tenantByTid(tid)?.userId ?? "")), "starting");
    assertOnlyGrantedCalls(h.fake);
  } finally {
    await h.close();
  }
});

test("re-applying an unchanged tenant changes nothing (idempotent)", async () => {
  const h = await harness();
  try {
    startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    const changes = h.fake.changes();
    await h.reconciler.reconcileOnce();
    await h.reconciler.reconcileOnce();
    assert.equal(h.fake.changes(), changes);
  } finally {
    await h.close();
  }
});

test("stopping scales to zero and keeps everything; starting again scales back", async () => {
  const h = await harness();
  try {
    const { user, tid } = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    h.store.setTenantDesired(user.id, "stopped", NOW);
    const stopped = await h.reconciler.reconcileOnce();
    assert.equal(statefulSet(h.fake, tid)?.spec.replicas, 0);
    assert.ok(h.fake.get("secrets", tenantNames(tid).tokens));
    assert.ok(h.fake.get("configmaps", tenantNames(tid).agents));
    assert.equal(stopped.observed[tid], "stopped");
    assert.equal(tenantState(h.store.tenantByUser(user.id)), "stopped");

    h.store.setTenantDesired(user.id, "running", NOW);
    await h.reconciler.reconcileOnce();
    assert.equal(statefulSet(h.fake, tid)?.spec.replicas, 1);
  } finally {
    await h.close();
  }
});

test("a suspended user's firstmate is scaled to zero while their choice is kept", async () => {
  const h = await harness();
  try {
    const { user, tid } = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    h.store.setUserState(user.id, "suspended");
    assert.equal(tenantState(h.store.tenantByUser(user.id)), "stopping");
    await h.reconciler.reconcileOnce();
    assert.equal(statefulSet(h.fake, tid)?.spec.replicas, 0);
    assert.equal(tenantState(h.store.tenantByUser(user.id)), "stopped");
    h.store.setUserState(user.id, "active");
    await h.reconciler.reconcileOnce();
    assert.equal(statefulSet(h.fake, tid)?.spec.replicas, 1);
    assert.equal(tenantState(h.store.tenantByUser(user.id)), "starting");
  } finally {
    await h.close();
  }
});

test("a hand edit to a managed field is reverted on the next sweep", async () => {
  const h = await harness();
  try {
    const { tid } = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    const before = JSON.stringify(statefulSet(h.fake, tid));
    const drifted = JSON.parse(before) as Json;
    drifted.spec.replicas = 3;
    drifted.spec.template.spec.containers[0].image = "evil/image:1";
    drifted.spec.template.spec.automountServiceAccountToken = true;
    h.fake.seed("statefulsets", drifted);
    const tampered = JSON.parse(JSON.stringify(h.fake.get("configmaps", tenantNames(tid).agents))) as Json;
    tampered.data["opencode.json"] = '{"model":"other/model"}';
    h.fake.seed("configmaps", tampered);

    await h.reconciler.reconcileOnce();
    assert.equal(JSON.stringify(statefulSet(h.fake, tid)), before);
    assert.match(String((h.fake.get("configmaps", tenantNames(tid).agents) as Json).data["opencode.json"]), /anthropic\/claude-sonnet-5-5/);
  } finally {
    await h.close();
  }
});

test("a removed user's objects are pruned, but never their home volume or anything not the gateway's", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    const bob = startedUser(h.store, 5005, "bob");
    await h.reconciler.reconcileOnce();
    const managed = { [MANAGED_BY_LABEL]: MANAGED_BY, [TENANT_LABEL]: alice.tid };
    h.fake.seed("persistentvolumeclaims", { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: tenantNames(alice.tid).claim, labels: managed } });
    // Objects in the namespace that are not the gateway's: Helm's, and a stranger's.
    h.fake.seed("configmaps", { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "kube-root-ca.crt" } });
    h.fake.seed("services", { apiVersion: "v1", kind: "Service", metadata: { name: "helm-owned", labels: { [MANAGED_BY_LABEL]: "Helm", [TENANT_LABEL]: alice.tid } } });

    h.store.deleteUser(alice.user.id, NOW);
    const result = await h.reconciler.reconcileOnce();
    assert.equal(result.pruned, 4);
    const names = tenantNames(alice.tid);
    assert.equal(h.fake.get("statefulsets", names.workload), undefined);
    assert.equal(h.fake.get("services", names.workload), undefined);
    assert.equal(h.fake.get("configmaps", names.agents), undefined);
    assert.equal(h.fake.get("secrets", names.tokens), undefined);
    assert.ok(h.fake.get("persistentvolumeclaims", names.claim), "the home volume is kept");
    assert.ok(h.fake.get("configmaps", "kube-root-ca.crt"));
    assert.ok(h.fake.get("services", "helm-owned"));
    assert.ok(statefulSet(h.fake, bob.tid), "another user's firstmate is untouched");
    assert.equal(h.fake.calls.filter((call) => call.resource === "persistentvolumeclaims").length, 0);
    assertOnlyGrantedCalls(h.fake);
  } finally {
    await h.close();
  }
});

test("a storage change applies to new tenants only; existing ones keep their claim template and stay appliable", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    const original = statefulSet(h.fake, alice.tid)?.spec.volumeClaimTemplates;
    assert.equal(original?.[0]?.spec.resources.requests.storage, "10Gi");

    // The operator changes the size and class; the gateway restarts with them.
    const resized = new TenantReconciler({
      store: h.store,
      kube: new KubeClient({ server: h.fake.url, namespace: NAMESPACE, token: () => h.fake.token }),
      params: tenantParams({ storage: { storageClass: "fast", size: "20Gi" } }),
      catalog: tenantCatalog(),
      tokens: h.tokens,
      now: () => NOW,
      log: (line) => h.logs.push(line),
    });
    const bob = startedUser(h.store, 5005, "bob");
    h.store.setTenantDesired(alice.user.id, "stopped", NOW);
    const result = await resized.reconcileOnce();
    assert.equal(result.errors, 0, h.logs.join("\n"));
    assert.equal(statefulSet(h.fake, alice.tid)?.spec.replicas, 0, "the existing tenant still scales");
    assert.deepEqual(statefulSet(h.fake, alice.tid)?.spec.volumeClaimTemplates, original);
    const created = statefulSet(h.fake, bob.tid)?.spec.volumeClaimTemplates[0].spec;
    assert.equal(created?.resources.requests.storage, "20Gi");
    assert.equal(created?.storageClassName, "fast");
    assertOnlyGrantedCalls(h.fake);
  } finally {
    await h.close();
  }
});

test("a removed user's tenant is kept as retained until its home volume is purged", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    startedUser(h.store, 5005, "bob");
    assert.deepEqual(h.store.listRetainedTenants(), []);
    h.store.deleteUser(alice.user.id, NOW + 1);
    assert.equal(h.store.tenantByTid(alice.tid), null);
    assert.deepEqual(h.store.listRetainedTenants(), [{ tid: alice.tid, removedAt: NOW + 1, login: "alice", purgeRequestedAt: null }]);
    const nobody = h.store.createUser(6006, "carol", NOW);
    h.store.deleteUser(nobody.id, NOW + 2);
    assert.equal(h.store.listRetainedTenants().length, 1, "a user who never had a tenant leaves nothing behind");
    // A tenant that was never started has no home volume, so nothing is retained.
    const never = h.store.createUser(7007, "dan", NOW);
    h.store.ensureTenant(never.id, NOW);
    h.store.deleteUser(never.id, NOW + 3);
    assert.equal(h.store.listRetainedTenants().length, 1, "a never-started tenant leaves nothing behind");
  } finally {
    await h.close();
  }
});

test("a failed listing prunes nothing of that kind", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    h.store.deleteUser(alice.user.id, NOW);
    h.fake.fail("statefulsets", 500);
    const result = await h.reconciler.reconcileOnce();
    assert.ok(result.errors > 0);
    assert.ok(h.fake.get("statefulsets", tenantNames(alice.tid).workload), "kept while its listing failed");
    h.fake.fail("statefulsets", null);
    await h.reconciler.reconcileOnce();
    assert.equal(h.fake.get("statefulsets", tenantNames(alice.tid).workload), undefined);
  } finally {
    await h.close();
  }
});

test("pod status becomes each tenant's observed state", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    const bob = startedUser(h.store, 5005, "bob");
    h.fake.seed("pods", readyPod(alice.tid, true));
    h.fake.seed("pods", readyPod(bob.tid, false, "CrashLoopBackOff"));
    const result = await h.reconciler.reconcileOnce();
    assert.equal(result.observed[alice.tid], "running");
    assert.equal(result.observed[bob.tid], "crashloop");
    assert.equal(tenantState(h.store.tenantByUser(alice.user.id)), "running");
    assert.equal(tenantState(h.store.tenantByUser(bob.user.id)), "crashloop");
    assert.equal(podObserved(readyPod("uaaaaaaa", false)), "pending");
    assert.equal(podObserved(readyPod("uaaaaaaa", false, "ImagePullBackOff")), "crashloop");
  } finally {
    await h.close();
  }
});

test("a tenant whose choice left the catalog is left exactly as it is", async () => {
  const h = await harness();
  try {
    const { user, tid } = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    const before = JSON.stringify(statefulSet(h.fake, tid));
    h.store.setModelChoice(user.id, { harness: "opencode", provider: "retired", model: "gone", routineModel: null }, NOW);
    const result = await h.reconciler.reconcileOnce();
    assert.equal(result.applied, 0);
    assert.equal(result.pruned, 0);
    assert.equal(JSON.stringify(statefulSet(h.fake, tid)), before);
    assert.ok(h.logs.some((line) => line.includes(`tenant ${tid}: its model choice is not in the catalog`)));
  } finally {
    await h.close();
  }
});

for (const how of ["suspended by an admin", "stopped by its user"] as const) {
  test(`a tenant whose choice left the catalog is still scaled to zero when ${how}, and otherwise left as it is`, async () => {
    const h = await harness();
    try {
      const { user, tid } = startedUser(h.store, 4004, "alice");
      await h.reconciler.reconcileOnce();
      h.store.setModelChoice(user.id, { harness: "opencode", provider: "retired", model: "gone", routineModel: null }, NOW);
      const before = statefulSet(h.fake, tid);
      await h.reconciler.reconcileOnce();
      assert.deepEqual(statefulSet(h.fake, tid), before, "left untouched while it should run");

      if (how === "suspended by an admin") h.store.setUserState(user.id, "suspended");
      else h.store.setTenantDesired(user.id, "stopped", NOW);
      const result = await h.reconciler.reconcileOnce();
      assert.equal(result.errors, 0, h.logs.join("\n"));
      const after = statefulSet(h.fake, tid);
      assert.equal(after?.spec.replicas, 0);
      assert.deepEqual({ ...after?.spec, replicas: 1 }, before?.spec, "nothing but the replicas changed");
      assert.deepEqual(after?.metadata.labels, before?.metadata.labels);
      assert.equal(result.observed[tid], "stopped");
      assert.ok(h.fake.get("configmaps", tenantNames(tid).agents), "nothing is pruned");
      assertOnlyGrantedCalls(h.fake);
    } finally {
      await h.close();
    }
  });
}

test("a tenant nobody started has no objects", async () => {
  const h = await harness();
  try {
    const user = h.store.createUser(4004, "alice", NOW);
    h.store.ensureTenant(user.id, NOW);
    const result = await h.reconciler.reconcileOnce();
    assert.equal(result.applied, 0);
    assert.equal(h.fake.calls.filter((call) => call.method === "PATCH").length, 0);
  } finally {
    await h.close();
  }
});

test("errors and logs name kinds and ids, never a token or an API body", async () => {
  const h = await harness();
  try {
    const { tid } = startedUser(h.store, 4004, "alice");
    h.fake.fail("secrets", 422);
    const result = await h.reconciler.reconcileOnce();
    assert.ok(result.errors > 0);
    assert.ok(h.logs.some((line) => line.includes(`tenant ${tid}: apply Secret failed`) && line.includes("HTTP 422 InternalError")));
    const all = h.logs.join("\n");
    assert.equal(all.includes(h.tokens.apiToken(tid)), false);
    assert.equal(all.includes(h.tokens.credentialToken(tid)), false);
    assert.equal(all.includes("planted"), false, "the API's message is not repeated");
  } finally {
    await h.close();
  }
});

test("the client is bound to its namespace and refuses malformed names", async () => {
  const fake = await startFakeKube(NAMESPACE);
  try {
    const kube = new KubeClient({ server: fake.url, namespace: NAMESPACE, token: () => fake.token });
    await assert.rejects(kube.get(KINDS.secret, "../other"), KubeError);
    await assert.rejects(kube.apply(KINDS.secret, { metadata: { name: "Bad_Name" } }), KubeError);
    assert.equal(await kube.get(KINDS.secret, "absent"), null);
    assert.equal(await kube.delete(KINDS.secret, "absent"), false);
    assert.throws(() => new KubeClient({ server: fake.url, namespace: "Not A Namespace", token: () => "" }), KubeError);
    const wrongToken = new KubeClient({ server: fake.url, namespace: NAMESPACE, token: () => "nope" });
    await assert.rejects(wrongToken.list(KINDS.pod, "a=b"), (error: unknown) => error instanceof KubeError && error.status === 401);
  } finally {
    await fake.close();
  }
});

test("kick runs the reconciler soon after a desired-state change", async () => {
  const h = await harness();
  try {
    const { tid } = startedUser(h.store, 4004, "alice");
    h.reconciler.start();
    for (let i = 0; i < 100 && statefulSet(h.fake, tid) === undefined; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(statefulSet(h.fake, tid));
    const bob = startedUser(h.store, 5005, "bob");
    h.reconciler.kick();
    for (let i = 0; i < 100 && statefulSet(h.fake, bob.tid) === undefined; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(statefulSet(h.fake, bob.tid));
  } finally {
    await h.close();
  }
});

const DAY = 24 * 60 * 60 * 1000;

function homeClaim(tid: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: tenantNames(tid).claim, labels: { [MANAGED_BY_LABEL]: MANAGED_BY, [TENANT_LABEL]: tid } },
  };
}

test("a removed user's home volume is kept for the grace period, then deleted and no longer tracked", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    await h.reconciler.reconcileOnce();
    h.fake.seed("persistentvolumeclaims", homeClaim(alice.tid));
    h.store.deleteUser(alice.user.id, NOW);

    // Within the 30-day grace: the workload goes, the home stays.
    h.advance(29 * DAY);
    const kept = await h.reconciler.reconcileOnce();
    assert.equal(kept.purged, 0);
    assert.equal(statefulSet(h.fake, alice.tid), undefined);
    assert.ok(h.fake.get("persistentvolumeclaims", tenantNames(alice.tid).claim));
    assert.equal(h.store.listRetainedTenants().length, 1);

    // Past it: the claim is deleted, and the record goes once the claim is gone.
    h.advance(2 * DAY);
    await h.reconciler.reconcileOnce();
    assert.equal(h.fake.get("persistentvolumeclaims", tenantNames(alice.tid).claim), undefined);
    const done = await h.reconciler.reconcileOnce();
    assert.equal(done.purged, 1);
    assert.deepEqual(h.store.listRetainedTenants(), []);
    assert.equal(h.store.recentAudit(1)[0]?.action, "tenant.purged");
    assert.deepEqual(h.store.recentAudit(1)[0]?.detail, { tid: alice.tid, reason: "grace_elapsed" });
    assertOnlyGrantedCalls(h.fake);
  } finally {
    await h.close();
  }
});

test("purge-now deletes a removed user's home at once, but only after its workload is gone", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    const bob = startedUser(h.store, 5005, "bob");
    await h.reconciler.reconcileOnce();
    h.fake.seed("persistentvolumeclaims", homeClaim(alice.tid));
    h.fake.seed("persistentvolumeclaims", homeClaim(bob.tid));
    h.store.deleteUser(alice.user.id, NOW);
    assert.equal(h.store.requestPurge(alice.tid, NOW), true);
    assert.equal(h.store.requestPurge("uzzzzzzz", NOW), false);
    // Its StatefulSet is still there (say its listing failed): the claim is not touched yet.
    h.fake.fail("statefulsets", 500);
    await h.reconciler.reconcileOnce();
    assert.ok(h.fake.get("persistentvolumeclaims", tenantNames(alice.tid).claim));
    h.fake.fail("statefulsets", null);

    await h.reconciler.reconcileOnce();
    await h.reconciler.reconcileOnce();
    assert.equal(h.fake.get("persistentvolumeclaims", tenantNames(alice.tid).claim), undefined);
    assert.deepEqual(h.store.listRetainedTenants(), []);
    assert.deepEqual(h.store.recentAudit(1)[0]?.detail, { tid: alice.tid, reason: "purge_now" });
    assert.ok(h.fake.get("persistentvolumeclaims", tenantNames(bob.tid).claim), "another user's home is never touched");
    assert.ok(statefulSet(h.fake, bob.tid));
  } finally {
    await h.close();
  }
});

test("rotating the tenant-token master restarts each tenant once onto new tokens", async () => {
  const h = await harness();
  try {
    const alice = startedUser(h.store, 4004, "alice");
    const bob = startedUser(h.store, 5005, "bob");
    await h.reconciler.reconcileOnce();
    const epoch = (tid: string): string => statefulSet(h.fake, tid)?.spec.template.metadata.annotations["walkie-talkie.atus.hr/token-epoch"];
    const secret = (tid: string): unknown => (h.fake.get("secrets", tenantNames(tid).tokens) as Json | undefined)?.data;
    const before = { alice: [epoch(alice.tid), secret(alice.tid)], bob: [epoch(bob.tid), secret(bob.tid)] };

    const rotated = h.withTokens(new TenantTokens(`${TENANT_MASTER}-rotated`));
    await rotated.reconcileOnce();
    for (const [tid, old] of [[alice.tid, before.alice], [bob.tid, before.bob]] as const) {
      assert.notEqual(epoch(tid), old[0], "the pod template changes, so the pod restarts");
      assert.notDeepEqual(secret(tid), old[1], "the Secret carries the new tokens");
    }
    const changes = h.fake.changes();
    await rotated.reconcileOnce();
    assert.equal(h.fake.changes(), changes, "once: the new master applies no further change");
  } finally {
    await h.close();
  }
});
