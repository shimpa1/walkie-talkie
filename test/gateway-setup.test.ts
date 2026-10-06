import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { CatalogError, credentialSlots, parseCatalog, validationOrigins, type Catalog } from "../src/catalog.js";
import { SESSION_COOKIE } from "../src/cookies.js";
import { confirmedModels, KeyChecker, listedModels } from "../src/key-check.js";
import { RateLimiter } from "../src/rate-limit.js";
import { Vault } from "../src/vault.js";
import {
  ORIGIN,
  readAudit,
  signIn,
  startFakeGithub,
  startFakeUpstream,
  startGateway,
  type FakeGithub,
  type FakeUpstream,
  type GatewayHarness,
} from "./gateway-helpers.js";

const ADMIN = { id: 1001, login: "captain" };
const ALICE = { id: 4004, login: "alice" };
const BOB = { id: 5005, login: "bob" };
const STATIC_OWNER = { id: 2002, login: "static-owner" };
/** The planted key: it must reach the provider, and nothing else, ever. */
const CANARY = `sk-canary-${randomBytes(12).toString("hex")}`;
const CANARY_GH = `github_pat_canary_${randomBytes(12).toString("hex")}`;
const KEYRING = `k1:${randomBytes(32).toString("base64")},k2:${randomBytes(32).toString("base64")}`;

interface ProviderRequest {
  path: string;
  headers: IncomingMessage["headers"];
}

/** Local stand-ins for provider APIs, recording every request that reaches them. */
interface FakeProviders {
  url: string;
  requests: ProviderRequest[];
  close: () => Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Each path behaves like one provider. Error bodies echo the presented key, as
 * some real providers do, to prove the gateway never passes them on.
 */
async function startFakeProviders(elsewhere: string): Promise<FakeProviders> {
  const requests: ProviderRequest[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://provider.invalid").pathname;
    requests.push({ path, headers: req.headers });
    const presented =
      String(req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? "") ||
      String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const echo = JSON.stringify({ error: { message: `Incorrect API key provided: ${presented}` } });
    if (path === "/anthropic/v1/models") {
      // Valid only for the canary, with the anthropic-version header.
      if (presented === `${CANARY}-haiku-only`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] }));
        return;
      }
      if (presented !== CANARY || req.headers["anthropic-version"] !== "2023-06-01") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(echo);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5-20260301" }, { id: "claude-haiku-4-5" }, { id: "other" }] }));
      return;
    }
    if (path === "/google/v1beta/models") {
      if (presented !== CANARY) {
        // Google answers a bad key with a 400 that names the reason.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: 400, message: `API key not valid: ${presented}`, details: [{ reason: "API_KEY_INVALID", domain: "googleapis.com" }] },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "models/gemini-pro" }] }));
      return;
    }
    if (path === "/google-busy/v1beta/models") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: presented, details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] } }));
      return;
    }
    if (path === "/paged/models") {
      // One page of several: "n" is on a later page.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m" }], has_more: true }));
      return;
    }
    if (path === "/openrouter/api/v1/key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { label: `key ${presented}` } }));
      return;
    }
    if (path === "/github/user") {
      res.writeHead(presented === CANARY_GH ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ login: "alice", message: presented }));
      return;
    }
    if (path === "/broken/models") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(echo);
      return;
    }
    if (path === "/forbidden/models") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(echo);
      return;
    }
    if (path === "/redirect/models") {
      res.writeHead(302, { location: `${elsewhere}/steal` });
      res.end();
      return;
    }
    if (path === "/slow/models") {
      // Never answers; the gateway's timeout must end the check.
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const url = await listen(server);
  return { url, requests, close: () => stop(server) };
}

/** A host the catalog does not name, which must never see a request. */
async function startAttacker(): Promise<FakeProviders> {
  const requests: ProviderRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const url = await listen(server);
  return { url, requests, close: () => stop(server) };
}

