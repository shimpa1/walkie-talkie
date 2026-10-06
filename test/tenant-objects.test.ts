import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { providerById } from "../src/catalog.js";
import {
  AGENTS_CHECKSUM_ANNOTATION,
  buildTenantObjects,
  CONFIG_VERSION_ANNOTATION,
  MANAGED_BY,
  MANAGED_BY_LABEL,
  ROUTINE_RULE,
  TENANT_LABEL,
  tenantAgentsConfig,
  tenantNames,
  tenantUpstream,
  type KubeObject,
  type TenantChoice,
  type TenantSpec,
} from "../src/tenant-objects.js";
import { parseTenantParams, TenantParamsError } from "../src/tenant-params.js";
import { TenantTokens } from "../src/tenant-tokens.js";
import { REPO_ROOT } from "./helpers.js";
import { TENANT_MASTER, TENANT_PARAMS_DOC, tenantCatalog, tenantParams } from "./tenant-fixtures.js";

const SNAPSHOT = join(REPO_ROOT, "test", "fixtures", "tenant-objects.snapshot.json");
const TID = "uk7m2p9q";

function choice(overrides: Partial<TenantChoice> = {}): TenantChoice {
  const provider = providerById(tenantCatalog(), "anthropic");
  assert.ok(provider);
  return { harness: "opencode", provider, model: "claude-sonnet-5-5", routineModel: "claude-haiku-4-5", ...overrides };
}

function spec(overrides: Partial<TenantSpec> = {}): TenantSpec {
  const tokens = new TenantTokens(TENANT_MASTER);
  return {
    tid: TID,
    running: true,
    configVersion: 3,
    choice: choice(),
    githubKeyEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
    tokens: { api: tokens.apiToken(TID), credentials: tokens.credentialToken(TID) },
    ...overrides,
  };
}

type Json = Record<string, any>;

function podSpec(objects: ReturnType<typeof buildTenantObjects>): Json {
  return (objects.statefulSet as Json).spec.template.spec as Json;
}

test("the tenant objects match the reviewed snapshot", () => {
  // Placeholder tokens: the snapshot holds the shape, not anything derived from a secret.
  const objects = buildTenantObjects(tenantParams(), spec({ tokens: { api: "api-token", credentials: `${TID}.credential-token` } }));
  const actual = `${JSON.stringify(objects, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(SNAPSHOT, actual);
  assert.equal(actual, readFileSync(SNAPSHOT, "utf8"), "run with UPDATE_SNAPSHOTS=1 and review the diff");
});

test("a tenant is a Secret, a ConfigMap, a Service and a StatefulSet, all labelled as the gateway's", () => {
  const objects = buildTenantObjects(tenantParams(), spec());
  const names = tenantNames(TID);
  const all: KubeObject[] = [objects.secret, objects.configMap, objects.service, objects.statefulSet];
  assert.deepEqual(
    all.map((object) => [object.kind, (object.metadata as Json).name, (object.metadata as Json).namespace]),
    [
      ["Secret", names.tokens, "firstmate-tenants"],
      ["ConfigMap", names.agents, "firstmate-tenants"],
      ["Service", names.workload, "firstmate-tenants"],
      ["StatefulSet", names.workload, "firstmate-tenants"],
    ],
  );
  for (const object of all) {
    const labels = (object.metadata as Json).labels as Record<string, string>;
    assert.equal(labels[MANAGED_BY_LABEL], MANAGED_BY);
    assert.equal(labels[TENANT_LABEL], TID);
  }
  assert.equal(names.claim, `home-fm-${TID}-0`);
  assert.equal(tenantUpstream(tenantParams(), TID), `http://fm-${TID}.firstmate-tenants.svc:8787`);
});

