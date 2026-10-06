import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCatalog, validationOrigins } from "../src/catalog.js";
import { REPO_ROOT } from "./helpers.js";

const CHART = join(REPO_ROOT, "deploy", "helm", "firstmate");
const VALUES_ATUS = join(CHART, "examples", "values-atus.yaml");

const helmCheck = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
const skipHelm = helmCheck.status === 0 ? false : "helm is not installed";

interface Render {
  status: number;
  stdout: string;
  stderr: string;
}

function render(args: string[]): Render {
  const result = spawnSync(
    "helm",
    ["template", "firstmate", CHART, "--namespace", "firstmate", ...args],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function valuesFile(values: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chart-values-"));
  const file = join(dir, "values.yaml");
  writeFileSync(file, JSON.stringify(values));
  return file;
}

const BASE = {
  agents: { enabled: true, harnesses: [{ name: "opencode" }] },
};

/**
 * Pull a ConfigMap block-scalar value out of `helm template` output. The chart
 * writes the block with a four-space indent, so the body ends at the next line
 * that is non-blank and not indented at least four spaces.
 */
function blockScalar(rendered: string, key: string): string | null {
  const lines = rendered.split("\n");
  const start = lines.indexOf(`  ${key}: |-`);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    body.push(line.startsWith("    ") ? line.slice(4) : "");
  }
  return body.join("\n");
}

test("agents are absent by default", { skip: skipHelm }, () => {
  const rendered = render([]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.includes("firstmate-agents"), false);
  assert.equal(rendered.stdout.includes("crew-dispatch.json"), false);
});

test("the atus example publishes the provider catalog and dispatch profiles", { skip: skipHelm }, () => {
  const rendered = render(["-f", VALUES_ATUS]);
  assert.equal(rendered.status, 0, rendered.stderr);

  const opencodeRaw = blockScalar(rendered.stdout, "opencode.json");
  assert.ok(opencodeRaw, "opencode.json is rendered");
  const opencode = JSON.parse(opencodeRaw) as {
    provider: Record<string, { name?: string; npm?: string; options?: Record<string, string>; models?: Record<string, { name?: string }> }>;
  };
  assert.equal(opencode.provider.deepseek?.options?.apiKey, "{env:DEEPSEEK_API_KEY}");
  assert.equal(opencode.provider.openrouter?.options?.apiKey, "{env:OPENROUTER_API_KEY}");
  // The retired 3090 box is gone from the catalog: no local3090 provider.
  assert.equal(opencode.provider.local3090, undefined);

  const dispatchRaw = blockScalar(rendered.stdout, "crew-dispatch.json");
  assert.ok(dispatchRaw, "crew-dispatch.json is rendered");
  const dispatch = JSON.parse(dispatchRaw) as {
    rules: { when: string; use: { harness: string; model?: string }[] }[];
    default: { harness: string; model?: string }[];
  };
  assert.equal(dispatch.default[0]?.harness, "opencode");
  assert.equal(dispatch.rules[0]?.use[0]?.model, "openrouter/qwen/qwen3.8-27b");
});

test("a provider may reference an env var declared by a harness", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode", env: ["OPENROUTER_API_KEY"] }],
      providers: [{ id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }],
    },
  });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const opencode = JSON.parse(blockScalar(rendered.stdout, "opencode.json") ?? "{}") as {
    provider: Record<string, { options?: Record<string, string> }>;
  };
  assert.equal(opencode.provider.openrouter?.options?.apiKey, "{env:OPENROUTER_API_KEY}");
});

test("a provider env var no harness declares fails the render", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode", env: ["OTHER_KEY"] }],
      providers: [{ id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }],
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /not declared in any agents\.harnesses/);
});

test("a literal provider apiKey is rejected so no key can reach the ConfigMap", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode", env: ["K"] }],
      providers: [{ id: "x", apiKey: "literal", apiKeyEnv: "K" }],
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /apiKey/);
});

test("apiKeyEnv renders only an env reference, never a key value", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode", env: ["K"] }],
      providers: [{ id: "x", apiKeyEnv: "K" }],
    },
  });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const opencode = JSON.parse(blockScalar(rendered.stdout, "opencode.json") ?? "{}") as {
    provider: Record<string, { options?: Record<string, string> }>;
  };
  assert.equal(opencode.provider.x?.options?.apiKey, "{env:K}");
});

test("a literal key smuggled through options.apiKey fails the render", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode" }],
      providers: [{ id: "x", options: { apiKey: "literal" } }],
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /apiKeyEnv, not options\.apiKey/);
});

test("a dispatch profile naming an undeclared harness fails the render", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode" }],
      dispatch: { default: [{ harness: "claude" }] },
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /harness "claude" is not declared/);
});

test("an explicitly empty dispatch default fails the render", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode" }],
      dispatch: { default: [] },
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(
    rendered.stderr,
    /agents\.dispatch\.default must be a profile object or non-empty profile array/,
  );
});

test("a single dispatch profile object is accepted", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "opencode" }],
      dispatch: { default: { harness: "opencode", model: "openrouter/qwen/qwen3.8-27b" } },
    },
  });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const dispatch = JSON.parse(blockScalar(rendered.stdout, "crew-dispatch.json") ?? "{}") as {
    default: { harness: string; model?: string };
  };
  assert.equal(dispatch.default.harness, "opencode");
  assert.equal(dispatch.default.model, "openrouter/qwen/qwen3.8-27b");
});

