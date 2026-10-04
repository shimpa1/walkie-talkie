import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activityOf,
  correctReadiness,
  CROSS_CONTAINER_BASIS,
  queueOf,
  WATCHER_BEACON_GRACE_SECONDS,
  type PrimaryPane,
} from "../src/firstmate-live.js";
import { FAKE_BIN, FIXTURES_DIR, getJson, startTestServer } from "./helpers.js";

/**
 * What `fm-inbox.sh ready` printed from the walkie-talkie container of the live
 * pod on 2026-10-04 while firstmate was draining notes: the lock holder (pid
 * 218, the primary opencode) lives in the firstmate container's process
 * namespace, so it reads stale and the wake consumer cannot be classified.
 */
const CROSS_CONTAINER_READY = {
  schema: "fm-primary-ready.v1",
  home: "home/firstmate",
  observed_at: "2026-10-04T05:57:50Z",
  lock: { state: "stale", pid: 218, live_harness: false },
  wake_consumer: { state: "unknown", reason: "supervision-model-unknown-for-home", beacon_age_seconds: 1 },
  posture: { state: "present" },
  can_receive: false,
};

const RUNNING_PRIMARY: PrimaryPane = { id: "w6:p1", agent: "opencode", status: "idle" };

function withReady(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...CROSS_CONTAINER_READY, ...patch };
}

test("a lock pid invisible from this container no longer reads as cannot-receive", () => {
  const corrected = correctReadiness(CROSS_CONTAINER_READY, RUNNING_PRIMARY) as Record<string, unknown>;
  assert.equal(corrected.can_receive, true);
  assert.equal(corrected.can_receive_basis, CROSS_CONTAINER_BASIS);
  // firstmate's own observations are kept as it reported them.
  assert.deepEqual(corrected.lock, CROSS_CONTAINER_READY.lock);
  assert.deepEqual(corrected.wake_consumer, CROSS_CONTAINER_READY.wake_consumer);
});

test("readiness stays false when the cross-container signals do not prove firstmate is up", () => {
  const cases: Array<[string, unknown, PrimaryPane | null | undefined]> = [
    ["herdr unreadable", CROSS_CONTAINER_READY, undefined],
    ["no primary pane", CROSS_CONTAINER_READY, null],
    ["no agent in the primary pane", CROSS_CONTAINER_READY, { ...RUNNING_PRIMARY, agent: null }],
    [
      "stale watcher beacon",
      withReady({
        wake_consumer: { ...CROSS_CONTAINER_READY.wake_consumer, beacon_age_seconds: WATCHER_BEACON_GRACE_SECONDS + 1 },
      }),
      RUNNING_PRIMARY,
    ],
    [
      "no watcher beacon",
      withReady({ wake_consumer: { ...CROSS_CONTAINER_READY.wake_consumer, beacon_age_seconds: null } }),
      RUNNING_PRIMARY,
    ],
    [
      "wake consumer down",
      withReady({ wake_consumer: { state: "down", reason: "stale-beacon", beacon_age_seconds: 1 } }),
      RUNNING_PRIMARY,
    ],
    ["no session lock", withReady({ lock: { state: "free", pid: null, live_harness: null } }), RUNNING_PRIMARY],
  ];
  for (const [name, ready, primary] of cases) {
    assert.equal(correctReadiness(ready, primary), ready, name);
  }
});

test("a document that already says can_receive true is never rewritten", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURES_DIR, "ready.json"), "utf8")) as unknown;
  assert.equal(correctReadiness(ready, { ...RUNNING_PRIMARY, agent: null }), ready);
});

test("activity comes from herdr's view of the primary pane", () => {
  assert.equal(activityOf(undefined), "unknown");
  assert.equal(activityOf(null), "not_running");
  assert.equal(activityOf({ ...RUNNING_PRIMARY, agent: null }), "not_running");
  assert.equal(activityOf({ ...RUNNING_PRIMARY, status: "working" }), "busy");
  assert.equal(activityOf(RUNNING_PRIMARY), "idle");
});

