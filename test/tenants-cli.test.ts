import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayStore } from "../src/gateway-store.js";
import { REDACTED, runTenantsCommand } from "../src/tenants-cli.js";
import { TenantTokens } from "../src/tenant-tokens.js";
import { REPO_ROOT } from "./helpers.js";
import { TENANT_MASTER, TENANT_PARAMS_DOC } from "./tenant-fixtures.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");

const CATALOG_DOC = {
  harnesses: [{ name: "opencode" }],
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      keyEnv: "ANTHROPIC_API_KEY",
      validate: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key" },
      models: ["claude-sonnet-5-5", "claude-haiku-4-5"],
    },
  ],
  github: { keyEnv: ["GH_TOKEN", "GITHUB_TOKEN"], validate: { url: "https://api.github.com/user", auth: "bearer" } },
};

interface Setup {
  dir: string;
  env: NodeJS.ProcessEnv;
  tids: { alice: string; bob: string; carol: string };
}

async function setup(): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "wt-tenants-cli-"));
  writeFileSync(join(dir, "tenants.json"), JSON.stringify(TENANT_PARAMS_DOC));
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(CATALOG_DOC));
  const store = GatewayStore.open(await import("node:sqlite"), join(dir, "gateway.db"));
  // Distinct creation times: tenants render oldest first.
  const started = (githubId: number, login: string, desired: "running" | "stopped" | "none", at: number): string => {
    const user = store.createUser(githubId, login, at);
    store.setModelChoice(user.id, { harness: "opencode", provider: "anthropic", model: "claude-sonnet-5-5", routineModel: "claude-haiku-4-5" }, at);
    const tid = store.ensureTenant(user.id, at).tid;
    store.setTenantDesired(user.id, desired, at);
    return tid;
  };
  const tids = {
    alice: started(4004, "alice", "running", NOW),
    bob: started(5005, "Bob", "stopped", NOW + 1),
    carol: started(6006, "carol", "none", NOW + 2),
  };
  store.close();
  return {
    dir,
    env: {
      FM_WT_GATEWAY_DB: join(dir, "gateway.db"),
      FM_WT_TENANT_PARAMS: join(dir, "tenants.json"),
      FM_WT_CATALOG: join(dir, "catalog.json"),
      FM_WT_CONFIG: join(dir, "none.json"),
    },
    tids,
  };
}

function capture(env: NodeJS.ProcessEnv, cwd: string): { io: Parameters<typeof runTenantsCommand>[1]; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { env, cwd, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

/** The JSON documents of `---`-separated render output, header comments dropped. */
function documents(output: string): Array<Record<string, any>> {
  return output
    .split(/^---$/m)
    .map((doc) => doc.replace(/^#.*$/gm, "").trim())
    .filter((doc) => doc.length > 0)
    .map((doc) => JSON.parse(doc) as Record<string, any>);
}

test("tenants render prints every started firstmate's objects, with the token Secret redacted", async () => {
  const s = await setup();
  const { io, out, err } = capture(s.env, s.dir);
  assert.equal(await runTenantsCommand(["render"], io), 0);
  const docs = documents(out.join("\n"));
  assert.deepEqual(
    docs.map((doc) => `${doc.kind}/${doc.metadata.name}`),
    [
      `Secret/fm-${s.tids.alice}-tokens`,
      `ConfigMap/fm-${s.tids.alice}-agents`,
      `Service/fm-${s.tids.alice}`,
      `StatefulSet/fm-${s.tids.alice}`,
      `Secret/fm-${s.tids.bob}-tokens`,
      `ConfigMap/fm-${s.tids.bob}-agents`,
      `Service/fm-${s.tids.bob}`,
      `StatefulSet/fm-${s.tids.bob}`,
    ],
  );
  assert.deepEqual(docs[0]?.data, { api: REDACTED, credentials: REDACTED });
  assert.equal(docs[3]?.spec.replicas, 1);
  assert.equal(docs[7]?.spec.replicas, 0);
  assert.match(String(docs[1]?.data["opencode.json"]), /"model": "anthropic\/claude-sonnet-5-5"/);
  assert.match(out.join("\n"), new RegExp(`# tenant ${s.tids.alice} \\(@alice\\): desired running, user active`));
  assert.ok(err.some((line) => line.includes(`tenant ${s.tids.carol} (@carol): not started`)));
  // Nothing derived from any master could be in the output: it was never given one.
  const tokens = new TenantTokens(TENANT_MASTER);
  assert.equal(out.join("\n").includes(tokens.apiToken(s.tids.alice)), false);
});

test("tenants render --user prints one user's firstmate, case-insensitively", async () => {
  const s = await setup();
  const { io, out } = capture(s.env, s.dir);
  assert.equal(await runTenantsCommand(["render", "--user", "@bob"], io), 0);
  const docs = documents(out.join("\n"));
  assert.equal(docs.length, 4);
  assert.ok(docs.every((doc) => doc.metadata.labels["walkie-talkie.atus.hr/tenant"] === s.tids.bob));

  const missing = capture(s.env, s.dir);
  assert.equal(await runTenantsCommand(["render", "--user", "nobody"], missing.io), 1);
  assert.match(missing.err.join("\n"), /@nobody has no managed firstmate/);
});

test("tenants render says what is applied for a firstmate whose choice left the catalog", async () => {
  const s = await setup();
  const store = GatewayStore.open(await import("node:sqlite"), s.env.FM_WT_GATEWAY_DB ?? "");
  for (const owner of store.listTenants()) {
    store.setModelChoice(owner.userId, { harness: "opencode", provider: "retired", model: "gone", routineModel: null }, NOW);
  }
  store.close();
  const unresolved = capture(s.env, s.dir);
  assert.equal(await runTenantsCommand(["render"], unresolved.io), 0);
  assert.deepEqual(unresolved.out, []);
  assert.ok(unresolved.err.includes(`tenant ${s.tids.alice} (@alice): its model choice is not in the catalog; nothing is applied`));
  assert.ok(
    unresolved.err.includes(
      `tenant ${s.tids.bob} (@Bob): its model choice is not in the catalog; its StatefulSet is scaled to zero, nothing else is applied`,
    ),
  );
});

test("tenants render refuses bad usage and missing settings, and runs from the real entrypoint", async () => {
  const s = await setup();
  assert.equal(await runTenantsCommand(["apply"], capture(s.env, s.dir).io), 2);
  assert.equal(await runTenantsCommand(["render", "--user"], capture(s.env, s.dir).io), 2);
  const noParams = capture({ ...s.env, FM_WT_TENANT_PARAMS: "" }, s.dir);
  assert.equal(await runTenantsCommand(["render"], noParams.io), 1);
  assert.match(noParams.err.join("\n"), /needs FM_WT_TENANT_PARAMS and FM_WT_CATALOG/);
  const noStore = capture({ ...s.env, FM_WT_GATEWAY_DB: join(s.dir, "absent.db") }, s.dir);
  assert.equal(await runTenantsCommand(["render"], noStore.io), 1);
  assert.match(noStore.err.join("\n"), /no gateway store/);

  const run = spawnSync(process.execPath, [join(REPO_ROOT, "dist", "src", "index.js"), "tenants", "render", "--user", "alice"], {
    env: { ...process.env, ...s.env },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(documents(run.stdout).length, 4);
});
