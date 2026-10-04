import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, resolveConfig } from "../src/config.js";

const GATEWAY_ENV = {
  FM_WT_MODE: "gateway",
  FM_WT_PUBLIC_ORIGIN: "https://walkie-talkie.example",
  FM_WT_GITHUB_CLIENT_ID: "Iv1.abc123",
  FM_WT_GITHUB_CLIENT_SECRET: "client-secret",
  FM_WT_ADMINS: "20532068",
};

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-gwcfg-"));
}

test("standalone stays the default and still requires the shared token", () => {
  const config = resolveConfig({ env: { FM_WT_TOKEN: "t" }, cwd: emptyDir() });
  assert.equal(config.mode, "standalone");
  assert.equal(config.gateway, null);
  assert.throws(() => resolveConfig({ env: {}, cwd: emptyDir() }), /FM_WT_TOKEN is required/);
});

test("gateway mode needs no shared token and resolves its settings", () => {
  const dir = emptyDir();
  const config = resolveConfig({
    env: {
      ...GATEWAY_ENV,
      FM_WT_ADMINS: "20532068, 42,20532068",
      FM_WT_STATIC_TENANTS: JSON.stringify([
        { githubId: 20532068, upstream: "http://firstmate.firstmate.svc.cluster.local:8787", tokenEnv: "CAPTAIN_TOKEN" },
      ]),
      CAPTAIN_TOKEN: "upstream-token",
      FM_WT_TRUSTED_PROXY_HOPS: "1",
    },
    cwd: dir,
  });
  assert.equal(config.mode, "gateway");
  assert.equal(config.token, "");
  assert.deepEqual(config.gateway, {
    publicOrigin: "https://walkie-talkie.example",
    githubClientId: "Iv1.abc123",
    githubClientSecret: "client-secret",
    admins: [20532068, 42],
    staticTenants: [
      { githubId: 20532068, upstream: "http://firstmate.firstmate.svc.cluster.local:8787", token: "upstream-token" },
    ],
    dbPath: join(dir, "walkie-talkie.gateway.db"),
    legacyBearer: false,
    trustedProxyHops: 1,
  });
});

test("each required gateway setting is enforced", () => {
  for (const key of ["FM_WT_PUBLIC_ORIGIN", "FM_WT_GITHUB_CLIENT_ID", "FM_WT_GITHUB_CLIENT_SECRET", "FM_WT_ADMINS"] as const) {
    const env: Record<string, string> = { ...GATEWAY_ENV };
    delete env[key];
    assert.throws(() => resolveConfig({ env, cwd: emptyDir() }), ConfigError, `missing ${key}`);
  }
});

test("the client secret is read from the environment only, never the config file", () => {
  const dir = emptyDir();
  writeFileSync(
    join(dir, "walkie-talkie.config.json"),
    JSON.stringify({
      mode: "gateway",
      publicOrigin: "https://walkie-talkie.example",
      githubClientId: "Iv1.fromfile",
      githubClientSecret: "secret-in-a-file",
      admins: [7],
    }),
  );
  assert.throws(() => resolveConfig({ env: {}, cwd: dir }), /FM_WT_GITHUB_CLIENT_SECRET/);
  const config = resolveConfig({ env: { FM_WT_GITHUB_CLIENT_SECRET: "from-env" }, cwd: dir });
  assert.equal(config.gateway?.githubClientId, "Iv1.fromfile", "non-secret settings may come from the file");
  assert.equal(config.gateway?.githubClientSecret, "from-env");
  assert.deepEqual(config.gateway?.admins, [7]);
});

test("the public origin must be a bare https origin (http only on localhost)", () => {
  const bad = [
    "http://walkie-talkie.example",
    "https://walkie-talkie.example/app",
    "https://walkie-talkie.example/?x=1",
    "https://user:pw@walkie-talkie.example",
    "not a url",
  ];
  for (const origin of bad) {
    assert.throws(
      () => resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_PUBLIC_ORIGIN: origin }, cwd: emptyDir() }),
      ConfigError,
      origin,
    );
  }
  const local = resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_PUBLIC_ORIGIN: "http://localhost:8787/" }, cwd: emptyDir() });
  assert.equal(local.gateway?.publicOrigin, "http://localhost:8787");
});

test("admins must be GitHub numeric ids", () => {
  for (const admins of ["shimpa1", "0", "-3", "1.5", ""]) {
    assert.throws(
      () => resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_ADMINS: admins }, cwd: emptyDir() }),
      ConfigError,
      admins,
    );
  }
});

test("a static tenant needs a bare upstream origin and a token from a named environment variable", () => {
  const tenants = (value: unknown, extra: Record<string, string> = {}): (() => unknown) => () =>
    resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_STATIC_TENANTS: JSON.stringify(value), ...extra }, cwd: emptyDir() });

  assert.throws(tenants([{ githubId: 1, upstream: "http://fm:8787", tokenEnv: "MISSING" }]), /MISSING is empty/);
  assert.throws(tenants([{ githubId: 1, upstream: "http://fm:8787/api", tokenEnv: "T" }], { T: "x" }), /bare origin/);
  assert.throws(tenants([{ githubId: 1, upstream: "file:///etc/passwd", tokenEnv: "T" }], { T: "x" }), /http or https/);
  assert.throws(tenants([{ githubId: 1, upstream: "http://fm:8787", token: "inline" }]), /tokenEnv/);
  assert.throws(
    tenants(
      [
        { githubId: 1, upstream: "http://a:1", tokenEnv: "T" },
        { githubId: 1, upstream: "http://b:1", tokenEnv: "T" },
      ],
      { T: "x" },
    ),
    /declared twice/,
  );
  assert.throws(
    () => resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_STATIC_TENANTS: "{not json" }, cwd: emptyDir() }),
    /JSON array/,
  );
});

test("the legacy bearer bridge needs the shared token it keeps accepting", () => {
  assert.throws(
    () => resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_LEGACY_BEARER: "1" }, cwd: emptyDir() }),
    /FM_WT_LEGACY_BEARER needs FM_WT_TOKEN/,
  );
  const config = resolveConfig({
    env: { ...GATEWAY_ENV, FM_WT_LEGACY_BEARER: "true", FM_WT_TOKEN: "shared" },
    cwd: emptyDir(),
  });
  assert.equal(config.gateway?.legacyBearer, true);
  assert.equal(config.token, "shared");
});

test("an unknown mode and out-of-range proxy hops are configuration errors", () => {
  assert.throws(() => resolveConfig({ env: { FM_WT_MODE: "cluster", FM_WT_TOKEN: "t" }, cwd: emptyDir() }), ConfigError);
  assert.throws(
    () => resolveConfig({ env: { ...GATEWAY_ENV, FM_WT_TRUSTED_PROXY_HOPS: "9" }, cwd: emptyDir() }),
    /FM_WT_TRUSTED_PROXY_HOPS/,
  );
});
