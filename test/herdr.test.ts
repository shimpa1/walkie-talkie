import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Herdr, HerdrError, isValidPaneId } from "../src/herdr.js";

function fakeHerdr(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-herdr-"));
  const file = join(dir, "herdr");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

function herdr(binPath: string, session = "firstmate"): Herdr {
  return new Herdr({ binPath, session, env: { ...process.env } });
}

test("listPanes parses herdr's pane array and drops panes without an id", async () => {
  const bin = fakeHerdr(
    `#!/usr/bin/env bash
printf '%s' '{"id":"cli:pane:list","result":{"panes":[
  {"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","agent":"opencode","agent_status":"working","terminal_title_stripped":"hello"},
  {"agent":"opencode"}]}}'
`,
  );
  const panes = await herdr(bin).listPanes();
  assert.deepEqual(panes, [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      tabId: "w1:t1",
      agent: "opencode",
      status: "working",
      title: "hello",
      cwd: null,
    },
  ]);
});

test("every read is scoped to the configured session with a trailing flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-herdr-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
printf '%s' '{"result":{"workspaces":[]}}'
`,
  );
  chmodSync(bin, 0o755);

  await herdr(bin, "firstmate").listWorkspaces();

  assert.equal(readFileSync(log, "utf8").trim(), "workspace list --session firstmate");
});

test("a herdr error reported on stderr becomes a coded HerdrError", async () => {
  const bin = fakeHerdr(
    `#!/usr/bin/env bash
printf '%s' '{"id":"cli:workspace:list","error":{"code":"server_not_running","message":"no herdr server"}}' >&2
exit 1
`,
  );
  await assert.rejects(herdr(bin).listWorkspaces(), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "server_not_running");
    assert.match(error.message, /no herdr server/);
    return true;
  });
});

test("a herdr error printed to stdout is surfaced too", async () => {
  const bin = fakeHerdr(
    `#!/usr/bin/env bash
printf '%s' '{"id":"cli:pane:list","error":{"code":"server_not_running","message":"no herdr server"}}'
`,
  );
  await assert.rejects(herdr(bin).listPanes(), HerdrError);
});

test("readPane returns plain terminal text unchanged", async () => {
  const bin = fakeHerdr(`#!/usr/bin/env bash\nprintf 'line one\\nline two\\n'\n`);
  assert.equal(await herdr(bin).readPane("w1:p1", 20), "line one\nline two\n");
});

test("readPane surfaces an unknown pane as a pane_not_found HerdrError", async () => {
  // Real herdr writes a pane error to stderr and exits non-zero.
  const bin = fakeHerdr(
    `#!/usr/bin/env bash\nprintf '%s' '{"id":"cli:pane:read","error":{"code":"pane_not_found","message":"pane w9:p9 not found"}}' >&2\nexit 1\n`,
  );
  await assert.rejects(herdr(bin).readPane("w9:p9", 20), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "pane_not_found");
    return true;
  });
});

test("readPane surfaces a non-JSON failure as a plain HerdrError", async () => {
  const bin = fakeHerdr(`#!/usr/bin/env bash\necho 'boom' >&2\nexit 9\n`);
  await assert.rejects(herdr(bin).readPane("w1:p1", 20), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, null);
    assert.match(error.message, /boom/);
    return true;
  });
});

test("a missing herdr executable is a HerdrError, not a crash", async () => {
  await assert.rejects(
    herdr("/nonexistent/herdr-xyz").listPanes(),
    HerdrError,
  );
});

test("the client refuses any non-read herdr command before spawning", async () => {
  const bin = fakeHerdr(`#!/usr/bin/env bash\nprintf 'ran'\n`);
  const client = herdr(bin) as unknown as { runRead: (args: string[]) => Promise<unknown> };
  await assert.rejects(client.runRead(["pane", "send-text", "w1:p1"]), HerdrError);
  await assert.rejects(client.runRead(["pane", "run", "w1:p1"]), HerdrError);
  await assert.rejects(client.runRead(["agent", "prompt", "w1:p1"]), HerdrError);
});

test("a malformed pane id is refused before spawning", async () => {
  const bin = fakeHerdr(`#!/usr/bin/env bash\nprintf 'should not run'\n`);
  await assert.rejects(herdr(bin).readPane("../etc/passwd", 20), HerdrError);
  await assert.rejects(herdr(bin).readPane("-rf", 20), HerdrError);
});

test("isValidPaneId accepts herdr pane ids and rejects option-like or path values", () => {
  assert.equal(isValidPaneId("w38:p1"), true);
  assert.equal(isValidPaneId("w1_p2-3:t4"), true);
  assert.equal(isValidPaneId("-rf"), false);
  assert.equal(isValidPaneId("a/b"), false);
  assert.equal(isValidPaneId(""), false);
  assert.equal(isValidPaneId("a".repeat(200)), false);
});
