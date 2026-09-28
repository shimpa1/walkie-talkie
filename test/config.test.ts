import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, bindRefusal, isLoopbackHost, resolveConfig } from "../src/config.js";

test("a missing token is a configuration error", () => {
  assert.throws(() => resolveConfig({ env: {}, cwd: tmpdir() }), ConfigError);
});

test("the gitignored config file supplies values", () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-cfg-"));
  writeFileSync(
    join(dir, "walkie-talkie.config.json"),
    JSON.stringify({ fmHome: "/srv/firstmate", host: "127.0.0.1", port: 9001, token: "from-file" }),
  );
  const config = resolveConfig({ env: {}, cwd: dir });
  assert.equal(config.fmHome, "/srv/firstmate");
  assert.equal(config.fmBin, "/srv/firstmate/bin");
  assert.equal(config.port, 9001);
  assert.equal(config.token, "from-file");
});

test("environment variables override the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-cfg-"));
  writeFileSync(
    join(dir, "walkie-talkie.config.json"),
    JSON.stringify({ fmHome: "/from/file", port: 1, token: "file-token" }),
  );
  const config = resolveConfig({
    env: { FM_HOME: "/from/env", FM_WT_PORT: "7777", FM_WT_TOKEN: "env-token" },
    cwd: dir,
  });
  assert.equal(config.fmHome, "/from/env");
  assert.equal(config.fmBin, "/from/env/bin");
  assert.equal(config.port, 7777);
  assert.equal(config.token, "env-token");
});

test("a public bind is refused unless explicitly overridden", () => {
  const base = resolveConfig({ env: { FM_WT_TOKEN: "t", FM_WT_HOST: "0.0.0.0" }, cwd: tmpdir() });
  assert.notEqual(bindRefusal(base), null);

  const overridden = resolveConfig({
    env: { FM_WT_TOKEN: "t", FM_WT_HOST: "0.0.0.0", FM_WT_ALLOW_PUBLIC_BIND: "1" },
    cwd: tmpdir(),
  });
  assert.equal(bindRefusal(overridden), null);

  const loopback = resolveConfig({ env: { FM_WT_TOKEN: "t" }, cwd: tmpdir() });
  assert.equal(bindRefusal(loopback), null);
});

test("loopback detection covers the usual spellings", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("100.64.0.5"), false);
});