test("a provider catalog without the opencode harness fails the render", { skip: skipHelm }, () => {
  const file = valuesFile({
    agents: {
      enabled: true,
      harnesses: [{ name: "claude" }],
      providers: [{ id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" }],
    },
  });
  const rendered = render(["-f", file]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /declare "opencode" in agents\.harnesses/);
});

test("agents enabled without a provider or dispatch fails the render", { skip: skipHelm }, () => {
  const rendered = render(["-f", valuesFile(BASE)]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /requires agents\.providers or agents\.dispatch/);
});

test("the herdr CLI is not installed by default", { skip: skipHelm }, () => {
  const rendered = render([]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.includes("install-herdr"), false);
  assert.equal(rendered.stdout.includes("FM_WT_HERDR_BIN"), false);
});

test("the atus example installs the herdr CLI for the Conversations view", { skip: skipHelm }, () => {
  const rendered = render(["-f", VALUES_ATUS]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /name: install-herdr/);
  assert.match(rendered.stdout, /image: .*firstmate-runtime/);
  assert.match(rendered.stdout, /name: FM_WT_HERDR_BIN\n\s+value: "\/opt\/herdr\/herdr"/);
  assert.match(rendered.stdout, /name: XDG_CONFIG_HOME\n\s+value: "\/home\/firstmate\/\.config"/);
});

test("the atus example takes GitHub auth from the Doppler secret, not the chart Secret", { skip: skipHelm }, () => {
  const rendered = render(["-f", VALUES_ATUS]);
  assert.equal(rendered.status, 0, rendered.stderr);
  // The Doppler-synced Secret is injected, so its GH_TOKEN key becomes the env
  // var GH_TOKEN.
  assert.match(
    rendered.stdout,
    /envFrom:\n\s+- configMapRef:[\s\S]*?secretRef:\n\s+name: firstmate-doppler-secrets/,
  );
  // The same key is mapped to GITHUB_TOKEN, optionally so a missing key does
  // not block the pod.
  assert.match(
    rendered.stdout,
    /- name: GITHUB_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: GH_TOKEN\n\s+name: firstmate-doppler-secrets\n\s+optional: true/,
  );
  // The chart's own GitHub token wiring is off, so it never reads a token from
  // its credential Secret.
  assert.doesNotMatch(
    rendered.stdout,
    /name: GH_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: firstmate-credentials/,
  );
});

test("an existing secret may supply GitHub via GH_TOKEN with the chart wiring off", { skip: skipHelm }, () => {
  const file = valuesFile({
    firstmate: {
      extraEnvFrom: [{ secretRef: { name: "my-doppler-secrets" } }],
      extraEnv: [
        {
          name: "GITHUB_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "my-doppler-secrets",
              key: "GH_TOKEN",
              optional: true,
            },
          },
        },
      ],
    },
    credentials: { githubTokenEnabled: false },
  });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(
    rendered.stdout,
    /- name: GITHUB_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: GH_TOKEN\n\s+name: my-doppler-secrets\n\s+optional: true/,
  );
  assert.doesNotMatch(rendered.stdout, /- name: GH_TOKEN\n\s+valueFrom:/);
});

test("herdrCLI installs herdr from the firstmate image into a shared volume", { skip: skipHelm }, () => {
  const file = valuesFile({ walkieTalkie: { herdrCLI: { enabled: true } } });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /- cp\n\s+- \/usr\/local\/bin\/herdr/);
  assert.match(rendered.stdout, /- name: herdr-bin\n\s+emptyDir: \{\}/);
});

// ---------------------------------------------------------------------------
// Multi-user gateway
// ---------------------------------------------------------------------------

/** The rendered manifests, one string per document. */
function documents(rendered: string): string[] {
  return rendered
    .split(/^---$/m)
    .map((doc) => doc.replace(/^# Source: .*$/m, "").trim())
    .filter((doc) => doc.length > 0);
}

/** The single document of `kind` named `name`, or null. */
function findDoc(rendered: string, kind: string, name: string): string | null {
  const matches = documents(rendered).filter(
    (doc) => new RegExp(`^kind: ${kind}$`, "m").test(doc) && new RegExp(`^metadata:\\n  name: ${name}$`, "m").test(doc),
  );
  assert.ok(matches.length <= 1, `at most one ${kind}/${name}`);
  return matches[0] ?? null;
}

/** "Kind/name" for every rendered object, sorted. */
function inventory(rendered: string): string[] {
  return documents(rendered)
    .map((doc) => `${/^kind: (\S+)$/m.exec(doc)?.[1]}/${/^metadata:\n  name: (\S+)$/m.exec(doc)?.[1]}`)
    .sort();
}

/** A fixed token so the chart's generated credential Secret renders the same twice. */
const FIXED_TOKEN = ["--set", "credentials.create.walkieTalkieToken=tok"];

/** The atus example as committed: the gateway is on. */
const GATEWAY_ON = ["-f", VALUES_ATUS, ...FIXED_TOKEN];

/** The atus example with the gateway switched off, as the rollback would. */
const GATEWAY_OFF = ["-f", VALUES_ATUS, "--set", "gateway.enabled=false", ...FIXED_TOKEN];

/** A complete gateway block, for proving it changes nothing while disabled. */
const FULL_GATEWAY = {
  githubClientId: "Ov23liExample",
  admins: [20532068],
  legacyBearer: { enabled: true },
  staticTenants: [
    {
      githubId: 20532068,
      upstream: "http://firstmate.firstmate.svc.cluster.local:8787",
      tokenSecretRef: { name: "firstmate-credentials", key: "walkie-talkie-token" },
    },
  ],
  secrets: { existingSecret: "firstmate-gateway-secrets" },
};

const PRE_GATEWAY_INVENTORY = [
  "ConfigMap/firstmate-agents",
  "ConfigMap/firstmate-config",
  "HTTPRoute/firstmate",
  "HTTPRoute/firstmate-redirect",
  "Secret/firstmate-credentials",
  "Service/firstmate",
  "Service/firstmate-headless",
  "ServiceAccount/firstmate",
  "StatefulSet/firstmate",
];

test("gateway off: the atus example renders the same objects and route as before", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_OFF);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.deepEqual(inventory(rendered.stdout), PRE_GATEWAY_INVENTORY);
  assert.doesNotMatch(rendered.stdout, /firstmate-gateway|FM_WT_MODE/);
  const route = findDoc(rendered.stdout, "HTTPRoute", "firstmate");
  assert.ok(route);
  assert.match(route, /kind: Service\n\s+name: firstmate\n\s+port: 8787/);
});

