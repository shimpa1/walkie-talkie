import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Conversations,
  DEFAULT_CONVERSATION_LINES,
  MAX_CONVERSATION_LINES,
  buildSessions,
  clampLines,
} from "../src/conversations.js";
import type { ConversationStore } from "../src/conversation-store.js";
import type { HerdrClient, HerdrPane, HerdrTab, HerdrWorkspace } from "../src/herdr.js";

function pane(overrides: Partial<HerdrPane> = {}): HerdrPane {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    agent: "opencode",
    agentSession: "ses_test",
    status: "working",
    title: "title",
    cwd: "/home/firstmate",
    ...overrides,
  };
}

const PANES: HerdrPane[] = [
  pane({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" }),
  pane({ paneId: "w2:p2", workspaceId: "w2", tabId: "w2:t2" }),
  pane({ paneId: "w3:p2", workspaceId: "w3", tabId: "w3:t2" }),
  // A plain shell pane is not a conversation.
  pane({ paneId: "w9:p9", workspaceId: "w1", tabId: "w9:t1", agent: null, agentSession: null, status: null }),
];

const WORKSPACES: HerdrWorkspace[] = [
  { workspaceId: "w1", label: "firstmate" },
  { workspaceId: "w2", label: "└ walkie-talkie-conversations-view · p:anY9nwYcIimzRZcIQXu98w" },
  { workspaceId: "w3", label: "2ndmate-infra" },
];

const TABS: HerdrTab[] = [
  { tabId: "w1:t1", workspaceId: "w1", label: "firstmate" },
  { tabId: "w2:t2", workspaceId: "w2", label: "fm-walkie-talkie-conversations-view" },
  { tabId: "w3:t2", workspaceId: "w3", label: "fm-2ndmate-infra" },
  { tabId: "w9:t1", workspaceId: "w1", label: "fm-scout-extra" },
];

test("buildSessions classifies the primary, secondmate, and worker and sorts them", () => {
  const sessions = buildSessions(PANES, WORKSPACES, TABS);
  assert.deepEqual(
    sessions.map((session) => [session.id, session.kind, session.name]),
    [
      ["w1:p1", "primary", "firstmate"],
      ["w3:p2", "secondmate", "2ndmate-infra"],
      ["w9:p9", "worker", "scout-extra"],
      ["w2:p2", "worker", "walkie-talkie-conversations-view"],
    ],
  );
});

test("buildSessions lists a pane with no registered agent as unknown status", () => {
  const session = buildSessions(PANES, WORKSPACES, TABS).find((item) => item.id === "w9:p9");
  assert.equal(session?.agent, null);
  assert.equal(session?.status, "unknown");
});

test("a task tab inside the primary workspace is a worker, not the primary", () => {
  const sessions = buildSessions(
    [pane({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2" })],
    [{ workspaceId: "w1", label: "firstmate" }],
    [{ tabId: "w1:t2", workspaceId: "w1", label: "fm-fix-the-thing" }],
  );
  assert.equal(sessions[0]?.kind, "worker");
  assert.equal(sessions[0]?.name, "fix-the-thing");
});

test("clampLines defaults, bounds, and passes through a valid count", () => {
  assert.equal(clampLines(null), DEFAULT_CONVERSATION_LINES);
  assert.equal(clampLines("soon"), DEFAULT_CONVERSATION_LINES);
  assert.equal(clampLines("0"), 1);
  assert.equal(clampLines("999999"), MAX_CONVERSATION_LINES);
  assert.equal(clampLines("120"), 120);
});

function stubHerdr(): HerdrClient & { readCalls: Array<[string, number]> } {
  const readCalls: Array<[string, number]> = [];
  return {
    readCalls,
    listPanes: async () => PANES,
    listWorkspaces: async () => WORKSPACES,
    listTabs: async () => TABS,
    readPane: async (paneId: string, lines: number) => {
      readCalls.push([paneId, lines]);
      return `output for ${paneId}\n`;
    },
  };
}

test("Conversations.list joins the herdr reads into a session list", async () => {
  const result = await new Conversations(stubHerdr()).list();
  assert.equal(result.sessions.length, 4);
  assert.equal(result.sessions[0]?.id, "w1:p1");
});

test("Conversations.list still lists panes when the label reads fail", async () => {
  const client: HerdrClient = {
    listPanes: async () => PANES,
    listWorkspaces: async () => {
      throw new Error("workspace read failed");
    },
    listTabs: async () => {
      throw new Error("tab read failed");
    },
    readPane: async () => "",
  };
  const result = await new Conversations(client).list();
  assert.equal(result.sessions.length, 4);
});

function stubStore(): ConversationStore & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    readHistory: async (sessionId: string, query: unknown) => {
      calls.push([sessionId, query]);
      return {
        messages: [{ id: "msg_1", role: "user", time: 1, text: "hello" }],
        has_older: false,
        oldest_cursor: "1:msg_1",
      };
    },
  };
}

test("buildSessions carries each pane's agent session id", () => {
  const sessions = buildSessions([pane({ paneId: "w1:p1", agentSession: "ses_x" })], WORKSPACES, TABS);
  assert.equal(sessions[0]?.agent_session, "ses_x");
});

test("Conversations.history reads the agent store for the pane's session", async () => {
  const store = stubStore();
  const conversations = new Conversations(stubHerdr(), store);
  await conversations.list();
  const result = await conversations.history("w1:p1", { limit: 10 });
  assert.deepEqual(store.calls, [["ses_test", { limit: 10, before: null }]]);
  assert.equal(result.source, "history");
  if (result.source === "history") {
    assert.equal(result.agent_session, "ses_test");
    assert.deepEqual(result.messages.map((message) => message.text), ["hello"]);
  }
});

test("Conversations.history falls back to the terminal when the store is absent", async () => {
  const client = stubHerdr();
  const result = await new Conversations(client, null).history("w1:p1", { lines: 20 });
  assert.equal(result.source, "terminal");
  if (result.source === "terminal") {
    assert.equal(result.agent_session, "ses_test");
    assert.equal(result.output, "output for w1:p1\n");
    assert.deepEqual(client.readCalls, [["w1:p1", 20]]);
  }
});

test("Conversations.history falls back to the terminal when the store has no session", async () => {
  const client = stubHerdr();
  const store: ConversationStore = { readHistory: async () => null };
  const result = await new Conversations(client, store).history("w1:p1");
  assert.equal(result.source, "terminal");
});

test("Conversations.history falls back to the terminal for a pane with no agent session", async () => {
  const client = stubHerdr();
  const store = stubStore();
  const conversations = new Conversations(client, store);
  await conversations.list();
  const result = await conversations.history("w9:p9");
  assert.equal(result.source, "terminal");
  assert.equal(result.agent_session, null);
  assert.deepEqual(store.calls, []);
});