function testCatalog(providers: string): Catalog {
  return parseCatalog(
    {
      harnesses: [{ name: "opencode" }],
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          keyEnv: "ANTHROPIC_API_KEY",
          validate: { url: `${providers}/anthropic/v1/models`, auth: "x-api-key", headers: { "anthropic-version": "2023-06-01" } },
          models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
        },
        {
          id: "google",
          keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
          validate: { url: `${providers}/google/v1beta/models`, auth: "x-goog-api-key", invalidReason: "API_KEY_INVALID" },
          models: ["gemini-pro", "gemini-flash"],
        },
        {
          id: "google-busy",
          keyEnv: "GOOGLE_BUSY_API_KEY",
          validate: { url: `${providers}/google-busy/v1beta/models`, auth: "x-goog-api-key", invalidReason: "API_KEY_INVALID" },
          models: ["m"],
        },
        { id: "paged", keyEnv: "PAGED_API_KEY", validate: { url: `${providers}/paged/models`, auth: "bearer" }, models: ["m", "n"] },
        {
          id: "openrouter",
          keyEnv: "OPENROUTER_API_KEY",
          validate: { url: `${providers}/openrouter/api/v1/key`, auth: "bearer" },
          models: ["qwen/qwen3.8-27b", "anthropic/claude-sonnet-5.5"],
        },
        { id: "broken", keyEnv: "BROKEN_API_KEY", validate: { url: `${providers}/broken/models`, auth: "bearer" }, models: ["m"] },
        { id: "forbidden", keyEnv: "FORBIDDEN_API_KEY", validate: { url: `${providers}/forbidden/models`, auth: "bearer" }, models: ["m"] },
        { id: "redirect", keyEnv: "REDIRECT_API_KEY", validate: { url: `${providers}/redirect/models`, auth: "bearer" }, models: ["m"] },
        { id: "slow", keyEnv: "SLOW_API_KEY", validate: { url: `${providers}/slow/models`, auth: "bearer" }, models: ["m"] },
      ],
      github: { keyEnv: ["GH_TOKEN", "GITHUB_TOKEN"], validate: { url: `${providers}/github/user`, auth: "bearer" } },
    },
    { allowLoopbackHttp: true },
  );
}