test("gateway off: a filled-in gateway block changes nothing", { skip: skipHelm }, () => {
  const plain = render(FIXED_TOKEN);
  const filled = render(["-f", valuesFile({ gateway: { ...FULL_GATEWAY, enabled: false } }), ...FIXED_TOKEN]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(filled.status, 0, filled.stderr);
  assert.equal(filled.stdout, plain.stdout);
  assert.doesNotMatch(plain.stdout, /firstmate-gateway|FM_WT_MODE/);
});

test("gateway off: the plain network policy still admits the Gateway namespace", { skip: skipHelm }, () => {
  const rendered = render(["--set", "networkPolicy.enabled=true", ...FIXED_TOKEN]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const policy = findDoc(rendered.stdout, "NetworkPolicy", "firstmate");
  assert.ok(policy);
  assert.match(policy, /kubernetes\.io\/metadata\.name: nginx-gateway/);
});

test("gateway on: the route switches to the gateway Service", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  const route = findDoc(rendered.stdout, "HTTPRoute", "firstmate");
  assert.ok(route);
  assert.match(route, /kind: Service\n\s+name: firstmate-gateway\n\s+port: 8787/);
  // The HTTP -> HTTPS redirect route is unchanged and never names a backend.
  const redirect = findDoc(rendered.stdout, "HTTPRoute", "firstmate-redirect");
  assert.ok(redirect);
  assert.doesNotMatch(redirect, /backendRefs/);
  // The internal credential port is never routed publicly.
  assert.doesNotMatch(rendered.stdout, /name: firstmate-gateway-internal\n\s+port:/);
});

test("gateway on: the firstmate StatefulSet is byte-identical", { skip: skipHelm }, () => {
  const off = render(GATEWAY_OFF);
  const on = render(GATEWAY_ON);
  assert.equal(on.status, 0, on.stderr);
  const before = findDoc(off.stdout, "StatefulSet", "firstmate");
  assert.ok(before);
  assert.equal(findDoc(on.stdout, "StatefulSet", "firstmate"), before);
  assert.equal(findDoc(on.stdout, "Service", "firstmate"), findDoc(off.stdout, "Service", "firstmate"));
  assert.equal(findDoc(on.stdout, "Secret", "firstmate-credentials"), findDoc(off.stdout, "Secret", "firstmate-credentials"));
  assert.equal(findDoc(on.stdout, "ConfigMap", "firstmate-agents"), findDoc(off.stdout, "ConfigMap", "firstmate-agents"));
});

test("gateway on: the workload, its claim and two Services render", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.deepEqual(
    inventory(rendered.stdout),
    [
      ...PRE_GATEWAY_INVENTORY,
      "ConfigMap/firstmate-tenant-params",
      "Deployment/firstmate-gateway",
      "NetworkPolicy/firstmate",
      "NetworkPolicy/firstmate-gateway",
      "PersistentVolumeClaim/firstmate-gateway-data",
      "Service/firstmate-gateway",
      "Service/firstmate-gateway-internal",
      "ServiceAccount/firstmate-gateway",
    ].sort(),
  );

  const deployment = findDoc(rendered.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  assert.match(deployment, /type: Recreate/);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.match(deployment, /name: FM_WT_MODE\n\s+value: gateway/);
  assert.match(deployment, /name: FM_WT_PUBLIC_ORIGIN\n\s+value: "https:\/\/walkie-talkie\.atus\.hr"/);
  assert.match(deployment, /name: FM_WT_ADMINS\n\s+value: "20532068"/);
  assert.match(deployment, /name: FM_WT_LEGACY_BEARER\n\s+value: "1"/);
  assert.match(deployment, /name: FM_WT_GATEWAY_DB\n\s+value: "\/data\/walkie-talkie\.gateway\.db"/);
  assert.match(deployment, /claimName: firstmate-gateway-data/);
  assert.match(deployment, /path: \/healthz/);

  // Every secret arrives by reference: the OAuth client secret, vault keyring
  // and tenant-token master from the dedicated gateway Secret, the static
  // tenant's and the legacy bridge's token from the chart's credential Secret.
  for (const [env, secret, key] of [
    ["FM_WT_GITHUB_CLIENT_SECRET", "firstmate-gateway-secrets", "WT_GITHUB_CLIENT_SECRET"],
    ["FM_WT_VAULT_KEYS", "firstmate-gateway-secrets", "WT_VAULT_KEYS"],
    ["FM_WT_TENANT_TOKEN_SECRET", "firstmate-gateway-secrets", "WT_TENANT_TOKEN_SECRET"],
    ["FM_WT_STATIC_TENANT_TOKEN_0", "firstmate-credentials", "walkie-talkie-token"],
    ["FM_WT_TOKEN", "firstmate-credentials", "walkie-talkie-token"],
  ] as const) {
    assert.match(
      deployment,
      new RegExp(`name: ${env}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: ${secret}\\n\\s+key: ${key}`),
      `${env} comes from ${secret}/${key}`,
    );
  }

  const tenantsRaw = /name: FM_WT_STATIC_TENANTS\n\s+value: (".*")/.exec(deployment)?.[1];
  assert.ok(tenantsRaw, "FM_WT_STATIC_TENANTS is rendered");
  assert.deepEqual(JSON.parse(JSON.parse(tenantsRaw) as string), [
    {
      githubId: 20532068,
      tokenEnv: "FM_WT_STATIC_TENANT_TOKEN_0",
      upstream: "http://firstmate.firstmate.svc.cluster.local:8787",
    },
  ]);

  const claim = findDoc(rendered.stdout, "PersistentVolumeClaim", "firstmate-gateway-data");
  assert.ok(claim);
  assert.match(claim, /helm\.sh\/resource-policy: keep/);
  assert.match(claim, /storageClassName: "beta3"/);

  const internal = findDoc(rendered.stdout, "Service", "firstmate-gateway-internal");
  assert.ok(internal);
  assert.match(internal, /port: 8788\n\s+targetPort: internal/);
});

test("gateway on: gateway pods never match the firstmate pod's selector", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  const deployment = findDoc(rendered.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  const podLabels = /template:\n\s+metadata:\n\s+labels:\n((?:\s+\S+: \S+\n)+)/.exec(deployment)?.[1] ?? "";
  assert.match(podLabels, /app\.kubernetes\.io\/name: firstmate-gateway/);
  assert.match(podLabels, /app\.kubernetes\.io\/component: gateway/);
  assert.doesNotMatch(podLabels, /app\.kubernetes\.io\/name: firstmate\n/);
});

test("gateway on: only the gateway reaches the firstmate pod", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "--set", "networkPolicy.enabled=true"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  // One firstmate pod policy, the gateway-only one: the plain policy that
  // admits the Gateway namespace would reopen the direct path.
  const policy = findDoc(rendered.stdout, "NetworkPolicy", "firstmate");
  assert.ok(policy);
  assert.match(
    policy,
    /podSelector:\n\s+matchLabels:\n\s+app\.kubernetes\.io\/name: firstmate\n\s+app\.kubernetes\.io\/instance: firstmate\n/,
  );
  assert.match(
    policy,
    /- from:\n\s+- podSelector:\n\s+matchLabels:\n\s+app\.kubernetes\.io\/name: firstmate-gateway\n\s+app\.kubernetes\.io\/instance: firstmate\n\s+app\.kubernetes\.io\/component: gateway\n\s+ports:\n\s+- protocol: TCP\n\s+port: walkie-talkie/,
  );
  assert.doesNotMatch(policy, /namespaceSelector/);

  const gatewayPolicy = findDoc(rendered.stdout, "NetworkPolicy", "firstmate-gateway");
  assert.ok(gatewayPolicy);
  assert.match(
    gatewayPolicy,
    /kubernetes\.io\/metadata\.name: nginx-gateway\n\s+ports:\n\s+- protocol: TCP\n\s+port: http\n/,
  );
  assert.match(
    gatewayPolicy,
    /kubernetes\.io\/metadata\.name: firstmate-tenants\n\s+ports:\n\s+- protocol: TCP\n\s+port: internal/,
  );
});

