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

interface ApiErrorLike extends Error {
  status: number;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

interface ApiInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type FetchLike = (path: string, init?: ApiInit) => Promise<ResponseLike>;

interface ApiClient {
  (path: string, init?: ApiInit): Promise<{ schema?: string } | null>;
}

interface CreateApiOptions {
  fetch?: FetchLike;
  getToken?: () => string;
  onUnauthorized?: (response: ResponseLike) => void;
}

interface TokenModule {
  TOKEN_KEY: string;
  LEGACY_TOKEN_KEY: string;
  UNAUTHORIZED_MESSAGE: string;
  normalizeToken: (value: unknown) => string;
  readToken: (storage: TokenStorageLike) => string;
  writeToken: (storage: TokenStorageLike, value: string) => string;
  forgetToken: (storage: TokenStorageLike) => void;
  authHeaders: (token: string, extra?: Record<string, string>) => Record<string, string>;
  ApiError: new (message: string, status: number) => ApiErrorLike;
  createApi: (options: CreateApiOptions) => ApiClient;
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

let cached: TokenModule | null = null;

async function loadToken(): Promise<TokenModule> {
  if (cached === null) {
    cached = (await import(
      pathToFileURL(join(REPO_ROOT, "public", "token.js")).href
    )) as TokenModule;
  }
  return cached;
}

function jsonResponse(status: number, body: unknown): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("a token entered in Settings is stored trimmed and survives a reload", async () => {
  const { writeToken, readToken, TOKEN_KEY } = await loadToken();
  const storage = new MemoryStorage();

  assert.equal(writeToken(storage, "  secret-token  "), "secret-token");
  assert.equal(storage.getItem(TOKEN_KEY), "secret-token");
  assert.equal(readToken(storage), "secret-token");
  assert.equal(readToken(new MemoryStorage()), "");
});

test("storing an empty token forgets it instead of keeping a blank credential", async () => {
  const { writeToken, readToken, forgetToken } = await loadToken();
  const storage = new MemoryStorage();

  writeToken(storage, "secret-token");
  writeToken(storage, "   ");
  assert.equal(readToken(storage), "");

  writeToken(storage, "secret-token");
  forgetToken(storage);
  assert.equal(readToken(storage), "");
});

test("authHeaders sends a bearer credential only when a token is set", async () => {
  const { authHeaders } = await loadToken();

  assert.deepEqual(authHeaders("  secret-token  "), { authorization: "Bearer secret-token" });
  assert.deepEqual(authHeaders("", { "content-type": "application/json" }), {
    "content-type": "application/json",
  });
  assert.deepEqual(authHeaders("secret-token", { "content-type": "application/json" }), {
    "content-type": "application/json",
    authorization: "Bearer secret-token",
  });
});

test("the api client sends the stored token and returns the parsed body", async () => {
  const { createApi } = await loadToken();
  let headers: Record<string, string> | undefined;
  const api = createApi({
    fetch: async (_path, init) => {
      headers = init?.headers;
      return jsonResponse(200, { schema: "fm-bearings.v1" });
    },
    getToken: () => "secret-token",
  });

  const body = await api("/api/status");
  assert.equal(headers?.authorization, "Bearer secret-token");
  assert.deepEqual(body, { schema: "fm-bearings.v1" });
});

test("a 401 reports the Settings guidance and drives the unauthorized hook", async () => {
  const { createApi, UNAUTHORIZED_MESSAGE, ApiError } = await loadToken();
  let unauthorized = 0;
  const api = createApi({
    fetch: async () => jsonResponse(401, { error: "unauthorized" }),
    getToken: () => "wrong-token",
    onUnauthorized: () => {
      unauthorized += 1;
    },
  });

  await assert.rejects(api("/api/status"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal((error as ApiErrorLike).status, 401);
    assert.equal((error as Error).message, UNAUTHORIZED_MESSAGE);
    assert.match((error as Error).message, /Settings/);
    return true;
  });
  assert.equal(unauthorized, 1);
});

test("a non-401 failure keeps the server's own message and status", async () => {
  const { createApi } = await loadToken();
  const api = createApi({
    fetch: async () => jsonResponse(502, { error: "firstmate bearings failed" }),
    getToken: () => "secret-token",
  });

  await assert.rejects(api("/api/status"), (error: unknown) => {
    assert.equal((error as ApiErrorLike).status, 502);
    assert.match((error as Error).message, /firstmate bearings failed/);
    return true;
  });
});

test("a real 401 from the server opens the unauthorized path; a valid token succeeds", async () => {
  const { createApi, UNAUTHORIZED_MESSAGE } = await loadToken();
  const server = await startTestServer({ token: "correct-token" });
  try {
    let unauthorized = 0;
    const withToken = (token: string): ApiClient =>
      createApi({
        fetch: (path, init) => fetch(server.url + path, init as RequestInit),
        getToken: () => token,
        onUnauthorized: () => {
          unauthorized += 1;
        },
      });

    await assert.rejects(withToken("wrong-token")("/api/status"), (error: unknown) => {
      assert.equal((error as ApiErrorLike).status, 401);
      assert.equal((error as Error).message, UNAUTHORIZED_MESSAGE);
      return true;
    });
    await assert.rejects(withToken("")("/api/status"), (error: unknown) => {
      assert.equal((error as ApiErrorLike).status, 401);
      return true;
    });
    assert.equal(unauthorized, 2);

    const payload = await withToken("correct-token")("/api/status");
    assert.equal(payload?.schema, "fm-bearings.v1");
  } finally {
    await server.close();
  }
});

function fakeStorage(initial: Record<string, string> = {}): TokenStorageLike & { entries: Map<string, string> } {
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
  const { TOKEN_KEY, LEGACY_TOKEN_KEY, readToken } = await loadToken();
  const storage = fakeStorage({ [TOKEN_KEY]: "new-token", [LEGACY_TOKEN_KEY]: "old-token" });

  assert.equal(readToken(storage), "new-token");
  assert.equal(storage.getItem(LEGACY_TOKEN_KEY), "old-token");
});

test("a token saved under the old key is returned and migrated to the new key", async () => {
  const { TOKEN_KEY, LEGACY_TOKEN_KEY, readToken } = await loadToken();
  const storage = fakeStorage({ [LEGACY_TOKEN_KEY]: "existing-token" });

  assert.equal(readToken(storage), "existing-token");
  assert.equal(storage.getItem(TOKEN_KEY), "existing-token");
  assert.equal(storage.getItem(LEGACY_TOKEN_KEY), null);
});

test("no saved token returns an empty string without writing anything", async () => {
  const { readToken } = await loadToken();
  const storage = fakeStorage();

  assert.equal(readToken(storage), "");
  assert.equal(storage.entries.size, 0);
});
