import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The atus example with the gateway switched on, as the enable PR would. */
const GATEWAY_ON = ["-f", VALUES_ATUS, "--set", "gateway.enabled=true", "--set", "gateway.githubClientId=Ov23liExample", ...FIXED_TOKEN];

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
  const rendered = render(["-f", VALUES_ATUS, ...FIXED_TOKEN]);
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
  const off = render(["-f", VALUES_ATUS, ...FIXED_TOKEN]);
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

test("gateway on without admins fails the render", { skip: skipHelm }, () => {
  const rendered = render([...GATEWAY_ON, "-f", valuesFile({ gateway: { admins: [] } })]);
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /requires at least one admin GitHub numeric id in gateway\.admins/);
});

test("gateway on without the OAuth client id fails the render", { skip: skipHelm }, () => {
  const rendered = render(["-f", VALUES_ATUS, "--set", "gateway.enabled=true", ...FIXED_TOKEN]);
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