test("gateway on: the network policies can be turned off", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "--set", "gateway.networkPolicy.enabled=false"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout.includes("kind: NetworkPolicy"), false);
});

test("gateway on: the legacy bridge is off unless enabled and then reads no token", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "--set", "gateway.legacyBearer.enabled=false"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const deployment = findDoc(rendered.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  assert.match(deployment, /name: FM_WT_LEGACY_BEARER\n\s+value: "0"/);
  assert.doesNotMatch(deployment, /name: FM_WT_TOKEN\n/);
});

const helmHelp = skipHelm ? "" : spawnSync("helm", ["template", "--help"], { encoding: "utf8" }).stdout ?? "";
const skipSchemaFlag = helmHelp.includes("--skip-schema-validation");

for (const [label, values] of [
  ["gateway.githubClientSecret", { gateway: { githubClientSecret: "literal" } }],
  ["gateway.secrets.githubClientSecret", { gateway: { secrets: { githubClientSecret: "literal" } } }],
  ["gateway.secrets as a string", { gateway: { secrets: "literal" } }],
  ["gateway.vaultKeys", { gateway: { vaultKeys: "k1:literal" } }],
  ["gateway.legacyBearer.token", { gateway: { legacyBearer: { enabled: true, token: "literal" } } }],
  [
    "gateway.staticTenants[].token",
    {
      gateway: {
        staticTenants: [{ githubId: 1, upstream: "http://fm:8787", token: "literal", tokenSecretRef: { name: "s", key: "k" } }],
      },
    },
  ],
] as const) {
  test(`an inline secret fails the render: ${label}`, { skip: skipHelm }, () => {
    const file = valuesFile(values);
    const rendered = render(["-f", file, ...FIXED_TOKEN]);
    assert.notEqual(rendered.status, 0, `${label} rendered`);
    if (skipSchemaFlag) {
      // The template refuses it too, for renders that skip the schema.
      const unchecked = render(["-f", file, "--skip-schema-validation", ...FIXED_TOKEN]);
      assert.notEqual(unchecked.status, 0, `${label} rendered without the schema`);
      assert.match(unchecked.stderr, /inline secret values are refused/);
    }
  });
}

test("an inline FM_WT_* secret cannot be injected through gateway env", { skip: skipHelm }, () => {
  const file = valuesFile({
    gateway: { extraEnv: [{ name: "FM_WT_GITHUB_CLIENT_SECRET", value: "literal-client-secret" }] },
  });
  const rendered = render([...GATEWAY_ON, "-f", file]);
  assert.notEqual(rendered.status, 0, "gateway.extraEnv rendered");
  if (skipSchemaFlag) {
    const unchecked = render([...GATEWAY_ON, "-f", file, "--skip-schema-validation"]);
    assert.equal(unchecked.status, 0, unchecked.stderr);
    const deployment = findDoc(unchecked.stdout, "Deployment", "firstmate-gateway");
    assert.ok(deployment);
    assert.equal(deployment.includes("literal-client-secret"), false);
    assert.match(deployment, /name: FM_WT_GITHUB_CLIENT_SECRET\n\s+valueFrom:\n\s+secretKeyRef:/);
  }
});

test("gateway on without admins fails the render",{ skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "-f", valuesFile({ gateway: { admins: [] } })]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /requires at least one admin GitHub numeric id in gateway\.admins/);
});

