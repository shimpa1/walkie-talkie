import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FAKE_BIN, getJson, startTestServer } from "./helpers.js";

const HERDR_BIN = join(FAKE_BIN, "herdr");

test("the sessions endpoints require the bearer token", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const list = await getJson(server.url, "/api/sessions");
    assert.equal(list.status, 401);
    const read = await getJson(server.url, "/api/sessions/w1:p1");
    assert.equal(read.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /api/sessions returns the fleet's live sessions", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const result = await getJson(server.url, "/api/sessions", "t");
    assert.equal(result.status, 200);
    const sessions = (result.body as { sessions: Array<{ id: string; kind: string; name: string }> }).sessions;
    assert.deepEqual(
      sessions.map((session) => [session.id, session.kind, session.name]),
      [
        ["w1:p1", "primary", "firstmate"],
        ["w3:p2", "secondmate", "2ndmate-infra"],
        ["w9:p9", "worker", "scout-extra"],
        ["w2:p2", "worker", "walkie-talkie-conversations-view"],
      ],
    );
  } finally {
    await server.close();
  }
});

test("GET /api/sessions/<id> returns that session's recent output", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const result = await getJson(server.url, "/api/sessions/w1:p1", "t");
    assert.equal(result.status, 200);
    const body = result.body as { id: string; output: string };
    assert.equal(body.id, "w1:p1");
    assert.match(body.output, /Conversations view is now wired/);
  } finally {
    await server.close();
  }
});

test("an option-like or path-like session id is rejected without a herdr call", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const option = await getJson(server.url, "/api/sessions/-rf", "t");
    assert.equal(option.status, 400);
    const traversal = await getJson(server.url, "/api/sessions/%2e%2e%2fetc", "t");
    assert.equal(traversal.status, 400);
  } finally {
    await server.close();
  }
});

test("an unknown pane is a 404 with herdr's own message", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const result = await getJson(server.url, "/api/sessions/missing", "t");
    assert.equal(result.status, 404);
    assert.match((result.body as { error: string }).error, /not found/);
  } finally {
    await server.close();
  }
});

test("an unreachable herdr is a 502, not a crash", async () => {
  const server = await startTestServer({ token: "t", herdrBin: "/nonexistent/herdr-xyz" });
  try {
    const result = await getJson(server.url, "/api/sessions", "t");
    assert.equal(result.status, 502);
    assert.match((result.body as { error: string }).error, /herdr/);
  } finally {
    await server.close();
  }
});
