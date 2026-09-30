import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Conversations,
  DEFAULT_CONVERSATION_LINES,
  MAX_CONVERSATION_LINES,
  buildSessions,
  clampLines,
} from "../src/conversations.js";
import type { HerdrClient, HerdrPane, HerdrTab, HerdrWorkspace } from "../src/herdr.js";

function pane(overrides: Partial<HerdrPane> = {}): HerdrPane {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    tabId: "w1:t1",
    agent: "opencode",
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
  pane({ paneId: "w9:p9", workspaceId: "w1", tabId: "w9:t1", agent: null, status: null }),
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
      ["w2:p2", "worker", "walkie-talkie-conversations-view"],
    ],
  );
});

test("buildSessions drops panes without a registered agent", () => {
  const ids = buildSessions(PANES, WORKSPACES, TABS).map((session) => session.id);
  assert.equal(ids.includes("w9:p9"), false);
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
  assert.equal(result.sessions.length, 3);
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
  assert.equal(result.sessions.length, 3);
});

test("Conversations.read returns the pane output and echoes the line count", async () => {
  const client = stubHerdr();
  const result = await new Conversations(client).read("w1:p1", 50);
  assert.deepEqual(result, { id: "w1:p1", lines: 50, output: "output for w1:p1\n" });
  assert.deepEqual(client.readCalls, [["w1:p1", 50]]);
});
