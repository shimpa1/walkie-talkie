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
  const local = opencode.provider.local3090;
  assert.equal(local?.npm, "@ai-sdk/openai-compatible");
  assert.equal(local?.options?.baseURL, "http://10.4.0.20:8000/v1");
  assert.equal(local?.options?.apiKey, undefined);
  assert.equal(local?.models?.["qwen3.8-27b"]?.name, "Qwen3.8-27B (3090)");

  const dispatchRaw = blockScalar(rendered.stdout, "crew-dispatch.json");
  assert.ok(dispatchRaw, "crew-dispatch.json is rendered");
  const dispatch = JSON.parse(dispatchRaw) as {
    rules: { when: string; use: { harness: string; model?: string }[] }[];
    default: { harness: string; model?: string }[];
  };
  assert.equal(dispatch.default[0]?.harness, "opencode");
  assert.equal(dispatch.rules[0]?.use[0]?.model, "local3090/qwen3.8-27b");
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
      dispatch: { default: { harness: "opencode", model: "local3090/qwen3.8-27b" } },
    },
  });
  const rendered = render(["-f", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const dispatch = JSON.parse(blockScalar(rendered.stdout, "crew-dispatch.json") ?? "{}") as {
    default: { harness: string; model?: string };
  };
  assert.equal(dispatch.default.harness, "opencode");
  assert.equal(dispatch.default.model, "local3090/qwen3.8-27b");
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