test("gateway on without the OAuth client id fails the render", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "--set", "gateway.githubClientId="]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /requires gateway\.githubClientId/);
});

test("gateway on without the secrets Secret fails the render", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "--set", "gateway.secrets.existingSecret="]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /requires gateway\.secrets\.existingSecret/);
});

test("a static tenant declared twice fails the render", { skip: skipHelm }, () => {
  const tenant = FULL_GATEWAY.staticTenants[0];
  const rendered = render([...GATEWAY_ON, "-f", valuesFile({ gateway: { staticTenants: [tenant, tenant] } })]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /githubId 20532068 is declared twice/);
});

test("a static tenant without a token reference fails the render", { skip: skipHelm }, () => {
  const rendered = render([
    ...GATEWAY_ON,
    "-f",
    valuesFile({ gateway: { staticTenants: [{ githubId: 1, upstream: "http://fm:8787" }] } }),
  ]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /tokenSecretRef/);
});

// ---------------------------------------------------------------------------
// Tenant catalog (gateway mode)
// ---------------------------------------------------------------------------

/** The launch catalog from values.yaml, as a values document to vary. */
function launchCatalog(): Record<string, unknown> {
  const rendered = render([...GATEWAY_ON]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const raw = blockScalar(rendered.stdout, "catalog.json");
  assert.ok(raw, "catalog.json is rendered");
  return JSON.parse(raw) as Record<string, unknown>;
}

test("gateway on: the launch catalog renders into the tenant-params ConfigMap the gateway mounts", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  const raw = blockScalar(rendered.stdout, "catalog.json");
  assert.ok(raw);
  // The gateway's own parser accepts exactly what the chart renders.
  const catalog = parseCatalog(JSON.parse(raw));
  assert.deepEqual(catalog.harnesses, ["opencode"]);
  assert.deepEqual(
    catalog.providers.map((provider) => [provider.id, provider.keyEnv]),
    [
      ["anthropic", "ANTHROPIC_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
      ["google", "GOOGLE_GENERATIVE_AI_API_KEY"],
      ["deepseek", "DEEPSEEK_API_KEY"],
    ],
  );
  assert.deepEqual(catalog.github?.keyEnv, ["GH_TOKEN", "GITHUB_TOKEN"]);
  assert.deepEqual(
    catalog.providers.filter((provider) => provider.validate.invalidReason !== null).map((provider) => [provider.id, provider.validate.invalidReason]),
    [["google", "API_KEY_INVALID"]],
  );
  // The only hosts a user's key is ever sent to.
  assert.deepEqual([...validationOrigins(catalog)].sort(), [
    "https://api.anthropic.com",
    "https://api.deepseek.com",
    "https://api.github.com",
    "https://api.openai.com",
    "https://generativelanguage.googleapis.com",
    "https://openrouter.ai",
  ]);

  const deployment = findDoc(rendered.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  assert.match(deployment, /name: FM_WT_CATALOG\n\s+value: "\/etc\/walkie-talkie\/tenant-params\/catalog\.json"/);
  assert.match(deployment, /name: tenant-params\n\s+configMap:\n\s+name: firstmate-tenant-params/);
  assert.match(deployment, /name: tenant-params\n\s+mountPath: \/etc\/walkie-talkie\/tenant-params\n\s+readOnly: true/);
  assert.match(deployment, /checksum\/tenant-params: [0-9a-f]{64}/);
  // The active vault key id comes from values; only the keyring is secret.
  assert.match(deployment, /name: FM_WT_VAULT_ACTIVE_KEY\n\s+value: "k1"/);
});

test("gateway off: the catalog renders nothing", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_OFF);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.doesNotMatch(rendered.stdout, /tenant-params|catalog\.json/);
});

test("a catalog change rolls the gateway", { skip: skipHelm }, () => {
  const catalog = launchCatalog();
  const providers = catalog.providers as Array<Record<string, unknown>>;
  const narrowed = { ...catalog, providers: providers.filter((provider) => provider.id === "anthropic") };
  const before = findDoc(render(GATEWAY_ON).stdout, "Deployment", "firstmate-gateway");
  const after = findDoc(render([...GATEWAY_ON, "-f", valuesFile({ tenants: { catalog: narrowed } })]).stdout, "Deployment", "firstmate-gateway");
  const checksum = (doc: string | null): string | undefined => /checksum\/tenant-params: (\S+)/.exec(doc ?? "")?.[1];
  assert.ok(checksum(before));
  assert.notEqual(checksum(before), checksum(after));
});