test("no provider key or GitHub token is ever in a tenant object: only derived tokens and env names", () => {
  const objects = buildTenantObjects(tenantParams(), spec());
  const secretData = (objects.secret as Json).data as Record<string, string>;
  assert.deepEqual(Object.keys(secretData).sort(), ["api", "credentials"]);
  const tokens = new TenantTokens(TENANT_MASTER);
  assert.equal(Buffer.from(secretData.api ?? "", "base64").toString(), tokens.apiToken(TID));
  assert.equal(Buffer.from(secretData.credentials ?? "", "base64").toString(), tokens.credentialToken(TID));

  const opencode = JSON.parse(((objects.configMap as Json).data as Record<string, string>)["opencode.json"] ?? "{}") as Json;
  assert.equal(opencode.provider.anthropic.options.apiKey, "{env:ANTHROPIC_API_KEY}");

  const firstmate = (podSpec(objects).containers as Json[])[0] as Json;
  const env = Object.fromEntries((firstmate.env as Json[]).map((entry) => [entry.name, entry.value ?? entry.valueFrom]));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.deepEqual(env.FM_TENANT_CREDENTIALS_TOKEN, { secretKeyRef: { name: `fm-${TID}-tokens`, key: "credentials" } });
  assert.equal(env.FM_TENANT_CREDENTIALS_URL, "http://firstmate-gateway-internal.firstmate.svc:8788/internal/v1/credentials");
  assert.equal(env.FM_TENANT_CREDENTIAL_ENVS, "ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN");
  assert.equal(env.FM_TENANT_REQUIRED_ENV, "ANTHROPIC_API_KEY");
});

