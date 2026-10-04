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
  children: FakeElement[];
  appendChild: (child: unknown) => unknown;
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  dispatch: (type: string, event?: unknown) => void;
}

function makeElement(id: string): FakeElement {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const element: FakeElement = {
    id,
    className: "",
    textContent: "",
    value: "",
    placeholder: "",
    hidden: false,
    dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    setAttribute: () => {},
    children: [],
    appendChild: (child) => {
      if (child !== null && typeof child === "object" && "className" in child) {
        element.children.push(child as FakeElement);
      }
      return child;
    },
    addEventListener: (type, handler) => {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch: (type, event) => {
      for (const handler of listeners.get(type) ?? []) handler(event ?? {});
    },
  };
  return element;
}

/** Every badge label under a container, so a test can scope which card it checks. */
function badgeTexts(container: FakeElement): string[] {
  const labels: string[] = [];
  const walk = (node: FakeElement): void => {
    if (typeof node.className === "string" && node.className.split(" ").includes("badge")) {
      labels.push(node.textContent);
    }
    for (const child of node.children) walk(child);
  };
  walk(container);
  return labels;
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
  statusPoll: () => void;
  /** How many uncleared intervals of this delay are registered. */
  activeIntervals: (delayMs: number) => number;
  /** Background or foreground the page, firing visibilitychange as a browser does. */
  setVisibility: (visibility: "visible" | "hidden") => void;
  /** Fire window pageshow, persisted when the page comes back from the back-forward cache. */
  pageshow: (persisted: boolean) => void;
}

let bootCount = 0;

async function bootApp(
  storage: MemoryStorage,
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  search = "",
  windowExtras: Record<string, unknown> = {},
): Promise<AppHarness> {
  bootCount += 1;
  const boot = bootCount;
  // Every booted app reads `document` from globalThis, so an earlier test's
  // app whose response lands late would render into this test's document
  // (its cards land in `created` with that app's own click handlers). Once a
  // newer app boots, an older app's responses never settle.
  const live = <T>(value: T): Promise<T> =>
    boot === bootCount ? Promise.resolve(value) : new Promise<T>(() => {});
  const isolatedFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetchImpl(path, init);
    const text = await live(await response.text());
    return {
      ok: response.ok,
      status: response.status,
      text: () => live(text),
      json: () => live(text).then((raw) => JSON.parse(raw) as unknown),
    } as Response;
  };
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
  const intervals: Array<{ fn: () => void; delayMs: number; cleared: boolean }> = [];
  const activeIntervals = (delayMs: number): number =>
    intervals.filter((interval) => interval.delayMs === delayMs && !interval.cleared).length;
  const statusPoll = (): void => {
    const entry = intervals.findLast((interval) => interval.delayMs === 10000 && !interval.cleared);
    assert.ok(entry, "the status view registers a poll interval");
    entry.fn();
  };
  const documentListeners = makeElement("document");
  const windowListeners = makeElement("window");
  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: documentListeners.addEventListener,
  };

  const globals: Array<[string, unknown]> = [
    ["localStorage", storage],
    [
      "document",
      Object.assign(fakeDocument, {
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
      }),
    ],
    [
      "window",
      {
        location: { origin: "http://localhost", search },
        addEventListener: windowListeners.addEventListener,
        ...windowExtras,
      },
    ],
    ["navigator", {}],
    ["fetch", isolatedFetch],
    // The conversation view's polling is exercised through its Refresh button,
    // so interval timers are captured but never fire on their own here to keep
    // the test deterministic; a test drives one explicitly when it needs a tick.
    ["setInterval", (fn: () => void, delayMs?: number) => {
      intervals.push({ fn, delayMs: Number(delayMs) || 0, cleared: false });
      return intervals.length;
    }],
    ["clearInterval", (id: number) => {
      const entry = intervals[id - 1];
      if (entry) entry.cleared = true;
    }],
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
    statusPoll,
    activeIntervals,
    setVisibility: (visibility) => {
      fakeDocument.visibilityState = visibility;
      documentListeners.dispatch("visibilitychange");
    },
    pageshow: (persisted) => windowListeners.dispatch("pageshow", { persisted }),
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
    // The queued note says how long it has waited and what firstmate is doing
    // (the fixture's primary pane is working).
    await waitFor(() =>
      created.some((element) => element.className === "sub" && element.textContent.includes("firstmate is working")),
    );
    const subs = created.filter((element) => element.className === "sub").map((element) => element.textContent);
    assert.ok(
      subs.some((text) => /Queued \d+ h(?: \d+ min)?; firstmate is working and has not picked it up yet\./.test(text)),
      `queued line carries its age and firstmate's activity: ${subs.join(" | ")}`,
    );
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
    const { created, getElement } = await bootApp(
      storage,
      (path, init) => nativeFetch(server.url + path, init),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some((element) => element.className === "session-card" && element.dataset.id === "w1:p1"),
    );
    const labels = badgeTexts(getElement("sessions-body"));
    assert.ok(labels.includes("idle"), "an idle fleet shows idle");
    assert.ok(!labels.includes("blocked"), "herdr's raw pane status never drives the session badge");
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

test("the health banner survives a status read that answers after it", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  // Live, /api/health answers in ~160 ms and /api/status in ~1.7 s; hold the
  // status read until the health response has been delivered.
  let healthDelivered: () => void = () => {};
  const healthDone = new Promise<void>((resolve) => {
    healthDelivered = resolve;
  });
  let statusDelivered = false;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/api/status") {
      await healthDone;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await nativeFetch(server.url + path, init);
      statusDelivered = true;
      return response;
    }
    const response = await nativeFetch(server.url + path, init);
    if (path === "/api/health") setTimeout(healthDelivered, 0);
    return response;
  };
  try {
    const { getElement } = await bootApp(storage, fetchImpl);
    const banner = getElement("connection-banner");
    await waitFor(() => statusDelivered);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(banner.hidden, false, "the status read must not erase the health banner");
    assert.equal(banner.textContent, "firstmate reachable — can receive: yes");
  } finally {
    await server.close();
  }
});