for (const [label, mutate, message] of [
  ["no providers", (c: Record<string, unknown>) => ({ ...c, providers: [] }), /at least one provider/],
  ["no harnesses", (c: Record<string, unknown>) => ({ ...c, harnesses: [] }), /at least one harness/],
  [
    "a duplicate provider id",
    (c: Record<string, unknown>) => {
      const providers = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [...providers, { ...providers[0], keyEnv: "OTHER_API_KEY" }] };
    },
    /declared twice/,
  ],
  [
    "a key name used twice",
    (c: Record<string, unknown>) => {
      const providers = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [...providers, { ...providers[0], id: "other" }] };
    },
    /used twice/,
  ],
  [
    "a GitHub key name that collides with a provider's",
    (c: Record<string, unknown>) => ({ ...c, github: { ...(c.github as object), keyEnv: ["OPENAI_API_KEY"] } }),
    /used twice/,
  ],
  [
    "a plain-http validation URL",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [{ ...first, validate: { url: "http://api.anthropic.com/v1/models", auth: "x-api-key" } }, ...rest] };
    },
    /https/,
  ],
  [
    "an unknown key header",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [{ ...first, validate: { url: "https://api.anthropic.com/v1/models", auth: "basic" } }, ...rest] };
    },
    /auth must be one of/,
  ],
  [
    "a reserved validation header",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return {
        ...c,
        providers: [{ ...first, validate: { url: "https://api.anthropic.com/v1/models", auth: "bearer", headers: { Host: "evil.example" } } }, ...rest],
      };
    },
    /not an allowed header/,
  ],
  [
    "a malformed invalid-key reason code",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [{ ...first, validate: { ...(first?.validate as object), invalidReason: "not a code" } }, ...rest] };
    },
    /invalidReason/,
  ],
  [
    "a provider without models",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [{ ...first, models: [] }, ...rest] };
    },
    /at least one model/,
  ],
  [
    "a key written into the catalog",
    (c: Record<string, unknown>) => {
      const [first, ...rest] = c.providers as Array<Record<string, unknown>>;
      return { ...c, providers: [{ ...first, apiKey: "sk-literal" }, ...rest] };
    },
    /never holds a key/,
  ],
] as const) {
  test(`a bad catalog fails the render: ${label}`, { skip: skipHelm }, () => {
    const file = valuesFile({ tenants: { catalog: mutate(launchCatalog()) } });
    const rendered = render([...GATEWAY_ON, "-f", file]);
    assert.notEqual(rendered.status, 0, `${label} rendered`);
    if (skipSchemaFlag) {
      // The template refuses it too, for renders that skip the schema.
      const unchecked = render([...GATEWAY_ON, "-f", file, "--skip-schema-validation"]);
      assert.notEqual(unchecked.status, 0, `${label} rendered without the schema`);
      assert.match(unchecked.stderr, message);
    }
  });
}

// ---------------------------------------------------------------------------
// Per-user firstmates (tenants.enabled)
// ---------------------------------------------------------------------------

/** The atus example with the gateway and per-user firstmates on. */
const TENANTS_ON = [...GATEWAY_ON, "--set", "tenants.enabled=true"];

const TENANT_OBJECTS = [
  "LimitRange/firstmate-tenants",
  "Namespace/firstmate-tenants",
  "NetworkPolicy/firstmate-tenants-default-deny",
  "NetworkPolicy/firstmate-tenants-egress",
  "NetworkPolicy/firstmate-tenants-from-gateway",
  "ResourceQuota/firstmate-tenants",
  "Role/firstmate-gateway",
  "RoleBinding/firstmate-gateway",
  "ServiceAccount/fm-tenant",
];

/**
 * The Role's rules as data, resource -> verbs. The chart writes each rule as
 * one `- apiGroups:` item whose fields are flow sequences, which are JSON.
 */
function roleRules(role: string): Record<string, string[]> {
  const items: Array<Record<string, unknown>> = [];
  for (const line of role.slice(role.indexOf("\nrules:\n") + "\nrules:\n".length).split("\n")) {
    const field = /^  (- |  )([A-Za-z]+): (.*)$/.exec(line);
    if (field === null) break;
    if (field[1] === "- ") items.push({});
    const item = items.at(-1);
    assert.ok(item, "a rule field outside a rule");
    item[field[2] ?? ""] = JSON.parse(field[3] ?? "");
  }
  const rules: Record<string, string[]> = {};
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ["apiGroups", "resources", "verbs"]);
    for (const resource of item.resources as string[]) rules[resource] = item.verbs as string[];
  }
  return rules;
}

