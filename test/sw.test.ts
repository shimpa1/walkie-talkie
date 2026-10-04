import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { REPO_ROOT } from "./helpers.js";

const ORIGIN = "https://walkie.example";
const SOURCE = readFileSync(join(REPO_ROOT, "public", "sw.js"), "utf8");

type Network = (url: string) => Promise<Response>;

interface Worker {
  /** Every network fetch the worker made, with the HTTP cache mode it asked for. */
  calls: Array<{ path: string; cache: string }>;
  install: () => Promise<void>;
  /** Dispatch a GET; undefined when the worker leaves the request to the browser. */
  get: (path: string) => Promise<Response | undefined>;
  cached: (path: string) => Promise<string | undefined>;
  setNetwork: (next: Network) => void;
}

/** Run public/sw.js against an in-memory Cache Storage and a scripted network. */
function loadWorker(initial: Network): Worker {
  let network = initial;
  const handlers = new Map<string, (event: unknown) => void>();
  const store = new Map<string, Response>();
  const calls: Worker["calls"] = [];
  const pathOf = (input: { url: string } | string): string =>
    new URL(typeof input === "string" ? input : input.url, ORIGIN).pathname;
  const cache = {
    addAll: async (requests: Request[]) => {
      for (const request of requests) {
        calls.push({ path: pathOf(request), cache: request.cache });
        store.set(pathOf(request), await network(request.url));
      }
    },
    put: async (request: { url: string }, response: Response) => {
      store.set(pathOf(request), response);
    },
  };
  const context = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
      match: async (request: { url: string }) => store.get(pathOf(request))?.clone(),
    },
    fetch: (url: string, init?: { cache?: string }) => {
      calls.push({ path: pathOf(url), cache: init?.cache ?? "default" });
      return network(new URL(url, ORIGIN).href);
    },
    Request: class extends Request {
      constructor(input: string, init?: RequestInit & { cache?: string }) {
        super(new URL(input, ORIGIN).href, init);
      }
    },
    Response,
    URL,
    Promise,
  };
  runInNewContext(SOURCE, context);

  return {
    calls,
    install: async () => {
      let pending: Promise<unknown> = Promise.resolve();
      handlers.get("install")!({ waitUntil: (promise: Promise<unknown>) => (pending = promise) });
      await pending;
    },
    get: async (path) => {
      let responded: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: { method: "GET", url: new URL(path, ORIGIN).href },
        respondWith: (promise: Promise<Response>) => (responded = promise),
      });
      return responded ? await responded : undefined;
    },
    cached: async (path) => store.get(path)?.clone().text(),
    setNetwork: (next) => {
      network = next;
    },
  };
}

const serve =
  (body: string, status = 200): Network =>
  async () =>
    new Response(body, { status });

test("a new worker stores the shell from the server, never from the HTTP cache", async () => {
  const worker = loadWorker(serve("deployed"));
  await worker.install();
  assert.ok(worker.calls.some((call) => call.path === "/app.js"), "app.js is part of the shell");
  for (const call of worker.calls) assert.equal(call.cache, "reload", `${call.path} bypasses the HTTP cache`);
});

test("a launch after a deploy runs the deployed shell rather than the one cached before it", async () => {
  const worker = loadWorker(serve("old app.js"));
  await worker.install();
  worker.calls.length = 0;

  worker.setNetwork(serve("new app.js"));
  const response = await worker.get("/app.js");
  assert.equal(await response!.text(), "new app.js");
  assert.deepEqual(worker.calls, [{ path: "/app.js", cache: "no-cache" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await worker.cached("/app.js"), "new app.js", "the fresh copy replaces the cached one");
});

test("the cached shell still answers when the network is down or the server errors", async () => {
  const worker = loadWorker(serve("cached app.js"));
  await worker.install();

  worker.setNetwork(async () => {
    throw new TypeError("Load failed");
  });
  assert.equal(await (await worker.get("/app.js"))!.text(), "cached app.js");

  worker.setNetwork(serve("bad gateway", 502));
  assert.equal(await (await worker.get("/app.js"))!.text(), "cached app.js");
  assert.equal(await worker.cached("/app.js"), "cached app.js");
});

test("API reads are left to the browser", async () => {
  const worker = loadWorker(serve("{}"));
  assert.equal(await worker.get("/api/status"), undefined);
});

test("sign-in routes are left to the browser so the GitHub redirects are never cached", async () => {
  const worker = loadWorker(serve("redirect"));
  for (const path of ["/auth/github/start", "/auth/github/callback?code=c&state=s", "/auth/session"]) {
    assert.equal(await worker.get(path), undefined, path);
  }
  assert.equal(worker.calls.length, 0);
});
