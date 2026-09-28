import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Firstmate, FirstmateError } from "../src/firstmate.js";
import { startTestServer } from "./helpers.js";

function scriptDir(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-bin-"));
  const file = join(dir, "probe.sh");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

test("request input reaches the child as literal argv, never through a shell", async () => {
  const dir = scriptDir('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  const firstmate = new Firstmate({ binDir: dir, env: { ...process.env } });
  const sentinel = join(dir, "pwned");
  const injected = `$(touch ${sentinel}); touch ${sentinel}2`;

  const result = await firstmate.run("probe.sh", ["note", injected, "--json", "-"]);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.split("\n").slice(0, 4), ["note", injected, "--json", "-"]);
  assert.equal(existsSync(sentinel), false);
  assert.equal(existsSync(`${sentinel}2`), false);
});

test("a non-zero child exit is reported as a code, not thrown", async () => {
  const dir = scriptDir('#!/usr/bin/env bash\nif [ "$1" = "--fail" ]; then exit 7; fi\nprintf ok\n');
  const firstmate = new Firstmate({ binDir: dir, env: { ...process.env } });
  const result = await firstmate.run("probe.sh", ["--fail"]);
  assert.equal(result.code, 7);
});

test("a missing script is a FirstmateError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-bin-"));
  const firstmate = new Firstmate({ binDir: dir, env: { ...process.env } });
  await assert.rejects(() => firstmate.run("fm-inbox.sh", ["ready"]), FirstmateError);
});

test("a request id with shell metacharacters is rejected before any invocation", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const response = await fetch(`${server.url}/api/note`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", requestId: "bad;id $(touch x)" }),
    });
    assert.equal(response.status, 400);
    const notesDir = join(server.home, "state", "notes");
    assert.deepEqual(existsSync(notesDir) ? readdirSync(notesDir) : [], []);
  } finally {
    await server.close();
  }
});

test("a receipts cursor containing command substitution is passed literally and not executed", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const sentinel = join(server.home, "cursor-pwned");
    const response = await fetch(
      `${server.url}/api/receipts?after=${encodeURIComponent(`$(touch ${sentinel})`)}`,
      { headers: { authorization: "Bearer t" } },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { reply_cursor: string };
    assert.equal(body.reply_cursor, `$(touch ${sentinel})`);
    assert.equal(existsSync(sentinel), false);
  } finally {
    await server.close();
  }
});

test("the recorded argv for a note contains the request id as one argument", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    await fetch(`${server.url}/api/note`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "argv check", requestId: "req-argv" }),
    });
    const raw = readFileSync(join(server.home, "state", "argv.bin"));
    const args = raw.toString("utf8").split("\0").filter((part) => part.length > 0);
    assert.deepEqual(args, ["note", "--request-id", "req-argv", "--json", "-"]);
  } finally {
    await server.close();
  }
});