test("a null health payload reads as reachable with unknown readiness, not an error", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const nullHealth = (path: string): Response | null =>
    path === "/api/health"
      ? new Response("null", { status: 200, headers: { "content-type": "application/json" } })
      : null;
  try {
    const { getElement } = await bootApp(storage, recordingFetch(server.url, [], nullHealth));
    const banner = getElement("connection-banner");
    await waitFor(() => banner.textContent.includes("can receive"));
    assert.equal(banner.textContent, "firstmate reachable — can receive: unknown");
    assert.equal(banner.hidden, false, "a null health payload is shown, not hidden");
    assert.ok(!banner.className.includes("bad"), `a null health payload is not an error banner: ${banner.className}`);
  } finally {
    await server.close();
  }
});

test("the status poll replaces a transient health failure banner once /api/health answers again", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  let healthCalls = 0;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/api/health") {
      healthCalls += 1;
      if (healthCalls === 1) throw new Error("boom");
    }
    return nativeFetch(server.url + path, init);
  };
  try {
    const { getElement, statusPoll } = await bootApp(storage, fetchImpl);
    const banner = getElement("connection-banner");
    await waitFor(() => banner.textContent.includes("not reachable"));
    statusPoll();
    await waitFor(() => banner.textContent === "firstmate reachable — can receive: yes");
    assert.equal(banner.hidden, false);
  } finally {
    await server.close();
  }
});

test("a health answer after a failed status read leaves the status error visible", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  let statusFailed: () => void = () => {};
  const statusDone = new Promise<void>((resolve) => {
    statusFailed = resolve;
  });
  let healthDelivered = 0;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/api/status") {
      setTimeout(statusFailed, 0);
      return new Response(JSON.stringify({ error: "snapshot failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/health") {
      await statusDone;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await nativeFetch(server.url + path, init);
      healthDelivered += 1;
      return response;
    }
    return nativeFetch(server.url + path, init);
  };
  try {
    const { getElement, statusPoll } = await bootApp(storage, fetchImpl);
    const banner = getElement("connection-banner");
    await waitFor(() => healthDelivered === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(banner.textContent, /^Could not load fleet status/);
    statusPoll();
    await waitFor(() => healthDelivered === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(banner.textContent, /^Could not load fleet status/);
    assert.ok(banner.className.includes("bad"), `the status error stays an error banner: ${banner.className}`);
  } finally {
    await server.close();
  }
});

test("a failed firstmate read shows a could-not-read card, not a loading one", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const failing = (path: string): Response | null =>
    path === "/api/firstmate"
      ? new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })
      : null;
  try {
    const { created, getElement } = await bootApp(storage, recordingFetch(server.url, [], failing));
    await waitFor(() => created.some((element) => element.textContent === "Could not read firstmate's state"));
    const body = getElement("firstmate-body");
    assert.ok(
      !body.children.some((child) => child.textContent === "Reading firstmate's state…"),
      "a failed read is not shown as loading",
    );
    assert.deepEqual(badgeTexts(body), ["unknown"]);
  } finally {
    await server.close();
  }
});