test("tenants off: the gateway renders no tenant namespace, no Role and no API token", { skip: skipHelm }, () => {
  const rendered = render(GATEWAY_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  for (const object of TENANT_OBJECTS) assert.equal(inventory(rendered.stdout).includes(object), false, object);
  const deployment = findDoc(rendered.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.doesNotMatch(deployment, /FM_WT_TENANT_PARAMS|FM_WT_INTERNAL_PORT/);
  assert.equal(blockScalar(rendered.stdout, "tenants.json"), null);
});

test("tenants on: the tenant namespace, its isolation and the gateway's Role render, and nothing else changes", { skip: skipHelm }, () => {
  const off = render(GATEWAY_ON);
  const on = render(TENANTS_ON);
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(inventory(on.stdout), [...inventory(off.stdout), ...TENANT_OBJECTS].sort());
  // The captain's pod is still untouched.
  assert.equal(findDoc(on.stdout, "StatefulSet", "firstmate"), findDoc(off.stdout, "StatefulSet", "firstmate"));
  for (const object of TENANT_OBJECTS.filter((entry) => !entry.startsWith("Namespace/"))) {
    const [kind = "", name = ""] = object.split("/");
    assert.match(findDoc(on.stdout, kind, name) ?? "", /^  namespace: firstmate-tenants$/m, `${object} lives in the tenant namespace`);
  }

  const namespace = findDoc(on.stdout, "Namespace", "firstmate-tenants");
  assert.ok(namespace);
  for (const label of ["enforce", "audit", "warn"]) {
    assert.match(namespace, new RegExp(`pod-security\\.kubernetes\\.io/${label}: restricted`));
  }
  assert.match(namespace, /helm\.sh\/resource-policy: keep/);

  const account = findDoc(on.stdout, "ServiceAccount", "fm-tenant");
  assert.ok(account);
  assert.match(account, /automountServiceAccountToken: false/);

  const deployment = findDoc(on.stdout, "Deployment", "firstmate-gateway");
  assert.ok(deployment);
  assert.match(deployment, /automountServiceAccountToken: true/);
  assert.match(deployment, /name: FM_WT_TENANT_PARAMS\n\s+value: "\/etc\/walkie-talkie\/tenant-params\/tenants\.json"/);
  assert.match(deployment, /name: FM_WT_INTERNAL_PORT\n\s+value: "8788"/);
  assert.notEqual(
    /checksum\/tenant-params: (\S+)/.exec(deployment)?.[1],
    /checksum\/tenant-params: (\S+)/.exec(findDoc(off.stdout, "Deployment", "firstmate-gateway") ?? "")?.[1],
    "turning tenants on restarts the gateway onto its parameters",
  );
});

test("tenants on: the gateway's Role is exactly the reconciler's verbs, bound to the gateway only", { skip: skipHelm }, async () => {
  const { GATEWAY_ROLE } = await import("./fake-kube.js");
  const rendered = render(TENANTS_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  const role = findDoc(rendered.stdout, "Role", "firstmate-gateway");
  assert.ok(role);
  assert.deepEqual(roleRules(role), GATEWAY_ROLE);
  const binding = findDoc(rendered.stdout, "RoleBinding", "firstmate-gateway");
  assert.ok(binding);
  assert.match(binding, /roleRef:\n\s+apiGroup: rbac\.authorization\.k8s\.io\n\s+kind: Role\n\s+name: firstmate-gateway/);
  assert.match(binding, /subjects:\n\s+- kind: ServiceAccount\n\s+name: firstmate-gateway\n\s+namespace: firstmate$/);
  assert.doesNotMatch(rendered.stdout, /kind: ClusterRole/);
});

test("tenants on: the quota is maxTenants times one tenant pod, and the limit range sets defaults", { skip: skipHelm }, () => {
  const rendered = render(TENANTS_ON);
  assert.equal(rendered.status, 0, rendered.stderr);
  const quota = findDoc(rendered.stdout, "ResourceQuota", "firstmate-tenants");
  assert.ok(quota);
  // (250m + 50m) CPU, (512 + 64) MiB requested and (2048 + 256) MiB limited per pod; 10Gi each.
  assert.match(
    quota,
    /hard:\n\s+pods: "5"\n\s+requests\.cpu: "1500m"\n\s+requests\.memory: "2880Mi"\n\s+limits\.memory: "11520Mi"\n\s+requests\.storage: "51200Mi"\n\s+persistentvolumeclaims: "5"/,
  );
  const limits = findDoc(rendered.stdout, "LimitRange", "firstmate-tenants");
  assert.ok(limits);
  assert.match(limits, /type: Container\n\s+default:\n\s+memory: "256Mi"\n\s+defaultRequest:\n\s+cpu: "50m"\n\s+memory: "64Mi"\n\s+max:\n\s+memory: "2Gi"/);
  assert.match(limits, /type: PersistentVolumeClaim\n\s+max:\n\s+storage: "10Gi"/);

  const custom = render([
    ...TENANTS_ON,
    "-f",
    valuesFile({
      tenants: {
        maxTenants: 2,
        persistence: { size: "1Ti" },
        resources: {
          firstmate: { requests: { cpu: 1.5, memory: "1Gi" }, limits: { memory: "4Gi" } },
          init: { requests: { cpu: "2", memory: "16Mi" }, limits: { memory: "64Mi" } },
        },
      },
    }),
  ]);
  assert.equal(custom.status, 0, custom.stderr);
  // The init container's 2 CPUs outweigh the app containers' 1.55, so a pod counts 2000m.
  assert.match(
    findDoc(custom.stdout, "ResourceQuota", "firstmate-tenants") ?? "",
    /pods: "2"\n\s+requests\.cpu: "4000m"\n\s+requests\.memory: "2176Mi"\n\s+limits\.memory: "8704Mi"\n\s+requests\.storage: "2097152Mi"/,
  );
});

test("tenants on: tenants are default-deny, reachable only from the gateway, and reach only DNS, the gateway and the internet", { skip: skipHelm }, () => {
  const rendered = render([...TENANTS_ON, "--set", "tenants.networkPolicy.extraExcludeCidrs={198.18.0.0/15,fd00:10::/64}"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const deny = findDoc(rendered.stdout, "NetworkPolicy", "firstmate-tenants-default-deny");
  assert.ok(deny);
  assert.match(deny, /spec:\n\s+podSelector: \{\}\n\s+policyTypes:\n\s+- Ingress\n\s+- Egress/);

  const ingress = findDoc(rendered.stdout, "NetworkPolicy", "firstmate-tenants-from-gateway");
  assert.ok(ingress);
  assert.match(
    ingress,
    /- from:\n\s+- namespaceSelector:\n\s+matchLabels:\n\s+kubernetes\.io\/metadata\.name: firstmate\n\s+podSelector:\n\s+matchLabels:\n\s+app\.kubernetes\.io\/name: firstmate-gateway\n\s+app\.kubernetes\.io\/instance: firstmate\n\s+app\.kubernetes\.io\/component: gateway\n\s+ports:\n\s+- protocol: TCP\n\s+port: 8787$/,
  );

  const egress = findDoc(rendered.stdout, "NetworkPolicy", "firstmate-tenants-egress");
  assert.ok(egress);
  assert.match(egress, /kubernetes\.io\/metadata\.name: kube-system\n\s+podSelector:\n\s+matchLabels:\n\s+k8s-app: kube-dns\n\s+ports:\n\s+- protocol: UDP\n\s+port: 53\n\s+- protocol: TCP\n\s+port: 53/);
  assert.match(egress, /app\.kubernetes\.io\/component: gateway\n\s+ports:\n\s+- protocol: TCP\n\s+port: 8788\n/);
  const v4 = /cidr: 0\.0\.0\.0\/0\n\s+except:\n((?:\s+- \S+\n)+)/.exec(egress)?.[1] ?? "";
  for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "198.18.0.0/15"]) {
    assert.ok(v4.includes(`- ${cidr}\n`), `IPv4 egress excludes ${cidr}`);
  }
  assert.equal(v4.includes("fd00"), false);
  const v6 = /cidr: ::\/0\n\s+except:\n((?:\s+- \S+\n)+)/.exec(egress)?.[1] ?? "";
  for (const cidr of ["fc00::/7", "fe80::/10", "fd00:10::/64"]) assert.ok(v6.includes(`- ${cidr}\n`), `IPv6 egress excludes ${cidr}`);
  assert.match(egress, /ports:\n\s+- protocol: TCP\n\s+port: 443\n\s+- protocol: TCP\n\s+port: 80\n\s+- protocol: TCP\n\s+port: 22$/);

  // The gateway's internal port admits the tenant namespace only (phase 3's policy).
  assert.match(
    findDoc(rendered.stdout, "NetworkPolicy", "firstmate-gateway") ?? "",
    /kubernetes\.io\/metadata\.name: firstmate-tenants\n\s+ports:\n\s+- protocol: TCP\n\s+port: internal/,
  );
});

test("tenants on: the rendered tenant parameters are what the gateway's own parser accepts", { skip: skipHelm }, async () => {
  const { parseTenantParams } = await import("../src/tenant-params.js");
  const rendered = render([...TENANTS_ON, "--set", "tenants.persistence.storageClass=beta3"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const raw = blockScalar(rendered.stdout, "tenants.json");
  assert.ok(raw, "tenants.json is rendered");
  const params = parseTenantParams(JSON.parse(raw));
  assert.equal(params.namespace, "firstmate-tenants");
  assert.equal(params.maxTenants, 5);
  assert.equal(params.gatewayInternalUrl, "http://firstmate-gateway-internal.firstmate.svc:8788");
  assert.equal(params.home, "/home/firstmate");
  assert.equal(params.port, 8787);
  // The atus values pin the tenant runtime; the sidecar falls back to the gateway's image.
  assert.equal(params.images.firstmate.image, "shimpa/firstmate-runtime:b9c3cf045ff9");
  assert.equal(params.images.walkieTalkie.image, "shimpa/walkie-talkie:b9c3cf045ff9");
  assert.equal(params.harnessCommand, `OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode --prompt "$FM_PRIMARY_SESSION_START_PROMPT"`);
  assert.deepEqual(params.storage, { storageClass: "beta3", size: "10Gi" });
  assert.deepEqual(params.security, { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });

  const pinned = render([
    ...TENANTS_ON,
    "--set", "tenants.image.firstmate.tag=abc123def456",
    "--set", "tenants.image.walkieTalkie.repository=example/wt",
    "--set", "tenants.image.walkieTalkie.tag=fedcba654321",
  ]);
  const pinnedParams = parseTenantParams(JSON.parse(blockScalar(pinned.stdout, "tenants.json") ?? "{}"));
  assert.equal(pinnedParams.images.firstmate.image, "shimpa/firstmate-runtime:abc123def456");
  assert.equal(pinnedParams.images.walkieTalkie.image, "example/wt:fedcba654321");
});

for (const [label, args, message] of [
  ["without the gateway", ["--set", "tenants.enabled=true"], /tenants\.enabled requires gateway\.enabled/],
  ["without the gateway's network policies", [...TENANTS_ON, "--set", "gateway.networkPolicy.enabled=false"], /requires gateway\.networkPolicy\.enabled/],
  ["with a latest image", [...TENANTS_ON, "--set", "tenants.image.firstmate.tag=latest"], /immutable tag/],
  ["with a CPU the quota cannot add up", [...TENANTS_ON, "--set", "tenants.resources.firstmate.requests.cpu=1e3"], /must be millicores/],
  ["with memory in decimal units", [...TENANTS_ON, "--set", "tenants.resources.walkieTalkie.limits.memory=256M"], /must be in Mi, Gi or Ti/],
  ["without a memory request", [...TENANTS_ON, "--set", "tenants.resources.init.requests.memory=null"], /requests\.memory is required/],
] as const) {
  test(`tenants fail the render ${label}`, { skip: skipHelm }, () => {
    const rendered = render([...args]);
    assert.notEqual(rendered.status, 0, `${label} rendered`);
    assert.match(rendered.stderr, message);
  });
}

test("tenants on: the purge grace, node-local DNS and the gateway's rotation marker render as declared", { skip: skipHelm }, async () => {
  const { parseTenantParams } = await import("../src/tenant-params.js");
  const rendered = render([...TENANTS_ON, "--set", "tenants.purgeAfterDays=7"]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(parseTenantParams(JSON.parse(blockScalar(rendered.stdout, "tenants.json") ?? "{}")).purgeAfterDays, 7);

  // The atus example lets tenants resolve through kubespray's node-local DNS
  // cache, which sits in the link-local range the internet rule excludes.
  const egress = findDoc(rendered.stdout, "NetworkPolicy", "firstmate-tenants-egress");
  assert.ok(egress);
  assert.match(egress, /- to:\n\s+- ipBlock:\n\s+cidr: 169\.254\.25\.10\/32\n\s+ports:\n\s+- protocol: UDP\n\s+port: 53\n\s+- protocol: TCP\n\s+port: 53\n/);
  const plain = render([...TENANTS_ON, "--set", "tenants.networkPolicy.dns.extraCidrs=null"]);
  assert.doesNotMatch(findDoc(plain.stdout, "NetworkPolicy", "firstmate-tenants-egress") ?? "", /169\.254\.25\.10/);

  // A rotation marker restarts the gateway onto changed Doppler values; empty adds nothing.
  const deployment = (args: string[]): string => findDoc(render(args).stdout, "Deployment", "firstmate-gateway") ?? "";
  assert.doesNotMatch(deployment(TENANTS_ON), /secrets-rotation/);
  assert.match(deployment([...TENANTS_ON, "--set", "gateway.secrets.rotation=2026-10-06"]), /walkie-talkie\.atus\.hr\/secrets-rotation: "2026-10-06"/);
});

test("the default purge grace is 30 days and a negative one fails the render", { skip: skipHelm }, async () => {
  const { parseTenantParams } = await import("../src/tenant-params.js");
  const rendered = render(TENANTS_ON);
  assert.equal(parseTenantParams(JSON.parse(blockScalar(rendered.stdout, "tenants.json") ?? "{}")).purgeAfterDays, 30);
  assert.notEqual(render([...TENANTS_ON, "--set", "tenants.purgeAfterDays=-1"]).status, 0);
});