interface World {
  github: FakeGithub;
  upstream: FakeUpstream;
  providers: FakeProviders;
  attacker: FakeProviders;
  gateway: GatewayHarness;
  vault: Vault;
  sessions: { admin: string; alice: string; bob: string; owner: string };
  /** Every response body the gateway sent in this test, to search for the canary. */
  bodies: string[];
  call: (session: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  close: () => Promise<void>;
}

async function world(): Promise<World> {
  const github = await startFakeGithub();
  const upstream = await startFakeUpstream("static");
  const attacker = await startAttacker();
  const providers = await startFakeProviders(attacker.url);
  const catalog = testCatalog(providers.url);
  const vault = Vault.fromSettings(KEYRING, "k1");
  const generous = (): RateLimiter => new RateLimiter({ capacity: 1000, refillPerMinute: 1000 });
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    staticTenants: [{ githubId: STATIC_OWNER.id, upstream: upstream.url, token: "static-token" }],
    catalog,
    vault,
    keyChecker: new KeyChecker({ allowedOrigins: validationOrigins(catalog), timeoutMs: 300 }),
    keyCheckLimits: { perUser: generous(), global: generous() },
    signInLimits: { perClient: generous(), global: generous() },
  });
  const bodies: string[] = [];
  const call: World["call"] = async (session, method, path, body, headers = {}) => {
    const write = method !== "GET" && method !== "HEAD";
    const response = await fetch(`${gateway.url}${path}`, {
      method,
      headers: {
        ...(session === null ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
        ...(write ? { origin: ORIGIN } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    bodies.push(text, JSON.stringify([...response.headers]));
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const admin = (await signIn(gateway, github, ADMIN)).session;
  const owner = (await signIn(gateway, github, STATIC_OWNER)).session;
  assert.ok(admin && owner);
  for (const login of [ALICE.login, BOB.login]) {
    assert.equal((await call(admin, "POST", "/api/admin/invites", { login })).status, 201);
  }
  const alice = (await signIn(gateway, github, ALICE)).session;
  const bob = (await signIn(gateway, github, BOB)).session;
  assert.ok(alice && bob);
  return {
    github,
    upstream,
    providers,
    attacker,
    gateway,
    vault,
    sessions: { admin, alice, bob, owner },
    bodies,
    call,
    close: async () => {
      await gateway.close();
      await providers.close();
      await attacker.close();
      await upstream.close();
      await github.close();
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("the catalog is served to a signed-in user without its validation URLs", async () => {
  const w = await world();
  try {
    assert.equal((await w.call(null, "GET", "/api/catalog")).status, 401);
    const response = await w.call(w.sessions.alice, "GET", "/api/catalog");
    assert.equal(response.status, 200);
    const catalog = (await json(response)).catalog as Record<string, unknown>;
    assert.deepEqual(catalog.harnesses, ["opencode"]);
    const providers = catalog.providers as Array<Record<string, unknown>>;
    assert.deepEqual(providers[0], {
      id: "anthropic",
      name: "Anthropic",
      key_name: "ANTHROPIC_API_KEY",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
    });
    assert.deepEqual(catalog.github, { key_name: "GH_TOKEN" });
    assert.doesNotMatch(JSON.stringify(catalog), /127\.0\.0\.1|validate/);

    const session = await json(await w.call(w.sessions.alice, "GET", "/auth/session"));
    assert.deepEqual(session.user, { login: "alice", admin: false, firstmate: "none", firstmate_state: "none", setup: true });
    const owner = await json(await w.call(w.sessions.owner, "GET", "/auth/session"));
    assert.equal((owner.user as Record<string, unknown>).setup, false, "a static tenant is managed in configuration");
  } finally {
    await w.close();
  }
});

test("a valid key is checked once at the catalog host, sealed, and never readable again", async () => {
  const w = await world();
  try {
    const saved = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY });
    assert.equal(saved.status, 200);
    const body = await json(saved);
    assert.deepEqual(Object.keys(body.credential as object).sort(), ["added_at", "name", "provider", "status", "validated_at"]);
    assert.equal((body.credential as Record<string, unknown>).status, "valid");
    // The listing confirmed the dated snapshot of opus and haiku, not sonnet.
    assert.deepEqual(body.models, ["claude-opus-5-5", "claude-haiku-4-5"]);

    // Exactly one call, at the catalog's URL, with the key in the declared header.
    assert.equal(w.providers.requests.length, 1);
    const call = w.providers.requests[0];
    assert.equal(call?.path, "/anthropic/v1/models");
    assert.equal(call?.headers["x-api-key"], CANARY);
    assert.equal(call?.headers.authorization, undefined);
    assert.equal(call?.headers.cookie, undefined, "the user's session never reaches a provider");

    const listed = await json(await w.call(w.sessions.alice, "GET", "/api/me/credentials"));
    const credentials = listed.credentials as Array<Record<string, unknown>>;
    assert.equal(credentials.length, 1);
    assert.deepEqual(Object.keys(credentials[0] ?? {}).sort(), ["added_at", "name", "provider", "status", "validated_at"]);
    assert.equal(credentials[0]?.provider, "anthropic");

    // Stored sealed under the active key: the store has no plaintext.
    const user = w.gateway.store.userByGithubId(ALICE.id);
    assert.ok(user);
    w.gateway.closeStore();
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(w.gateway.config.gateway?.dbPath ?? "");
    const row = db.prepare("SELECT kid, sealed FROM credentials WHERE user_id = ?").get(user.id) as Record<string, unknown>;
    db.close();
    assert.equal(row.kid, "k1");
    assert.equal(w.vault.open(user.id, "ANTHROPIC_API_KEY", { kid: "k1", blob: row.sealed as Uint8Array }).toString(), CANARY);
    assert.equal(readFileSync(w.gateway.config.gateway?.dbPath ?? "").includes(CANARY), false);
  } finally {
    await w.close();
  }
});

test("a rejected key (401 or 403) is not stored and the provider's text never comes back", async () => {
  const w = await world();
  try {
    const rejected = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: `${CANARY}-wrong` });
    assert.equal(rejected.status, 422);
    assert.deepEqual(await json(rejected), { error: "key_rejected" });
    const forbidden = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/FORBIDDEN_API_KEY", { value: CANARY });
    assert.equal(forbidden.status, 422);
    assert.deepEqual((await json(await w.call(w.sessions.alice, "GET", "/api/me/credentials"))).credentials, []);
    const audit = await readAudit(w.gateway.config.gateway?.dbPath ?? "");
    assert.deepEqual(audit.find((entry) => entry.action === "credential.refused")?.detail, {
      name: "FORBIDDEN_API_KEY",
      provider: "forbidden",
      outcome: "invalid",
    });
  } finally {
    await w.close();
  }
});

test("a Google 400 naming API_KEY_INVALID rejects the key; any other 400 leaves it unverified; neither is stored", async () => {
  const w = await world();
  try {
    const rejected = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GOOGLE_GENERATIVE_AI_API_KEY", { value: `${CANARY}-wrong` });
    assert.equal(rejected.status, 422);
    assert.deepEqual(await json(rejected), { error: "key_rejected" });
    const other = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GOOGLE_BUSY_API_KEY", { value: CANARY });
    assert.equal(other.status, 502);
    assert.deepEqual(await json(other), { error: "provider_unreachable" });
    assert.deepEqual(w.bodies.filter((body) => body.includes(CANARY)), []);
    assert.deepEqual((await json(await w.call(w.sessions.alice, "GET", "/api/me/credentials"))).credentials, []);
    const valid = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GOOGLE_GENERATIVE_AI_API_KEY", { value: CANARY });
    assert.equal(valid.status, 200);
  } finally {
    await w.close();
  }
});

test("a paginated model listing does not restrict the model choice", async () => {
  const w = await world();
  try {
    const saved = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/PAGED_API_KEY", { value: CANARY });
    assert.equal(saved.status, 200);
    const chosen = await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "paged", model: "n" });
    assert.equal(chosen.status, 200);
  } finally {
    await w.close();
  }
});

test("a provider error, a timeout and a redirect leave the key unverified and unstored; a redirect is never followed", async () => {
  const w = await world();
  try {
    for (const name of ["BROKEN_API_KEY", "SLOW_API_KEY", "REDIRECT_API_KEY"]) {
      const response = await w.call(w.sessions.alice, "PUT", `/api/me/credentials/${name}`, { value: CANARY });
      assert.equal(response.status, 502, name);
      assert.deepEqual(await json(response), { error: "provider_unreachable" });
    }
    assert.deepEqual((await json(await w.call(w.sessions.alice, "GET", "/api/me/credentials"))).credentials, []);
    assert.deepEqual(w.attacker.requests, [], "the redirect target never saw the key");
  } finally {
    await w.close();
  }
});

test("only catalog hosts are ever called: a key cannot be sent anywhere a user names", async () => {
  const w = await world();
  try {
    // An unknown slot is refused before any outbound call.
    const unknown = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/EVIL_API_KEY", { value: CANARY });
    assert.equal(unknown.status, 404);
    // Extra fields that look like a target are ignored: the URL comes from the catalog.
    const smuggled = await w.call(
      w.sessions.alice,
      "PUT",
      "/api/me/credentials/OPENROUTER_API_KEY",
      { value: CANARY, url: `${w.attacker.url}/steal`, host: new URL(w.attacker.url).host },
      { host: new URL(w.attacker.url).host, "x-forwarded-host": new URL(w.attacker.url).host },
    );
    assert.equal(smuggled.status, 200);
    assert.deepEqual(w.providers.requests.map((request) => request.path), ["/openrouter/api/v1/key"]);
    assert.deepEqual(w.attacker.requests, []);

    // The checker itself refuses an origin the catalog does not declare.
    const checker = new KeyChecker({ allowedOrigins: new Set([new URL(w.providers.url).origin]) });
    const outcome = await checker.check({ url: `${w.attacker.url}/models`, auth: "bearer", headers: {}, invalidReason: null }, CANARY);
    assert.deepEqual(outcome, { status: "unverified" });
    assert.deepEqual(w.attacker.requests, []);
  } finally {
    await w.close();
  }
});

test("key values are bounded and never echoed back when malformed", async () => {
  const w = await world();
  try {
    for (const value of ["short", `${CANARY} with space`, `${CANARY}\n`, "x".repeat(513), 12345678, null]) {
      const response = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value });
      assert.equal(response.status, 400);
      assert.deepEqual(await json(response), { error: "invalid_key_format" });
    }
    assert.equal(w.providers.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("setup routes need a GitHub session, same-origin writes, and are refused for a static tenant", async () => {
  const w = await world();
  try {
    assert.equal((await w.call(null, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 401);
    const crossSite = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY }, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    const notJson = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", undefined, {
      "content-type": "text/plain",
    });
    assert.equal(notJson.status, 400);
    assert.equal((await w.call(w.sessions.alice, "POST", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 405);

    const owner = await w.call(w.sessions.owner, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY });
    assert.equal(owner.status, 409);
    assert.deepEqual(await json(owner), { error: "managed_by_config" });
    assert.deepEqual(await json(await w.call(w.sessions.owner, "GET", "/api/me/firstmate")), {
      managed: false,
      choice: null,
      setup: null,
    });
    assert.equal(w.providers.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("key checks are rate limited per user", async () => {
  const github = await startFakeGithub();
  const attacker = await startAttacker();
  const providers = await startFakeProviders(attacker.url);
  const catalog = testCatalog(providers.url);
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    catalog,
    vault: Vault.fromSettings(KEYRING, "k1"),
    keyChecker: new KeyChecker({ allowedOrigins: validationOrigins(catalog) }),
    keyCheckLimits: {
      perUser: new RateLimiter({ capacity: 2, refillPerMinute: 1 }),
      global: new RateLimiter({ capacity: 100, refillPerMinute: 100 }),
    },
  });
  try {
    const admin = (await signIn(gateway, github, ADMIN)).session ?? "";
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${gateway.url}/api/me/credentials/OPENROUTER_API_KEY`, {
        method: "PUT",
        headers: { cookie: `${SESSION_COOKIE}=${admin}`, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ value: CANARY }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.equal(providers.requests.length, 2);
  } finally {
    await gateway.close();
    await providers.close();
    await attacker.close();
    await github.close();
  }
});

test("a model choice comes from the catalog, needs the provider's key, and respects what the key can use", async () => {
  const w = await world();
  try {
    const empty = await json(await w.call(w.sessions.alice, "GET", "/api/me/firstmate"));
    assert.deepEqual(empty, {
      managed: true,
      choice: null,
      setup: { model_chosen: false, routine_chosen: false, key_saved: false, model_available: false, routine_available: false, ready: false },
      state: "none",
    });

    const choose = (body: unknown): Promise<Response> => w.call(w.sessions.alice, "PUT", "/api/me/firstmate", body);
    assert.deepEqual(await json(await choose({ provider: "nope", model: "x" })), { error: "unknown_provider" });
    assert.deepEqual(await json(await choose({ provider: "anthropic", model: "gpt-5" })), { error: "unknown_model" });
    assert.deepEqual(await json(await choose({ provider: "anthropic", model: "claude-opus-5-5", harness: "claude" })), {
      error: "unknown_harness",
    });
    const noKey = await choose({ provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(noKey.status, 409);
    assert.deepEqual(await json(noKey), { error: "key_required" });

    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 200);
    // The key's listing did not include sonnet.
    const unavailable = await choose({ provider: "anthropic", model: "claude-sonnet-5-5" });
    assert.equal(unavailable.status, 422);
    assert.deepEqual(await json(unavailable), { error: "model_unavailable" });
    assert.equal((await choose({ provider: "anthropic", model: "claude-opus-5-5", routine_model: "claude-sonnet-5-5" })).status, 422);

    const chosen = await choose({ provider: "anthropic", model: "claude-opus-5-5", routine_model: "claude-haiku-4-5" });
    assert.equal(chosen.status, 200);
    const view = await json(chosen);
    assert.deepEqual(view.setup, {
      model_chosen: true,
      routine_chosen: true,
      key_saved: true,
      model_available: true,
      routine_available: true,
      ready: true,
    });
    const choice = view.choice as Record<string, unknown>;
    assert.equal(choice.harness, "opencode");
    assert.equal(choice.model, "claude-opus-5-5");
    assert.equal(choice.routine_model, "claude-haiku-4-5");

    // OpenRouter lists no models for a key, so any catalog model is accepted.
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/OPENROUTER_API_KEY", { value: CANARY })).status, 200);
    assert.equal((await choose({ provider: "openrouter", model: "qwen/qwen3.8-27b" })).status, 200);

    // Deleting the key leaves the choice but marks setup incomplete.
    assert.equal((await w.call(w.sessions.alice, "DELETE", "/api/me/credentials/OPENROUTER_API_KEY")).status, 200);
    assert.equal((await w.call(w.sessions.alice, "DELETE", "/api/me/credentials/OPENROUTER_API_KEY")).status, 404);
    const after = await json(await w.call(w.sessions.alice, "GET", "/api/me/firstmate"));
    assert.deepEqual(after.setup, {
      model_chosen: true,
      routine_chosen: true,
      key_saved: false,
      model_available: false,
      routine_available: false,
      ready: false,
    });

    const actions = (await readAudit(w.gateway.config.gateway?.dbPath ?? "")).map((entry) => entry.action);
    for (const action of ["credential.saved", "credential.deleted", "firstmate.choice"]) assert.ok(actions.includes(action), action);
  } finally {
    await w.close();
  }
});

test("replacing a key with one that cannot use the chosen model makes setup not ready", async () => {
  const w = await world();
  try {
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 200);
    const chosen = await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(((await json(chosen)).setup as Record<string, unknown>).ready, true);

    const replaced = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: `${CANARY}-haiku-only` });
    assert.equal(replaced.status, 200);
    const view = await json(await w.call(w.sessions.alice, "GET", "/api/me/firstmate"));
    assert.deepEqual(view.setup, {
      model_chosen: true,
      routine_chosen: true,
      key_saved: true,
      model_available: false,
      routine_available: true,
      ready: false,
    });

    // The routine model counts too.
    assert.equal(
      (await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-haiku-4-5" })).status,
      200,
    );
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 200);
    assert.equal(
      (await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-haiku-4-5", routine_model: "claude-opus-5-5" })).status,
      200,
    );
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: `${CANARY}-haiku-only` })).status, 200);
    const routine = await json(await w.call(w.sessions.alice, "GET", "/api/me/firstmate"));
    assert.deepEqual(routine.setup, {
      model_chosen: true,
      routine_chosen: true,
      key_saved: true,
      model_available: true,
      routine_available: false,
      ready: false,
    });
  } finally {
    await w.close();
  }
});

test("a chosen model or routine model that leaves the catalog is reported as no longer offered", async () => {
  const w = await world();
  try {
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 200);
    const chosen = { provider: "anthropic", model: "claude-opus-5-5", routine_model: "claude-haiku-4-5" };
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", chosen)).status, 200);
    const dbPath = w.gateway.config.gateway?.dbPath ?? "";
    w.gateway.closeStore();

    const anthropic = testCatalog(w.providers.url).providers[0];
    assert.ok(anthropic);
    const narrowed = (models: string[]): Catalog => ({ ...testCatalog(w.providers.url), providers: [{ ...anthropic, models }] });
    const setupWith = async (catalog: Catalog): Promise<unknown> => {
      const gateway = await startGateway({
        github: w.github,
        admins: [ADMIN.id],
        dbPath,
        catalog,
        vault: w.vault,
        keyChecker: new KeyChecker({ allowedOrigins: validationOrigins(catalog) }),
      });
      try {
        const session = (await signIn(gateway, w.github, ALICE)).session ?? "";
        const response = await fetch(`${gateway.url}/api/me/firstmate`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
        return (await json(response)).setup;
      } finally {
        await gateway.close();
      }
    };
    assert.deepEqual(await setupWith(narrowed(["claude-haiku-4-5"])), {
      model_chosen: false,
      routine_chosen: true,
      key_saved: true,
      model_available: false,
      routine_available: true,
      ready: false,
    });
    assert.deepEqual(await setupWith(narrowed(["claude-opus-5-5"])), {
      model_chosen: true,
      routine_chosen: false,
      key_saved: true,
      model_available: true,
      routine_available: false,
      ready: false,
    });
  } finally {
    await w.close();
  }
});

test("each user sees and changes only their own credentials and choice", async () => {
  const w = await world();
  try {
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY })).status, 200);
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-opus-5-5" })).status, 200);

    assert.deepEqual((await json(await w.call(w.sessions.bob, "GET", "/api/me/credentials"))).credentials, []);
    assert.equal((await json(await w.call(w.sessions.bob, "GET", "/api/me/firstmate"))).choice, null);
    // Bob deleting "his" anthropic key touches nothing of Alice's.
    assert.equal((await w.call(w.sessions.bob, "DELETE", "/api/me/credentials/ANTHROPIC_API_KEY")).status, 404);
    assert.equal(((await json(await w.call(w.sessions.alice, "GET", "/api/me/credentials"))).credentials as unknown[]).length, 1);
    // Bob cannot choose a model on Alice's key.
    assert.equal((await w.call(w.sessions.bob, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-opus-5-5" })).status, 409);
  } finally {
    await w.close();
  }
});

test("the optional GitHub token is validated and stored the same way", async () => {
  const w = await world();
  try {
    const bad = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GH_TOKEN", { value: `${CANARY_GH}x` });
    assert.equal(bad.status, 422);
    const saved = await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GH_TOKEN", { value: CANARY_GH });
    assert.equal(saved.status, 200);
    const body = await json(saved);
    assert.equal((body.credential as Record<string, unknown>).provider, "github");
    assert.equal(body.models, null);
    assert.equal(w.providers.requests.at(-1)?.headers.authorization, `Bearer ${CANARY_GH}`);
    // The second delivery name is not a separate slot.
    assert.equal((await w.call(w.sessions.alice, "PUT", "/api/me/credentials/GITHUB_TOKEN", { value: CANARY_GH })).status, 404);
  } finally {
    await w.close();
  }
});

test("canary: a planted key never appears in any log line, response, audit entry or admin view", async () => {
  const w = await world();
  try {
    const { alice, admin } = w.sessions;
    // Entry, a failed validation, an unverified one, the GitHub token.
    await w.call(alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: CANARY });
    await w.call(alice, "PUT", "/api/me/credentials/ANTHROPIC_API_KEY", { value: `${CANARY}-bad` });
    await w.call(alice, "PUT", "/api/me/credentials/BROKEN_API_KEY", { value: CANARY });
    await w.call(alice, "PUT", "/api/me/credentials/OPENROUTER_API_KEY", { value: CANARY });
    await w.call(alice, "PUT", "/api/me/credentials/GH_TOKEN", { value: CANARY_GH });
    await w.call(alice, "PUT", "/api/me/firstmate", { provider: "anthropic", model: "claude-opus-5-5" });
    // Every read the user and the admin have.
    for (const path of ["/api/me/credentials", "/api/me/firstmate", "/api/catalog", "/auth/session", "/api/me/devices"]) {
      await w.call(alice, "GET", path);
    }
    for (const path of ["/api/admin/users", "/api/admin/audit", "/api/admin/requests", "/api/admin/invites"]) {
      assert.equal((await w.call(admin, "GET", path)).status, 200, path);
    }
    // Rotation, then deletion.
    assert.deepEqual(w.gateway.store.rotateCredentials(Vault.fromSettings(KEYRING, "k2")), { rotated: 3, current: 0 });
    await w.call(alice, "DELETE", "/api/me/credentials/ANTHROPIC_API_KEY");
    await w.call(alice, "GET", "/api/me/credentials");
    // An admin removing the user takes the rest.
    const users = (await json(await w.call(admin, "GET", "/api/admin/users"))).users as Array<Record<string, unknown>>;
    const aliceId = String(users.find((user) => user.login === "alice")?.id);
    assert.equal((await w.call(admin, "DELETE", `/api/admin/users/${aliceId}`)).status, 200);
    assert.deepEqual(w.gateway.store.listCredentials(aliceId), []);

    const audit = JSON.stringify(await readAudit(w.gateway.config.gateway?.dbPath ?? ""));
    const haystacks = { logs: w.gateway.logs.join("\n"), responses: w.bodies.join("\n"), audit };
    for (const [where, text] of Object.entries(haystacks)) {
      assert.equal(text.includes(CANARY), false, `the canary leaked into ${where}`);
      assert.equal(text.includes(CANARY_GH), false, `the GitHub canary leaked into ${where}`);
    }
    assert.ok(w.gateway.logs.some((line) => line.includes("credential saved")), "flows were logged, by id only");
  } finally {
    await w.close();
  }
});

test("setup routes are off without a catalog", async () => {
  const github = await startFakeGithub();
  const gateway = await startGateway({ github, admins: [ADMIN.id] });
  try {
    const session = (await signIn(gateway, github, ADMIN)).session ?? "";
    for (const path of ["/api/catalog", "/api/me/firstmate", "/api/me/credentials"]) {
      const response = await fetch(`${gateway.url}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
      assert.equal(response.status, 404, path);
    }
  } finally {
    await gateway.close();
    await github.close();
  }
});

// ---- catalog parsing and the checker's pieces ------------------------------

const GOOD = {
  harnesses: [{ name: "opencode" }],
  providers: [
    { id: "openai", keyEnv: "OPENAI_API_KEY", validate: { url: "https://api.openai.com/v1/models", auth: "bearer" }, models: ["gpt-5"] },
  ],
};

test("the catalog parser accepts the launch shape and refuses unsafe or ambiguous entries", () => {
  const catalog = parseCatalog(GOOD);
  assert.equal(catalog.providers[0]?.name, "openai", "the name defaults to the id");
  assert.equal(catalog.github, null);
  assert.deepEqual([...credentialSlots(catalog).keys()], ["OPENAI_API_KEY"]);

  const provider = GOOD.providers[0];
  const withProvider = (patch: Record<string, unknown>): unknown => ({ ...GOOD, providers: [{ ...provider, ...patch }] });
  const bad: Array<[unknown, RegExp]> = [
    [{ ...GOOD, harnesses: [] }, /harness/],
    [{ ...GOOD, providers: [] }, /at least one provider/],
    [{ ...GOOD, providers: [provider, provider] }, /used twice/],
    [{ ...GOOD, providers: [provider, { ...provider, keyEnv: "OTHER_KEY" }] }, /declared twice/],
    [withProvider({ id: "Open AI" }), /provider id/],
    [withProvider({ keyEnv: "lower" }), /environment variable/],
    [withProvider({ models: [] }), /at least one model/],
    [withProvider({ models: ["a", "a"] }), /listed twice/],
    [withProvider({ validate: { url: "http://api.openai.com/v1/models", auth: "bearer" } }), /https/],
    [withProvider({ validate: { url: "http://127.0.0.1:9/v1/models", auth: "bearer" } }), /https/],
    [withProvider({ validate: { url: "https://user:pw@api.openai.com/", auth: "bearer" } }), /credentials/],
    [withProvider({ validate: { url: "https://api.openai.com/", auth: "basic" } }), /auth must be/],
    [withProvider({ validate: { url: "https://api.openai.com/", auth: "bearer", headers: { Authorization: "x" } } }), /not an allowed header/],
    [withProvider({ validate: { url: "https://api.openai.com/", auth: "bearer", headers: { Host: "evil" } } }), /not an allowed header/],
    [withProvider({ validate: { url: "https://api.openai.com/", auth: "bearer", invalidReason: "bad reason" } }), /invalidReason/],
    [{ ...GOOD, github: { keyEnv: ["OPENAI_API_KEY"], validate: { url: "https://api.github.com/user", auth: "bearer" } } }, /used twice/],
  ];
  for (const [value, message] of bad) {
    assert.throws(() => parseCatalog(value), (error: unknown) => error instanceof CatalogError && message.test(error.message), JSON.stringify(value));
  }
  // Loopback http is a test-only option; a non-loopback http host is refused even then.
  assert.throws(
    () => parseCatalog(withProvider({ validate: { url: "http://evil.example/models", auth: "bearer" } }), { allowLoopbackHttp: true }),
    /https/,
  );
});

test("provider listings are read in both shapes and dated snapshots confirm an alias", () => {
  assert.deepEqual(listedModels(JSON.stringify({ data: [{ id: "a" }, { id: 5 }, null] })), ["a"]);
  assert.deepEqual(listedModels(JSON.stringify({ models: [{ name: "models/gemini-pro" }] })), ["gemini-pro"]);
  assert.equal(listedModels("not json"), null);
  assert.equal(listedModels(JSON.stringify({ data: { label: "x" } })), null);
  assert.equal(listedModels(null), null);
  assert.equal(listedModels(JSON.stringify({ data: [{ id: "a" }], has_more: true })), null);
  assert.deepEqual(listedModels(JSON.stringify({ data: [{ id: "a" }], has_more: false })), ["a"]);
  assert.equal(listedModels(JSON.stringify({ models: [{ name: "models/a" }], nextPageToken: "next" })), null);
  assert.deepEqual(listedModels(JSON.stringify({ models: [{ name: "models/a" }], nextPageToken: "" })), ["a"]);
  assert.deepEqual(confirmedModels(["m", "n", "o"], ["m", "n-20260101", "o-preview"]), ["m", "n"]);
  assert.equal(confirmedModels(["m"], null), null);
});