/**
 * Serve /api/status from a snapshot whose observed time the test moves, and
 * count each read, so a fresh read is told apart from what was on screen.
 */
function fleetStatusDouble(server: { url: string }): {
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>;
  reads: Record<string, number>;
  setGenerated: (value: string) => void;
} {
  let generated = "2026-10-04T10:00:00Z";
  const reads: Record<string, number> = {};
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    const route = path.split("?")[0] ?? path;
    reads[route] = (reads[route] ?? 0) + 1;
    if (route === "/api/status") {
      return new Response(JSON.stringify({ generated, in_flight: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return nativeFetch(server.url + path, init);
  };
  return { fetchImpl, reads, setGenerated: (value) => (generated = value) };
}

function showsObserved(getElement: (id: string) => FakeElement, generated: string): boolean {
  return getElement("status-body").children.some((child) => child.textContent === `Observed ${generated}`);
}

test("returning the app to the foreground re-reads the Status screen at once, and nothing polls while it is hidden", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const { fetchImpl, reads, setGenerated } = fleetStatusDouble(server);
  try {
    const { getElement, activeIntervals, setVisibility } = await bootApp(storage, fetchImpl);
    await waitFor(() => showsObserved(getElement, "2026-10-04T10:00:00Z"));
    assert.equal(activeIntervals(10000), 1, "the Status screen polls while it is on screen");

    setVisibility("hidden");
    assert.equal(activeIntervals(10000), 0, "nothing polls while the app is in the background");

    setGenerated("2026-10-04T10:05:00Z");
    const firstmateReads = reads["/api/firstmate"] ?? 0;
    const healthReads = reads["/api/health"] ?? 0;
    // No poll tick fires here: coming back to the foreground alone refreshes it.
    setVisibility("visible");
    await waitFor(() => showsObserved(getElement, "2026-10-04T10:05:00Z"));
    await waitFor(() => (reads["/api/firstmate"] ?? 0) > firstmateReads && (reads["/api/health"] ?? 0) > healthReads);
    assert.equal(activeIntervals(10000), 1, "polling resumes once rather than stacking timers");
  } finally {
    await server.close();
  }
});

test("a page restored from the back-forward cache re-reads the Status screen", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const { fetchImpl, reads, setGenerated } = fleetStatusDouble(server);
  try {
    const { getElement, pageshow } = await bootApp(storage, fetchImpl);
    await waitFor(() => showsObserved(getElement, "2026-10-04T10:00:00Z"));
    const statusReads = reads["/api/status"];

    pageshow(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads["/api/status"], statusReads, "a first page load is not refreshed twice");

    setGenerated("2026-10-04T10:05:00Z");
    pageshow(true);
    await waitFor(() => showsObserved(getElement, "2026-10-04T10:05:00Z"));
  } finally {
    await server.close();
  }
});

test("the Conversations view stops polling in the background and re-reads when shown", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const { fetchImpl, reads } = fleetStatusDouble(server);
  try {
    const { activeIntervals, setVisibility } = await bootApp(storage, fetchImpl, "?view=conversations");
    await waitFor(() => (reads["/api/sessions"] ?? 0) === 1);
    assert.equal(activeIntervals(5000), 1);
    assert.equal(activeIntervals(3000), 1);

    setVisibility("hidden");
    assert.equal(activeIntervals(5000), 0);
    assert.equal(activeIntervals(3000), 0);

    setVisibility("visible");
    await waitFor(() => (reads["/api/sessions"] ?? 0) === 2);
    assert.equal(activeIntervals(5000), 1);
    assert.equal(activeIntervals(3000), 1);
    assert.equal(activeIntervals(10000), 0, "the Status poll stays off outside the Status screen");
  } finally {
    await server.close();
  }
});

