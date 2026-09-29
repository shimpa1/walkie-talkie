import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./helpers.js";
import type { TokenStorage } from "../public/token.js";

interface TokenModule {
  TOKEN_KEY: string;
  LEGACY_TOKEN_KEY: string;
  loadToken: (storage: TokenStorage) => string;
}

let cached: TokenModule | null = null;

async function loadTokenModule(): Promise<TokenModule> {
  if (cached === null) {
    cached = (await import(pathToFileURL(join(REPO_ROOT, "public", "token.js")).href)) as TokenModule;
  }
  return cached;
}

function fakeStorage(initial: Record<string, string> = {}): TokenStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

test("the new token key is used when it is already saved", async () => {
  const { TOKEN_KEY, LEGACY_TOKEN_KEY, loadToken } = await loadTokenModule();
  const storage = fakeStorage({ [TOKEN_KEY]: "new-token", [LEGACY_TOKEN_KEY]: "old-token" });

  assert.equal(loadToken(storage), "new-token");
  assert.equal(storage.getItem(LEGACY_TOKEN_KEY), "old-token");
});

test("a token saved under the old key is returned and migrated to the new key", async () => {
  const { TOKEN_KEY, LEGACY_TOKEN_KEY, loadToken } = await loadTokenModule();
  const storage = fakeStorage({ [LEGACY_TOKEN_KEY]: "existing-token" });

  assert.equal(loadToken(storage), "existing-token");
  assert.equal(storage.getItem(TOKEN_KEY), "existing-token");
  assert.equal(storage.getItem(LEGACY_TOKEN_KEY), null);
});

test("no saved token returns an empty string without writing anything", async () => {
  const { loadToken } = await loadTokenModule();
  const storage = fakeStorage();

  assert.equal(loadToken(storage), "");
  assert.equal(storage.entries.size, 0);
});
