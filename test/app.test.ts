import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, startTestServer } from "./helpers.js";

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

test("a 401 clears the stored token and field so the captain re-enters the real one", async () => {
  const { TOKEN_KEY, UNAUTHORIZED_MESSAGE } = (await import(
    pathToFileURL(join(REPO_ROOT, "public", "token.js")).href
  )) as { TOKEN_KEY: string; UNAUTHORIZED_MESSAGE: string };

  const server = await startTestServer({ token: "s3cr3t" });
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "s3cr3t%");

  const elements = new Map<string, FakeElement>();
  const getElement = (id: string): FakeElement => {
    let element = elements.get(id);
    if (!element) {
      element = makeElement(id);
      elements.set(id, element);
    }
    return element;
  };
  const tabs = ["status", "compose", "receipts", "settings"].map((view) => {
    const tab = makeElement(`tab-${view}`);
    tab.dataset.view = view;
    return tab;
  });
  const views = ["status", "compose", "receipts", "settings"].map((view) => makeElement(`view-${view}`));

  const realFetch = globalThis.fetch;
  const globals: Array<[string, unknown]> = [
    ["localStorage", storage],
    [
      "document",
      {
        getElementById: getElement,
        createElement: (tag: string) => makeElement(tag),
        createTextNode: (text: string) => ({ textContent: String(text) }),
        querySelectorAll: (selector: string) => {
          if (selector === ".tab") return tabs;
          if (selector === ".view") return views;
          return [];
        },
      },
    ],
    ["window", { location: { origin: "http://localhost", search: "" } }],
    ["navigator", {}],
    [
      "fetch",
      (path: string, init?: Parameters<typeof fetch>[1]) => realFetch(server.url + path, init),
    ],
  ];
  for (const [name, value] of globals) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  try {
    await import(pathToFileURL(join(REPO_ROOT, "public", "app.js")).href);

    const tokenInput = getElement("token-input");
    const settingsStatus = getElement("settings-status");
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