test("the Status tab shows firstmate's own state: busy, receiving, and what is queued", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  try {
    const { created } = await bootApp(storage, (path, init) => nativeFetch(server.url + path, init));
    await waitFor(() =>
      created.some((element) => element.className === "sub" && element.textContent.startsWith("Receiving notes")),
    );
    const sub = created.find((element) => element.className === "sub" && element.textContent.startsWith("Receiving notes"));
    assert.match(sub!.textContent, /^Receiving notes · 1 queued, oldest \d+ h/);
    const badges = created
      .filter((element) => typeof element.className === "string" && element.className.split(" ").includes("badge"))
      .map((element) => element.textContent);
    assert.ok(badges.includes("working"), `firstmate's primary is working: ${badges.join(", ")}`);
  } finally {
    await server.close();
  }
});

/** Serve one canned /api/firstmate live state and pass everything else through. */
function firstmateLiveOverride(live: Record<string, unknown>): (path: string) => Response | null {
  return (path) =>
    path === "/api/firstmate"
      ? new Response(JSON.stringify(live), { status: 200, headers: { "content-type": "application/json" } })
      : null;
}

test("a blocked firstmate is shown blocked, and its queued note says it waits on a prompt", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const override = firstmateLiveOverride({
    schema: "walkie-talkie-firstmate.v1",
    observed_at: "2026-10-04T00:00:00Z",
    activity: "blocked",
    primary: { id: "w1:p1", agent: "opencode", status: "blocked" },
    can_receive: true,
    watcher_beacon_age_seconds: 1,
    queue: { queued: 1, oldest_queued_at: "2026-09-28T11:40:00Z" },
  });
  try {
    const { created, getElement } = await bootApp(
      storage,
      recordingFetch(server.url, [], override),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some(
        (element) =>
          element.className === "sub" &&
          element.textContent.includes("firstmate is blocked waiting on a prompt"),
      ),
    );
    const badges = badgeTexts(getElement("firstmate-body"));
    assert.ok(badges.includes("blocked"), `a blocked firstmate shows blocked: ${badges.join(", ")}`);
    assert.ok(!badges.includes("idle"), "a blocked firstmate is never shown as idle");
  } finally {
    await server.close();
  }
});

test("an unrecognized firstmate activity is shown unknown, never idle", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "t");
  const override = firstmateLiveOverride({
    schema: "walkie-talkie-firstmate.v1",
    observed_at: "2026-10-04T00:00:00Z",
    activity: "unknown",
    primary: { id: "w1:p1", agent: "opencode", status: "summoned" },
    can_receive: true,
    watcher_beacon_age_seconds: 1,
    queue: { queued: 1, oldest_queued_at: "2026-09-28T11:40:00Z" },
  });
  try {
    const { created, getElement } = await bootApp(
      storage,
      recordingFetch(server.url, [], override),
      "?view=conversations",
    );

    await waitFor(() =>
      created.some(
        (element) =>
          element.className === "sub" && element.textContent.includes("firstmate's state is unknown"),
      ),
    );
    const badges = badgeTexts(getElement("firstmate-body"));
    assert.ok(badges.includes("unknown"), `an unrecognized activity shows unknown: ${badges.join(", ")}`);
    assert.ok(!badges.includes("idle"), "an unrecognized activity is never shown as idle");
  } finally {
    await server.close();
  }
});

interface GatewayDouble {
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>;
  /** Every request the app made, with the Authorization header it carried. */
  requests: Array<{ path: string; method: string; authorization: string | null }>;
  signOut: () => void;
}

/**
 * The multi-user gateway as the app sees it: /auth/session answers the probe,
 * and /api/* reaches a real standalone server only while the session is live
 * (or, with the legacy bridge on, for the shared token).
 */
