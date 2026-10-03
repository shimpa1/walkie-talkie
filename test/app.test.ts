import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { OpencodeStore } from "../src/conversation-store.js";
import { FM_SCRIPTS, type FirstmateClient, type RunResult } from "../src/firstmate.js";
import { FAKE_BIN, FIXTURES_DIR, REPO_ROOT, startTestServer } from "./helpers.js";

const HERDR_BIN = join(FAKE_BIN, "herdr");

const nativeFetch = globalThis.fetch;

interface TokenStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

class MemoryStorage implements TokenStorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface FakeElement {
  id: string;
  className: string;
  textContent: string;
  value: string;
  placeholder: string;
  hidden: boolean;
  dataset: Record<string, string>;
  classList: { toggle: () => void; add: () => void; remove: () => void };
  setAttribute: () => void;
  appendChild: (child: unknown) => unknown;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  dispatch: (type: string, event?: unknown) => void;
}

function makeElement(id: string): FakeElement {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    id,
    className: "",
    textContent: "",
    value: "",
    placeholder: "",
    hidden: false,
    dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    setAttribute: () => {},
    appendChild: (child) => child,
    addEventListener: (type, handler) => {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch: (type, event) => {
      for (const handler of listeners.get(type) ?? []) handler(event ?? {});
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for app state");
}

async function loadTokenMessages(): Promise<{ TOKEN_KEY: string; UNAUTHORIZED_MESSAGE: string }> {
  return (await import(pathToFileURL(join(REPO_ROOT, "public", "token.js")).href)) as {
    TOKEN_KEY: string;
    UNAUTHORIZED_MESSAGE: string;
  };
}

interface AppHarness {
  getElement: (id: string) => FakeElement;
  tokenInput: FakeElement;
  settingsStatus: FakeElement;
  created: FakeElement[];
}

let bootCount = 0;

async function bootApp(
  storage: MemoryStorage,
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  search = "",
  windowExtras: Record<string, unknown> = {},
): Promise<AppHarness> {
  bootCount += 1;
  const elements = new Map<string, FakeElement>();
  const created: FakeElement[] = [];
  const getElement = (id: string): FakeElement => {
    let element = elements.get(id);
    if (!element) {
      element = makeElement(id);
      elements.set(id, element);
    }
    return element;
  };
  const tabs = ["status", "conversations", "settings"].map((view) => {
    const tab = makeElement(`tab-${view}`);
    tab.dataset.view = view;
    return tab;
  });
  const views = ["status", "conversations", "settings"].map((view) => makeElement(`view-${view}`));

  const globals: Array<[string, unknown]> = [
    ["localStorage", storage],
    [
      "document",
      {
        getElementById: getElement,
        createElement: (tag: string) => {
          const element = makeElement(tag);
          created.push(element);
          return element;
        },
        createTextNode: (text: string) => ({ textContent: String(text) }),
        querySelectorAll: (selector: string) => {
          if (selector === ".tab") return tabs;
          if (selector === ".view") return views;
          return [];
        },
      },
    ],
    ["window", { location: { origin: "http://localhost", search }, ...windowExtras }],
    ["navigator", {}],
    ["fetch", fetchImpl],
    // The conversation view's polling is exercised through its Refresh button,
    // so interval timers are inert here to keep the test deterministic.
    ["setInterval", () => 0],
    ["clearInterval", () => {}],
  ];
  for (const [name, value] of globals) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  await import(`${pathToFileURL(join(REPO_ROOT, "public", "app.js")).href}?boot=${bootCount}`);

  return {
    getElement,
    tokenInput: getElement("token-input"),
    settingsStatus: getElement("settings-status"),
    created,
  };
}

test("a 401 clears the stored token and field so the captain re-enters the real one", async () => {
  const { TOKEN_KEY, UNAUTHORIZED_MESSAGE } = await loadTokenMessages();

  const server = await startTestServer({ token: "s3cr3t" });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "s3cr3t%");

  try {
    const { getElement, tokenInput, settingsStatus } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
    );

    await waitFor(() => settingsStatus.textContent === UNAUTHORIZED_MESSAGE);

    assert.equal(storage.getItem(TOKEN_KEY), null);
    assert.equal(tokenInput.value, "");
    assert.equal(settingsStatus.textContent, UNAUTHORIZED_MESSAGE);

    tokenInput.value = "s3cr3t";
    getElement("settings-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => settingsStatus.textContent.startsWith("Token accepted"));

    assert.equal(storage.getItem(TOKEN_KEY), "s3cr3t");
    assert.match(settingsStatus.textContent, /Token accepted/);
  } finally {
    await server.close();
  }
});

test("a stale 401 leaves a newer token the captain is still entering", async () => {
  const { TOKEN_KEY, UNAUTHORIZED_MESSAGE } = await loadTokenMessages();

  const server = await startTestServer({ token: "s3cr3t" });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "s3cr3t%");

  let releaseStatus: () => void = () => {};
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let statusStarted = false;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/api/status" && !statusStarted) {
      statusStarted = true;
      await statusGate;
    }
    return nativeFetch(server.url + path, init);
  };

  try {
    const { getElement, tokenInput, settingsStatus } = await bootApp(storage, fetchImpl);

    await waitFor(() => statusStarted);
    tokenInput.value = "s3cr3t";
    releaseStatus();

    await waitFor(() => settingsStatus.textContent.startsWith(UNAUTHORIZED_MESSAGE));

    assert.equal(tokenInput.value, "s3cr3t");
    assert.equal(storage.getItem(TOKEN_KEY), "s3cr3t%");

    getElement("settings-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => settingsStatus.textContent.startsWith("Token accepted"));

    assert.equal(storage.getItem(TOKEN_KEY), "s3cr3t");
    assert.equal(tokenInput.value, "s3cr3t");
  } finally {
    await server.close();
  }
});

function seedHistoryStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY);
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare("INSERT INTO session (id) VALUES (?)").run("ses_primary");
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "msg_1",
    "ses_primary",
    1000,
    JSON.stringify({ role: "assistant" }),
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
    "msg_1_p0",
    "msg_1",
    "ses_primary",
    1000,
    JSON.stringify({ type: "text", text: "partial" }),
  );
  db.close();
}

test("a history refresh applies a message's grown text without reselecting", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const dir = mkdtempSync(join(tmpdir(), "reach-app-history-"));
  const dbPath = join(dir, "opencode.db");
  seedHistoryStore(dbPath);

  const server = await startTestServer({
    token: "t",
    herdrBin: HERDR_BIN,
    conversationStore: new OpencodeStore({ dbPath }),
  });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement, created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card" && element.dataset.id === "w1:p1"),
    );
    const card = created.find(
      (element) => element.className === "session-card" && element.dataset.id === "w1:p1",
    );
    assert.ok(card);
    card.dispatch("click");

    await waitFor(() =>
      created.some((element) => element.className === "msg-text" && element.textContent === "partial"),
    );

    const writer = new DatabaseSync(dbPath);
    writer
      .prepare("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify({ type: "text", text: "partial and complete" }), "msg_1_p0");
    writer.close();

    getElement("conversations-refresh").dispatch("click");

    await waitFor(() =>
      created.some(
        (element) => element.className === "msg-text" && element.textContent === "partial and complete",
      ),
    );
  } finally {
    await server.close();
  }
});

function seedTwoSessionStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY);
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
  `);
  const insertSession = db.prepare("INSERT INTO session (id) VALUES (?)");
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );
  insertSession.run("ses_primary");
  insertSession.run("ses_restarted");
  insertMessage.run("msg_old", "ses_primary", 1000, JSON.stringify({ role: "assistant" }));
  insertPart.run(
    "msg_old_p0",
    "msg_old",
    "ses_primary",
    1000,
    JSON.stringify({ type: "text", text: "old session" }),
  );
  insertMessage.run("msg_new", "ses_restarted", 2000, JSON.stringify({ role: "assistant" }));
  insertPart.run(
    "msg_new_p0",
    "msg_new",
    "ses_restarted",
    2000,
    JSON.stringify({ type: "text", text: "new session" }),
  );
  db.close();
}

test("a history poll replaces the view when the pane's agent session changes", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const dir = mkdtempSync(join(tmpdir(), "reach-app-session-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(join(FAKE_BIN, "herdr"), join(binDir, "herdr"));
  chmodSync(join(binDir, "herdr"), 0o755);
  for (const name of ["herdr-workspaces.json", "herdr-tabs.json", "herdr-output.txt", "herdr-panes.json"]) {
    cpSync(join(FIXTURES_DIR, name), join(dir, name));
  }
  const panesPath = join(dir, "herdr-panes.json");
  const dbPath = join(dir, "opencode.db");
  seedTwoSessionStore(dbPath);

  const server = await startTestServer({
    token: "t",
    herdrBin: join(binDir, "herdr"),
    conversationStore: new OpencodeStore({ dbPath }),
  });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement, created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card" && element.dataset.id === "w1:p1"),
    );
    const card = created.find(
      (element) => element.className === "session-card" && element.dataset.id === "w1:p1",
    );
    assert.ok(card);
    card.dispatch("click");

    await waitFor(() =>
      created.some(
        (element) => element.className === "msg-text" && element.textContent === "old session",
      ),
    );

    const before = created.length;
    const panes = JSON.parse(readFileSync(panesPath, "utf8")) as {
      result: { panes: Array<{ pane_id: string; agent_session: unknown }> };
    };
    const pane = panes.result.panes.find((entry) => entry.pane_id === "w1:p1");
    assert.ok(pane);
    pane.agent_session = {
      agent: "opencode",
      kind: "id",
      source: "herdr:opencode",
      value: "ses_restarted",
    };
    writeFileSync(panesPath, JSON.stringify(panes));

    const primed = await nativeFetch(server.url + "/api/sessions", {
      headers: { authorization: "Bearer t" },
    });
    assert.equal(primed.status, 200);
    getElement("conversations-refresh").dispatch("click");

    await waitFor(() =>
      created
        .slice(before)
        .some((element) => element.className === "msg-text" && element.textContent === "new session"),
    );
    const renderedSessionText = created
      .slice(before)
      .filter((element) => element.className === "msg-text")
      .map((element) => element.textContent);
    assert.ok(
      !renderedSessionText.includes("old session"),
      "the previous agent session's messages must not be merged into the new session",
    );
  } finally {
    await server.close();
  }
});

function seedEmptyHistoryStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY);
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare("INSERT INTO session (id) VALUES (?)").run("ses_primary");
  db.close();
}

function appendHistoryMessages(dbPath: string, sessionId: string, count: number): void {
  const db = new DatabaseSync(dbPath);
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );
  for (let index = 0; index < count; index += 1) {
    const id = `msg_${String(index).padStart(3, "0")}`;
    insertMessage.run(id, sessionId, 1000 + index, JSON.stringify({ role: "assistant" }));
    insertPart.run(
      `${id}_p0`,
      id,
      sessionId,
      1000 + index,
      JSON.stringify({ type: "text", text: `message ${index}` }),
    );
  }
  db.close();
}

test("a history poll adopts has_older so messages beyond the latest window stay reachable", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const dir = mkdtempSync(join(tmpdir(), "reach-app-has-older-"));
  const dbPath = join(dir, "opencode.db");
  seedEmptyHistoryStore(dbPath);

  const server = await startTestServer({
    token: "t",
    herdrBin: HERDR_BIN,
    conversationStore: new OpencodeStore({ dbPath }),
  });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement, created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card" && element.dataset.id === "w1:p1"),
    );
    const card = created.find(
      (element) => element.className === "session-card" && element.dataset.id === "w1:p1",
    );
    assert.ok(card);
    card.dispatch("click");

    await waitFor(() =>
      created.some(
        (element) =>
          element.className === "hint" && element.textContent === "No conversation messages yet.",
      ),
    );
    assert.ok(
      !created.some((element) => element.className.includes("load-older")),
      "no older-messages button before older messages exist",
    );

    appendHistoryMessages(dbPath, "ses_primary", 201);

    getElement("conversations-refresh").dispatch("click");

    await waitFor(() => created.some((element) => element.className.includes("load-older")));
  } finally {
    await server.close();
  }
});

test("the Conversations tab lists instruction threads with their delivery state and time", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card thread-card" && element.dataset.id === "note-1"),
    );
    const subs = created.filter((element) => element.className === "sub").map((element) => element.textContent);
    assert.ok(subs.some((text) => text.includes("Queued; waiting for firstmate.")));
    assert.ok(subs.some((text) => text.includes("Delivered; firstmate replied.")));
    // A thread row carries its own timestamp.
    assert.ok(
      created.some(
        (element) => element.className === "session-card thread-card" && element.dataset.id === "note-0",
      ),
    );
    const deliverySubs = subs.filter((text) => text.includes("Delivered;") || text.includes("Queued;"));
    assert.ok(deliverySubs.some((text) => /\d/.test(text)), "thread delivery lines carry a time");
  } finally {
    await server.close();
  }
});

test("tapping a thread opens the captain's message and the reply with timestamps", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card thread-card" && element.dataset.id === "note-0"),
    );
    const card = created.find(
      (element) => element.className === "session-card thread-card" && element.dataset.id === "note-0",
    );
    assert.ok(card);
    card.dispatch("click");

    await waitFor(() =>
      created.some((element) => element.className === "msg-text" && element.textContent === "all clear"),
    );
    const texts = created.filter((element) => element.className === "msg-text").map((element) => element.textContent);
    assert.ok(texts.includes("status please"), "the captain's instruction is in the thread");
    assert.ok(texts.includes("all clear"), "the reply is in the thread");

    const times = created.filter((element) => element.className === "msg-time");
    assert.ok(times.length >= 2, "both messages carry a timestamp");
    assert.ok(times.every((element) => element.textContent.length > 0));
    assert.ok(
      created.some((element) => element.className.includes("thread-delivery")),
      "the delivery state is shown inside the thread",
    );
  } finally {
    await server.close();
  }
});

test("a blocked pane with nothing in flight shows idle, not blocked", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const dir = mkdtempSync(join(tmpdir(), "reach-app-state-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const name of ["herdr", "fm-bearings-snapshot.sh"]) {
    cpSync(join(FAKE_BIN, name), join(binDir, name));
    chmodSync(join(binDir, name), 0o755);
  }
  const panes = JSON.parse(readFileSync(join(FIXTURES_DIR, "herdr-panes.json"), "utf8")) as {
    result: { panes: Array<{ agent_status?: string }> };
  };
  panes.result.panes[0]!.agent_status = "blocked";
  writeFileSync(join(dir, "herdr-panes.json"), JSON.stringify(panes));
  for (const name of ["herdr-workspaces.json", "herdr-tabs.json", "herdr-output.txt"]) {
    cpSync(join(FIXTURES_DIR, name), join(dir, name));
  }
  writeFileSync(
    join(dir, "bearings.json"),
    JSON.stringify({ schema: "fm-bearings.v1", in_flight: [], secondmates: [], decisions_open: [], gates: [] }),
  );

  const server = await startTestServer({ token: "t", binDir, herdrBin: join(binDir, "herdr") });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card" && element.dataset.id === "w1:p1"),
    );
    const labels = created
      .filter((element) => typeof element.className === "string" && element.className.split(" ").includes("badge"))
      .map((element) => element.textContent);
    assert.ok(labels.includes("idle"), "an idle fleet shows idle");
    assert.ok(!labels.includes("blocked"), "herdr's raw pane status never drives the badge");
  } finally {
    await server.close();
  }
});

interface SentNote {
  text: string;
  requestId: string;
  context?: { kind: string; id: string; label: string };
}

/** Pass requests through to the test server, recording every POST /api/note body. */
function recordingFetch(
  serverUrl: string,
  sent: SentNote[],
  override?: (path: string, init?: RequestInit) => Response | null,
): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init) => {
    if (path === "/api/note" && init?.method === "POST") sent.push(JSON.parse(String(init.body)) as SentNote);
    const replaced = override?.(path, init) ?? null;
    if (replaced !== null) return replaced;
    return nativeFetch(serverUrl + path, init);
  };
}

function storedNotes(home: string): string[] {
  const dir = join(home, "state", "notes");
  return existsSync(dir) ? readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")) : [];
}

/**
 * A firstmate double that queues notes and replays them as receipts, so an app
 * test can send through the real service and read the composed body back.
 */
function echoingFirstmate(seed: Array<{ requestId: string; body: string }> = []): FirstmateClient {
  const notes = new Map<string, string>();
  for (const note of seed) notes.set(note.requestId, note.body);
  return {
    run(script: string, args: readonly string[], stdin?: string): Promise<RunResult> {
      if (script === FM_SCRIPTS.inbox) {
        const command = args[0];
        if (command === "ready") {
          return Promise.resolve({ stdout: JSON.stringify({ can_receive: true }), stderr: "", code: 0 });
        }
        if (command === "note") {
          const at = args.indexOf("--request-id");
          const requestId = at >= 0 ? args[at + 1] ?? "" : "";
          const body = stdin ?? "";
          if (!notes.has(requestId)) notes.set(requestId, body);
          return Promise.resolve({
            stdout: JSON.stringify({
              schema: "fm-inbox-note.v1",
              outcome: "created",
              note_id: `note-${requestId}`,
              request_id: requestId,
              saved: true,
              announced: true,
            }),
            stderr: "",
            code: 0,
          });
        }
        if (command === "receipts") {
          const pending = [...notes.entries()].map(([requestId, body], index) => ({
            note_id: `note-${requestId}`,
            request_id: requestId,
            at: `2026-09-28T11:${String(index).padStart(2, "0")}:00Z`,
            body,
            acknowledged: false,
            announced: true,
            reply: null,
          }));
          return Promise.resolve({
            stdout: JSON.stringify({ schema: "fm-inbox-receipts.v1", pending, handled: [], replies: [] }),
            stderr: "",
            code: 0,
          });
        }
      }
      if (script === FM_SCRIPTS.bearings) {
        return Promise.resolve({
          stdout: JSON.stringify({
            schema: "fm-bearings.v1",
            in_flight: [],
            secondmates: [],
            decisions_open: [],
            gates: [],
          }),
          stderr: "",
          code: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: `unsupported ${script}`, code: 1 });
    },
  };
}

/**
 * Wait until a send has fully finished (its receipts reload included), so the
 * app does not render into the next test's fake document after this one ends.
 */
async function sendSettled(getElement: (id: string) => FakeElement): Promise<void> {
  await waitFor(() => (getElement("send") as FakeElement & { disabled?: boolean }).disabled === false);
}

function findCard(created: FakeElement[], className: string, id: string): FakeElement | undefined {
  return created.find((element) => element.className.startsWith(className) && element.dataset.id === id);
}

test("New conversation opens the conversation pane with its composer and queues a thread", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const sent: SentNote[] = [];
  try {
    const { getElement } = await bootApp(storage, recordingFetch(server.url, sent), "?view=conversations");

    getElement("new-conversation").dispatch("click");
    assert.equal(getElement("conversation-detail").hidden, false);
    assert.equal(getElement("conversation-composer").hidden, false);
    assert.equal(getElement("conversation-name").textContent, "New conversation");

    getElement("note-text").value = "send a scout to the west gate";
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });

    await waitFor(() => storedNotes(server.home).length === 1);
    assert.deepEqual(storedNotes(server.home), ["send a scout to the west gate"]);
    assert.equal(sent[0]?.context, undefined, "a new conversation carries no context");
    await waitFor(() => getElement("note-text").value === "");
    await sendSettled(getElement);
    assert.equal(getElement("conversation-composer").hidden, false, "the composer stays available");
  } finally {
    await server.close();
  }
});

test("an open thread keeps a composer and a send from it carries the thread as context", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const sent: SentNote[] = [];
  try {
    const { getElement, created } = await bootApp(storage, recordingFetch(server.url, sent), "?view=conversations");

    await waitFor(() => findCard(created, "session-card thread-card", "note-0") !== undefined);
    findCard(created, "session-card thread-card", "note-0")!.dispatch("click");

    assert.equal(getElement("conversation-detail").hidden, false);
    assert.equal(getElement("conversation-composer").hidden, false, "an open conversation has a place to type");
    assert.match(getElement("note-text").placeholder, /Reply/);

    getElement("note-text").value = "and the east gate too";
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });

    await waitFor(() => storedNotes(server.home).length === 1);
    await sendSettled(getElement);
    assert.deepEqual(sent[0]?.context, { kind: "thread", id: "note-0", label: "status please" });
    assert.equal(
      storedNotes(server.home)[0],
      '[walkie-talkie] Follow-up in conversation note-0 "status please"\n\nand the east gate too',
    );
  } finally {
    await server.close();
  }
});

test("an open live session keeps a composer and a send names the session for firstmate", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const sent: SentNote[] = [];
  try {
    const { getElement, created } = await bootApp(storage, recordingFetch(server.url, sent), "?view=conversations");

    await waitFor(() => findCard(created, "session-card", "w1:p1") !== undefined);
    findCard(created, "session-card", "w1:p1")!.dispatch("click");

    assert.equal(getElement("conversation-composer").hidden, false);
    assert.match(getElement("compose-hint").textContent, /not into this session/);

    getElement("note-text").value = "is this one stuck?";
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });

    await waitFor(() => storedNotes(server.home).length === 1);
    assert.deepEqual(sent[0]?.context, {
      kind: "session",
      id: "w1:p1",
      label: "firstmate: Continuing walkie-talkie project work",
    });
    assert.equal(
      storedNotes(server.home)[0],
      '[walkie-talkie] Sent while viewing live session w1:p1 "firstmate: Continuing walkie-talkie project work"' +
        "\n\nis this one stuck?",
    );
    await waitFor(() => /Sent to firstmate/.test(getElement("compose-status").textContent));
    await sendSettled(getElement);
  } finally {
    await server.close();
  }
});

test("a failed send retries with the same request id; another conversation gets a new one", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const sent: SentNote[] = [];
  let failNext = true;
  const fail = (path: string, init?: RequestInit): Response | null => {
    if (path !== "/api/note" || init?.method !== "POST" || !failNext) return null;
    failNext = false;
    return new Response(JSON.stringify({ error: "firstmate unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { getElement, created } = await bootApp(
      storage,
      recordingFetch(server.url, sent, fail),
      "?view=conversations",
    );

    await waitFor(() => findCard(created, "session-card thread-card", "note-0") !== undefined);
    findCard(created, "session-card thread-card", "note-0")!.dispatch("click");
    getElement("note-text").value = "repeat after me";
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => /Not queued/.test(getElement("compose-status").textContent));

    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => storedNotes(server.home).length === 1);
    await sendSettled(getElement);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.requestId, sent[0]?.requestId, "the retry reuses the request id");

    findCard(created, "session-card thread-card", "note-1")!.dispatch("click");
    getElement("note-text").value = "repeat after me";
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => storedNotes(server.home).length === 2);
    await sendSettled(getElement);
    assert.notEqual(sent[2]?.requestId, sent[0]?.requestId, "a different conversation is a different request");
  } finally {
    await server.close();
  }
});

test("a follow-up joins its thread instead of listing as a new conversation", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const receipts = {
    schema: "fm-inbox-receipts.v1",
    pending: [
      {
        note_id: "note-2",
        request_id: "req-2",
        at: "2026-09-28T11:10:00Z",
        body: '[walkie-talkie] Follow-up in conversation note-0 "status please"\n\nand the east gate?',
        acknowledged: false,
        announced: true,
        reply: null,
      },
    ],
    handled: [
      {
        note_id: "note-0",
        request_id: "req-0",
        at: "2026-09-28T11:00:00Z",
        body: "status please",
        acknowledged: true,
        announced: true,
        reply: { id: "note-0", at: "2026-09-28T11:05:00Z", body: "all clear" },
      },
    ],
    replies: [],
  };
  const override = (path: string): Response | null =>
    path === "/api/receipts"
      ? new Response(JSON.stringify(receipts), { status: 200, headers: { "content-type": "application/json" } })
      : null;
  try {
    const { created } = await bootApp(storage, recordingFetch(server.url, [], override), "?view=conversations");

    await waitFor(() => findCard(created, "session-card thread-card", "note-0") !== undefined);
    assert.equal(findCard(created, "session-card thread-card", "note-2"), undefined);
    findCard(created, "session-card thread-card", "note-0")!.dispatch("click");

    await waitFor(() =>
      created.some((element) => element.className === "msg-text" && element.textContent === "and the east gate?"),
    );
    const texts = created.filter((element) => element.className === "msg-text").map((element) => element.textContent);
    assert.deepEqual(texts.slice(-3), ["status please", "all clear", "and the east gate?"]);
    assert.ok(
      created.some((element) => element.className.includes("thread-delivery") && /Queued/.test(element.textContent)),
      "the delivery line follows the latest message",
    );
  } finally {
    await server.close();
  }
});

test("a message that looks like a context header is not grouped under another thread", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({
    token: "t",
    herdrBin: HERDR_BIN,
    firstmate: echoingFirstmate([{ requestId: "req-0", body: "status please" }]),
  });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement, created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() => findCard(created, "session-card thread-card", "note-req-0") !== undefined);

    const typed = '[walkie-talkie] Follow-up in conversation note-req-0 "status please"\n\nthe gate is clear';
    getElement("new-conversation").dispatch("click");
    getElement("note-text").value = typed;
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await sendSettled(getElement);

    await waitFor(() =>
      created.some(
        (element) =>
          element.className.startsWith("session-card thread-card") && element.dataset.id !== "note-req-0",
      ),
    );
    const ownCard = created.find(
      (element) =>
        element.className.startsWith("session-card thread-card") && element.dataset.id !== "note-req-0",
    );
    assert.ok(ownCard, "the composed-looking message is its own thread, not a follow-up");

    ownCard.dispatch("click");
    await waitFor(() =>
      created.some((element) => element.className === "msg-text" && element.textContent === typed),
    );
    assert.ok(
      !created.some((element) => element.textContent.startsWith("\\[walkie-talkie]")),
      "the service's escape never reaches the captain's display",
    );
  } finally {
    await server.close();
  }
});

test("a follow-up whose text begins with the context header is shown as typed", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({
    token: "t",
    herdrBin: HERDR_BIN,
    firstmate: echoingFirstmate([{ requestId: "0", body: "status please" }]),
  });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement, created } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() => findCard(created, "session-card thread-card", "note-0") !== undefined);
    findCard(created, "session-card thread-card", "note-0")!.dispatch("click");

    const typed =
      '[walkie-talkie] Follow-up in conversation note-0 "status please"\n\nand the east gate too';
    getElement("note-text").value = typed;
    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await sendSettled(getElement);

    await waitFor(() =>
      created.some((element) => element.className === "msg-text" && element.textContent === typed),
    );
  } finally {
    await server.close();
  }
});

/** A stand-in for the browser's SpeechRecognition that the test can drive. */
class FakeSpeechRecognition {
  static last: FakeSpeechRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  constructor() {
    FakeSpeechRecognition.last = this;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {}

  abort(): void {}
}

function finalTranscript(transcript: string): unknown {
  const result = Object.assign([{ transcript }], { isFinal: true });
  return { resultIndex: 0, results: [result] };
}

test("the mic is shown in the composer when the browser has speech recognition", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
      { webkitSpeechRecognition: FakeSpeechRecognition },
    );
    assert.equal(getElement("mic").hidden, false);
  } finally {
    await server.close();
  }
});

test("an installed iPhone app with speech recognition still shows the mic", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
      {
        webkitSpeechRecognition: FakeSpeechRecognition,
        navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", standalone: true },
      },
    );
    assert.equal(getElement("mic").hidden, false, "the working voice input is not gated away on iOS");
  } finally {
    await server.close();
  }
});

test("without speech recognition the mic stays hidden and typing still works", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { getElement } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );
    assert.equal(getElement("mic").hidden, true);
    assert.equal(getElement("conversation-composer").hidden, false);
  } finally {
    await server.close();
  }
});

test("holding the mic in an open thread dictates into its composer and sends with the thread", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const sent: SentNote[] = [];
  try {
    const { getElement, created } = await bootApp(
      storage,
      recordingFetch(server.url, sent),
      "?view=conversations",
      { webkitSpeechRecognition: FakeSpeechRecognition },
    );

    await waitFor(() => findCard(created, "session-card thread-card", "note-0") !== undefined);
    findCard(created, "session-card thread-card", "note-0")!.dispatch("click");

    const mic = getElement("mic");
    mic.dispatch("pointerdown", { preventDefault: () => {}, pointerId: 1 });
    const recognition = FakeSpeechRecognition.last;
    assert.ok(recognition?.started, "holding the mic starts recognition");
    recognition!.onresult?.(finalTranscript("check the west gate"));
    mic.dispatch("pointerup");
    assert.equal(getElement("note-text").value, "check the west gate");

    getElement("note-form").dispatch("submit", { preventDefault: () => {} });
    await waitFor(() => storedNotes(server.home).length === 1);
    await sendSettled(getElement);
    assert.deepEqual(sent[0]?.context, { kind: "thread", id: "note-0", label: "status please" });
    assert.equal(sent[0]?.text, "check the west gate");
  } finally {
    await server.close();
  }
});