test("the queue counts unacknowledged notes and their oldest time", () => {
  assert.equal(queueOf(null), null);
  assert.deepEqual(queueOf({ pending: [] }), { queued: 0, oldest_queued_at: null });
  assert.deepEqual(
    queueOf({
      pending: [
        { id: "b", at: "2026-10-03T18:29:43Z", acknowledged: false },
        { id: "a", at: "2026-10-03T18:24:46Z", acknowledged: false },
        { id: "c", at: "2026-10-03T18:00:00Z", acknowledged: true },
      ],
    }),
    { queued: 2, oldest_queued_at: "2026-10-03T18:24:46Z" },
  );
});

/** A bin dir whose fake fm-inbox answers `ready` with the live cross-container document. */
function crossContainerBin(panes?: (raw: { result: { panes: Array<Record<string, unknown>> } }) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "reach-live-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const name of ["herdr", "fm-inbox.sh", "fm-bearings-snapshot.sh"]) {
    cpSync(join(FAKE_BIN, name), join(binDir, name));
    chmodSync(join(binDir, name), 0o755);
  }
  for (const name of ["receipts.json", "bearings.json", "herdr-workspaces.json", "herdr-tabs.json", "herdr-output.txt"]) {
    cpSync(join(FIXTURES_DIR, name), join(dir, name));
  }
  const rawPanes = JSON.parse(readFileSync(join(FIXTURES_DIR, "herdr-panes.json"), "utf8")) as {
    result: { panes: Array<Record<string, unknown>> };
  };
  panes?.(rawPanes);
  writeFileSync(join(dir, "herdr-panes.json"), JSON.stringify(rawPanes));
  writeFileSync(join(dir, "ready.json"), JSON.stringify(CROSS_CONTAINER_READY));
  return binDir;
}

test("GET /api/health reports can_receive true when only the lock pid is invisible", async () => {
  const binDir = crossContainerBin();
  const server = await startTestServer({ token: "t", binDir, herdrBin: join(binDir, "herdr") });
  try {
    const result = await getJson(server.url, "/api/health");
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.can_receive, true);
    assert.equal(body.can_receive_basis, CROSS_CONTAINER_BASIS);
  } finally {
    await server.close();
  }
});

test("GET /api/health keeps can_receive false when herdr sees no agent in the primary pane", async () => {
  const binDir = crossContainerBin((raw) => {
    delete raw.result.panes[0]!.agent;
  });
  const server = await startTestServer({ token: "t", binDir, herdrBin: join(binDir, "herdr") });
  try {
    const result = await getJson(server.url, "/api/health");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, CROSS_CONTAINER_READY);
  } finally {
    await server.close();
  }
});

test("GET /api/firstmate reports busy, receiving, and the queued note from real reads", async () => {
  const binDir = crossContainerBin();
  const server = await startTestServer({ token: "t", binDir, herdrBin: join(binDir, "herdr") });
  try {
    const unauthorized = await getJson(server.url, "/api/firstmate");
    assert.equal(unauthorized.status, 401);

    const result = await getJson(server.url, "/api/firstmate", "t");
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.schema, "walkie-talkie-firstmate.v1");
    assert.equal(body.activity, "busy");
    assert.deepEqual(body.primary, { id: "w1:p1", agent: "opencode", status: "working" });
    assert.equal(body.can_receive, true);
    assert.equal(body.watcher_beacon_age_seconds, 1);
    assert.deepEqual(body.queue, { queued: 1, oldest_queued_at: "2026-09-28T11:40:00Z" });
  } finally {
    await server.close();
  }
});

test("GET /api/firstmate degrades to unknown when herdr cannot be read", async () => {
  const server = await startTestServer({ token: "t", herdrBin: "/nonexistent/herdr" });
  try {
    const result = await getJson(server.url, "/api/firstmate", "t");
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.activity, "unknown");
    assert.equal(body.primary, null);
    // The fixture ready document is firstmate's own healthy answer.
    assert.equal(body.can_receive, true);
  } finally {
    await server.close();
  }
});