function gatewayDouble(
  server: { url: string },
  session: { signedIn: boolean; login?: string; legacyBearer?: boolean; legacyToken?: string },
): GatewayDouble {
  const requests: GatewayDouble["requests"] = [];
  let signedIn = session.signedIn;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    requests.push({ path, method: init?.method ?? "GET", authorization: headers.get("authorization") });
    if (path === "/auth/session") {
      return json({
        schema: "walkie-talkie-session.v1",
        mode: "gateway",
        signed_in: signedIn,
        user: signedIn ? { login: session.login ?? "captain", admin: true, firstmate: "ready" } : null,
        legacy_bearer: session.legacyBearer === true,
      });
    }
    if (path === "/auth/logout") {
      signedIn = false;
      return json({ ok: true });
    }
    if (path.startsWith("/api/")) {
      const legacy =
        session.legacyBearer === true && headers.get("authorization") === `Bearer ${session.legacyToken ?? ""}`;
      if (!signedIn && !legacy) return json({ error: "signed_out" }, 401);
      // The gateway presents the tenant's own token upstream.
      return nativeFetch(server.url + path, { ...init, headers: { authorization: "Bearer t" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, requests, signOut: () => (signedIn = false) };
}

test("behind the gateway a signed-out visitor sees the sign-in screen with the outcome, and no tabs", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  const gateway = gatewayDouble(server, { signedIn: false });
  try {
    const { getElement } = await bootApp(storage, gateway.fetchImpl, "?signin=not_invited");
    const status = getElement("signin-status");
    await waitFor(() => status.textContent !== "");
    assert.equal(status.textContent, "This GitHub account is not invited. Ask the admin to invite you.");
    assert.equal(getElement("tabs").hidden, true);
    assert.equal(storage.getItem("walkie-talkie.mode"), "gateway");
  } finally {
    await server.close();
  }
});

test("signed in with GitHub, the app drops the retiring shared token and shows the account", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "old-shared-token");
  const gateway = gatewayDouble(server, { signedIn: true, login: "captain" });
  try {
    const { getElement } = await bootApp(storage, gateway.fetchImpl, "?view=settings");
    const line = getElement("account-line");
    await waitFor(() => line.textContent.includes("@captain"));
    assert.equal(line.textContent, "Signed in with GitHub as @captain.");
    assert.equal(storage.getItem(TOKEN_KEY), null, "the shared token is forgotten");
    assert.equal(getElement("settings-form").hidden, true, "no token form behind the gateway");
    assert.equal(getElement("account-panel").hidden, false);
    assert.equal(getElement("account-signin").hidden, true);

    gateway.requests.length = 0;
    getElement("refresh").dispatch("click");
    await waitFor(() => gateway.requests.some((request) => request.path === "/api/status"));
    for (const request of gateway.requests.filter((entry) => entry.path.startsWith("/api/"))) {
      assert.equal(request.authorization, null, `${request.path} relies on the session cookie alone`);
    }
  } finally {
    await server.close();
  }
});

test("a 401 behind the gateway returns the app to the sign-in screen", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  const gateway = gatewayDouble(server, { signedIn: true });
  try {
    const { getElement } = await bootApp(storage, gateway.fetchImpl);
    await waitFor(() => gateway.requests.some((request) => request.path === "/api/status"));
    gateway.signOut();
    getElement("refresh").dispatch("click");
    await waitFor(() => getElement("signin-status").textContent === "You are signed out.");
    assert.equal(getElement("tabs").hidden, true);
  } finally {
    await server.close();
  }
});

test("Sign out ends the gateway session and shows the sign-in screen", async () => {
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  const gateway = gatewayDouble(server, { signedIn: true });
  try {
    const { getElement } = await bootApp(storage, gateway.fetchImpl, "?view=settings");
    await waitFor(() => getElement("account-line").textContent.startsWith("Signed in"));
    getElement("sign-out").dispatch("click");
    await waitFor(() => getElement("signin-status").textContent === "You are signed out.");
    assert.ok(gateway.requests.some((request) => request.path === "/auth/logout" && request.method === "POST"));
    assert.equal(getElement("tabs").hidden, true);
  } finally {
    await server.close();
  }
});

test("with the legacy bridge on, an unsigned device keeps working on its token and is asked to sign in", async () => {
  const { TOKEN_KEY } = await loadTokenMessages();
  const server = await startTestServer({ token: "t", herdrBin: HERDR_BIN });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "shared");
  const gateway = gatewayDouble(server, { signedIn: false, legacyBearer: true, legacyToken: "shared" });
  try {
    const { getElement } = await bootApp(storage, gateway.fetchImpl, "?view=settings");
    const line = getElement("account-line");
    await waitFor(() => line.textContent.includes("shared token"));
    assert.equal(getElement("account-signin").hidden, false, "a Sign in with GitHub link is offered");
    assert.equal(getElement("sign-out").hidden, true);
    assert.equal(storage.getItem(TOKEN_KEY), "shared", "the token keeps working until GitHub sign-in");

    getElement("refresh").dispatch("click");
    await waitFor(() =>
      gateway.requests.some((request) => request.path === "/api/status" && request.authorization === "Bearer shared"),
    );
    assert.equal(getElement("signin-status").textContent, "", "the sign-in screen is not forced");
  } finally {
    await server.close();
  }
});