test("tenant pods run under the restricted posture with no token, no service links and no host access", () => {
  const pod = podSpec(buildTenantObjects(tenantParams(), spec()));
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.serviceAccountName, "fm-tenant");
  assert.deepEqual(pod.securityContext, {
    runAsUser: 1000,
    runAsGroup: 1000,
    runAsNonRoot: true,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  for (const container of [...(pod.initContainers as Json[]), ...(pod.containers as Json[])]) {
    assert.deepEqual(container.securityContext, {
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    }, container.name);
    assert.ok((container.resources as Json).limits.memory, `${container.name} has a memory limit`);
  }
  for (const key of ["hostNetwork", "hostPID", "hostIPC"]) assert.equal(pod[key], undefined);
  for (const volume of pod.volumes as Json[]) {
    assert.ok(volume.configMap !== undefined || volume.emptyDir !== undefined, `${volume.name} is a configMap or emptyDir`);
  }
});

test("the sidecar keeps push state on the tenant's own volume and takes the gateway's derived token", () => {
  const pod = podSpec(buildTenantObjects(tenantParams(), spec()));
  const sidecar = (pod.containers as Json[])[1] as Json;
  assert.equal(sidecar.name, "walkie-talkie");
  const env = Object.fromEntries((sidecar.env as Json[]).map((entry) => [entry.name, entry.value ?? entry.valueFrom]));
  assert.equal(env.FM_WT_PUSH_STORE, "/home/firstmate/.walkie-talkie/push.json");
  assert.deepEqual(env.FM_WT_TOKEN, { secretKeyRef: { name: `fm-${TID}-tokens`, key: "api" } });
  assert.equal(env.FM_WT_MODE, undefined, "the tenant sidecar runs in standalone mode");
});

test("a stopped tenant keeps every object at zero replicas", () => {
  const running = buildTenantObjects(tenantParams(), spec());
  const stopped = buildTenantObjects(tenantParams(), spec({ running: false }));
  assert.equal((running.statefulSet as Json).spec.replicas, 1);
  assert.equal((stopped.statefulSet as Json).spec.replicas, 0);
  assert.deepEqual(stopped.secret, running.secret);
  assert.deepEqual(stopped.configMap, running.configMap);
});

test("a key change (config version) and a model change both roll the pod template", () => {
  const annotations = (s: TenantSpec): Record<string, string> =>
    (buildTenantObjects(tenantParams(), s).statefulSet as Json).spec.template.metadata.annotations as Record<string, string>;
  const base = annotations(spec());
  assert.equal(base[CONFIG_VERSION_ANNOTATION], "3");
  assert.equal(annotations(spec({ configVersion: 4 }))[CONFIG_VERSION_ANNOTATION], "4");
  assert.notEqual(annotations(spec({ choice: choice({ model: "claude-opus-5-5" }) }))[AGENTS_CHECKSUM_ANNOTATION], base[AGENTS_CHECKSUM_ANNOTATION]);
  assert.equal(annotations(spec())[AGENTS_CHECKSUM_ANNOTATION], base[AGENTS_CHECKSUM_ANNOTATION]);
});

test("every model-bearing setting comes from the user's one choice", () => {
  const withRoutine = tenantAgentsConfig(choice());
  const opencode = JSON.parse(withRoutine["opencode.json"]) as Json;
  assert.equal(opencode.model, "anthropic/claude-sonnet-5-5");
  assert.equal(opencode.small_model, "anthropic/claude-haiku-4-5");
  assert.deepEqual(opencode.enabled_providers, ["anthropic"]);
  assert.deepEqual(Object.keys(opencode.provider), ["anthropic"]);
  const dispatch = JSON.parse(withRoutine["crew-dispatch.json"]) as Json;
  assert.deepEqual(dispatch, {
    rules: [{ when: ROUTINE_RULE, use: [{ harness: "opencode", model: "anthropic/claude-haiku-4-5" }] }],
    default: [{ harness: "opencode", model: "anthropic/claude-sonnet-5-5" }],
  });

  const single = tenantAgentsConfig(choice({ routineModel: null }));
  assert.equal((JSON.parse(single["opencode.json"]) as Json).small_model, "anthropic/claude-sonnet-5-5");
  assert.deepEqual((JSON.parse(single["crew-dispatch.json"]) as Json).rules, []);

  const provider = providerById(tenantCatalog(), "openrouter");
  assert.ok(provider);
  const routed = JSON.parse(tenantAgentsConfig(choice({ provider, model: "qwen/qwen3.8-27b", routineModel: null }))["opencode.json"]) as Json;
  assert.equal(routed.model, "openrouter/qwen/qwen3.8-27b");
  assert.equal(routed.provider.openrouter.options.apiKey, "{env:OPENROUTER_API_KEY}");
});

test("the agents config is mounted where the chart mounts the captain's", () => {
  const firstmate = (podSpec(buildTenantObjects(tenantParams(), spec())).containers as Json[])[0] as Json;
  assert.deepEqual(
    (firstmate.volumeMounts as Json[]).filter((mount) => mount.name === "agents"),
    [
      { name: "agents", mountPath: "/home/firstmate/config/crew-dispatch.json", subPath: "crew-dispatch.json", readOnly: true },
      { name: "agents", mountPath: "/home/firstmate/.config/opencode/opencode.json", subPath: "opencode.json", readOnly: true },
    ],
  );
});

for (const [label, change, message] of [
  ["a latest image tag", { images: { ...TENANT_PARAMS_DOC.images, firstmate: { image: "shimpa/firstmate-runtime:latest" } } }, /not latest/],
  ["an untagged image", { images: { ...TENANT_PARAMS_DOC.images, walkieTalkie: { image: "shimpa/walkie-talkie" } } }, /repo:tag/],
  ["root", { security: { runAsUser: 0, runAsGroup: 1000, fsGroup: 1000 } }, /runAsUser/],
  ["a non-DNS namespace", { namespace: "Firstmate_Tenants" }, /namespace/],
  ["a container without a memory limit", { resources: { ...TENANT_PARAMS_DOC.resources, init: { requests: { cpu: "10m" }, limits: {} } } }, /limits\.memory/],
  ["an unknown resource", { resources: { ...TENANT_PARAMS_DOC.resources, init: { requests: { "nvidia.com/gpu": "1" }, limits: { memory: "1Gi" } } } }, /not a supported resource/],
  ["a gateway URL with a path", { gatewayInternalUrl: "http://gw:8788/internal" }, /bare origin/],
  ["a multi-line harness command", { harnessCommand: "opencode\nrm -rf /" }, /one line/],
  ["more tenants than the cap", { maxTenants: 1000 }, /maxTenants/],
] as const) {
  test(`tenant parameters refuse ${label}`, () => {
    assert.throws(() => parseTenantParams({ ...TENANT_PARAMS_DOC, ...change }), (error: unknown) => {
      assert.ok(error instanceof TenantParamsError);
      assert.match(error.message, message);
      return true;
    });
  });
}
