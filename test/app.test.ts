import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { OpencodeStore } from "../src/conversation-store.js";
import { FAKE_BIN, REPO_ROOT, startTestServer } from "./helpers.js";

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
  const tabs = ["status", "conversations", "compose", "receipts", "settings"].map((view) => {
    const tab = makeElement(`tab-${view}`);
    tab.dataset.view = view;
    return tab;
  });
  const views = ["status", "conversations", "compose", "receipts", "settings"].map((view) =>
    makeElement(`view-${view}`),
  );

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
    ["window", { location: { origin: "http://localhost", search } }],
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
