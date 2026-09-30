import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { ConversationStore } from "../src/conversation-store.js";
import { FAKE_BIN, getJson, startTestServer } from "./helpers.js";

const HERDR_BIN = join(FAKE_BIN, "herdr");

function stubStore(): ConversationStore {
  return {
    async readHistory(sessionId) {
      return {
        messages: [
          { id: "msg_1", role: "user", time: 1, text: `brief for ${sessionId}` },
          { id: "msg_2", role: "assistant", time: 2, text: "on it" },
        ],
        has_older: false,
        has_newer: false,
        oldest_cursor: "1:msg_1",
        newest_cursor: "2:msg_2",
      };
    },
  };
}

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
    const sessions = (result.body as {
      sessions: Array<{ id: string; kind: string; name: string; agent_session: string | null }>;
    }).sessions;
    assert.deepEqual(
      sessions.map((session) => [session.id, session.kind, session.name]),
      [
        ["w1:p1", "primary", "firstmate"],
        ["w3:p2", "secondmate", "2ndmate-infra"],
        ["w9:p9", "worker", "scout-extra"],
        ["w2:p2", "worker", "walkie-talkie-conversations-view"],
      ],
    );
    assert.equal(sessions[0]?.agent_session, "ses_primary");
    assert.equal(sessions.find((session) => session.id === "w9:p9")?.agent_session, null);
  } finally {
    await server.close();
  }
});

test("GET /api/sessions/<id> returns the full conversation from the agent store", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN, conversationStore: stubStore() });
  try {
    const result = await getJson(server.url, "/api/sessions/w1:p1", "t");
    assert.equal(result.status, 200);
    const body = result.body as {
      id: string;
      source: string;
      agent_session: string | null;
      messages: Array<{ role: string; text: string }>;
    };
    assert.equal(body.id, "w1:p1");
    assert.equal(body.source, "history");
    assert.equal(body.agent_session, "ses_primary");
    assert.deepEqual(
      body.messages.map((message) => [message.role, message.text]),
      [
        ["user", "brief for ses_primary"],
        ["assistant", "on it"],
      ],
    );
  } finally {
    await server.close();
  }
});

test("GET /api/sessions/<id> falls back to the terminal when the store is absent", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  try {
    const result = await getJson(server.url, "/api/sessions/w1:p1", "t");
    assert.equal(result.status, 200);
    const body = result.body as { source: string; agent_session: string | null; output: string };
    assert.equal(body.source, "terminal");
    assert.equal(body.agent_session, "ses_primary");
    assert.match(body.output, /Conversations view is now wired/);
  } finally {
    await server.close();
  }
});

test("a malformed history cursor is a 400 before any read", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN, conversationStore: stubStore() });
  try {
    const bad = await getJson(server.url, "/api/sessions/w1:p1?before=nope", "t");
    assert.equal(bad.status, 400);
    const both = await getJson(server.url, "/api/sessions/w1:p1?before=1:msg_1&after=2:msg_2", "t");
    assert.equal(both.status, 400);
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
