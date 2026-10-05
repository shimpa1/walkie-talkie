import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";

import { LOGIN_COOKIE, SESSION_COOKIE } from "../src/cookies.js";
import { deviceLabel } from "../src/gateway.js";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../src/gateway-store.js";
import { clientAddress, RateLimiter } from "../src/rate-limit.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ORIGIN,
  readAudit,
  sessionHeaders,
  setCookie,
  signIn,
  startFakeGithub,
  startFakeUpstream,
  startGateway,
  type FakeGithub,
  type FakeUpstream,
  type GatewayHarness,
} from "./gateway-helpers.js";

const ADMIN = { id: 1001, login: "captain" };
const CREW = { id: 2002, login: "crew-member" };
const STRANGER = { id: 3003, login: "stranger" };
const ADMIN_TOKEN = "canary-tenant-token-admin-7d1e";
const CREW_TOKEN = "canary-tenant-token-crew-93ab";
const LEGACY_TOKEN = "canary-legacy-shared-token-41c0";

interface World {
  github: FakeGithub;
  adminUpstream: FakeUpstream;
  crewUpstream: FakeUpstream;
  gateway: GatewayHarness;
}

/** A gateway with an admin and a crew member, each owning one static tenant. */
async function world(
  options: {
    legacyBearer?: boolean;
    admins?: number[];
    proxyTimeoutMs?: number;
    signInLimits?: { perClient: RateLimiter; global: RateLimiter };
    accessRequests?: boolean;
  } = {},
): Promise<World & { close: () => Promise<void> }> {
  const github = await startFakeGithub();
  const adminUpstream = await startFakeUpstream("admin");
  const crewUpstream = await startFakeUpstream("crew");
  const gateway = await startGateway({
    github,
    admins: options.admins ?? [ADMIN.id],
    staticTenants: [
      { githubId: ADMIN.id, upstream: adminUpstream.url, token: ADMIN_TOKEN },
      { githubId: CREW.id, upstream: crewUpstream.url, token: CREW_TOKEN },
    ],
    legacyBearer: options.legacyBearer ?? false,
    token: options.legacyBearer ? LEGACY_TOKEN : "",
    ...(options.proxyTimeoutMs !== undefined ? { proxyTimeoutMs: options.proxyTimeoutMs } : {}),
    ...(options.signInLimits !== undefined ? { signInLimits: options.signInLimits } : {}),
    ...(options.accessRequests !== undefined ? { accessRequests: options.accessRequests } : {}),
  });
  return {
    github,
    adminUpstream,
    crewUpstream,
    gateway,
    close: async () => {
      await gateway.close();
      await adminUpstream.close();
      await crewUpstream.close();
      await github.close();
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("the gateway's own health is open and carries no firstmate data", async () => {
  const w = await world();
  try {
    const response = await fetch(`${w.gateway.url}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { ok: true });
    assert.equal(w.adminUpstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("the session probe reports gateway mode and a signed-out visitor", async () => {
  const w = await world({ legacyBearer: true });
  try {
    const response = await fetch(`${w.gateway.url}/auth/session`);
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      schema: "walkie-talkie-session.v1",
      mode: "gateway",
      signed_in: false,
      user: null,
      legacy_bearer: true,
    });
  } finally {
    await w.close();
  }
});

test("sign-in starts at GitHub with state, an S256 PKCE challenge, no scope, and no sign-up", async () => {
  const w = await world();
  try {
    const start = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("cache-control"), "no-store");
    const location = new URL(start.headers.get("location") ?? "");
    assert.equal(`${location.origin}${location.pathname}`, `${w.github.url}/login/oauth/authorize`);
    assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/auth/github/callback`);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.match(location.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.ok((location.searchParams.get("state") ?? "").length >= 40);
    assert.equal(location.searchParams.get("allow_signup"), "false");
    assert.equal(location.searchParams.has("scope"), false);

    const cookie = setCookie(start, LOGIN_COOKIE) ?? "";
    assert.match(cookie, /^__Host-wt_login=[A-Za-z0-9_-]{40,}; /);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) {
      assert.ok(cookie.includes(attribute), `login cookie has ${attribute}: ${cookie}`);
    }
    assert.ok(!cookie.includes("Domain"), "a __Host- cookie has no Domain");
  } finally {
    await w.close();
  }
});

test("a declared admin signs in, gets a __Host- session cookie, and is reported as admin", async () => {
  const w = await world();
  try {
    const result = await signIn(w.gateway, w.github, ADMIN);
    assert.equal(result.callback.status, 302);
    assert.equal(result.location, "/");
    assert.equal(result.callback.headers.get("referrer-policy"), "no-referrer");
    assert.ok(result.session !== null && result.session.length >= 40);

    const cookie = setCookie(result.callback, SESSION_COOKIE) ?? "";
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`]) {
      assert.ok(cookie.includes(attribute), `session cookie has ${attribute}: ${cookie}`);
    }
    assert.match(setCookie(result.callback, LOGIN_COOKIE) ?? "", /Max-Age=0/, "the pre-auth cookie is cleared");

    const [exchange] = w.github.exchanges;
    assert.ok(exchange);
    assert.equal(exchange.clientId, CLIENT_ID);
    assert.equal(exchange.clientSecret, CLIENT_SECRET);
    assert.equal(exchange.redirectUri, `${ORIGIN}/auth/github/callback`);
    assert.match(exchange.codeVerifier ?? "", /^[A-Za-z0-9_-]{43}$/);

    const session = await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(result.session ?? "") });
    assert.deepEqual(await json(session), {
      schema: "walkie-talkie-session.v1",
      mode: "gateway",
      signed_in: true,
      user: { login: "captain", admin: true, firstmate: "ready", setup: false },
      legacy_bearer: false,
    });

    const user = w.gateway.store.userByGithubId(ADMIN.id);
    assert.equal(user?.login, "captain");
    const actions = (await readAudit(w.gateway.config.gateway?.dbPath ?? "")).map((entry) => entry.action);
    assert.deepEqual(actions.sort(), ["signin", "user.created"]);
  } finally {
    await w.close();
  }
});

test("a declared tenant owner who is not an admin signs in as a plain user", async () => {
  const w = await world();
  try {
    const result = await signIn(w.gateway, w.github, CREW);
    assert.ok(result.session);
    const session = await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(result.session) }));
    assert.deepEqual(session.user, { login: "crew-member", admin: false, firstmate: "ready", setup: false });
  } finally {
    await w.close();
  }
});

test("a GitHub login rename is picked up, but identity stays the numeric id", async () => {
  const w = await world();
  try {
    await signIn(w.gateway, w.github, ADMIN);
    const renamed = await signIn(w.gateway, w.github, { id: ADMIN.id, login: "captain-renamed" });
    assert.ok(renamed.session);
    assert.equal(w.gateway.store.userByGithubId(ADMIN.id)?.login, "captain-renamed");

    // Someone who takes over the old login has a different id and gets nowhere.
    const squatter = await signIn(w.gateway, w.github, { id: 9999, login: "captain" });
    assert.equal(squatter.session, null);
    assert.equal(squatter.location, "/?signin=pending", "at most, they wait for the admin like any stranger");
  } finally {
    await w.close();
  }
});

test("in strict invite-only mode an account nobody declared or invited is refused and nothing is created for it", async () => {
  const w = await world({ accessRequests: false });
  try {
    const result = await signIn(w.gateway, w.github, STRANGER);
    assert.equal(result.callback.status, 302);
    assert.equal(result.location, "/?signin=not_invited");
    assert.equal(result.session, null);
    assert.equal(w.gateway.store.userByGithubId(STRANGER.id), null);
    const [entry] = await readAudit(w.gateway.config.gateway?.dbPath ?? "");
    assert.equal(entry?.action, "signin.refused");
    assert.deepEqual(entry?.detail, { github_id: STRANGER.id, reason: "not_invited" });
  } finally {
    await w.close();
  }
});

test("a callback whose state does not match is refused, and the attempt cannot be replayed", async () => {
  const w = await world();
  try {
    const start = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location") ?? "");
    const loginCookie = (setCookie(start, LOGIN_COOKIE) ?? "").split(";")[0] ?? "";
    const code = w.github.issue(ADMIN, authorize.searchParams.get("code_challenge") ?? "");

    const forged = await fetch(`${w.gateway.url}/auth/github/callback?code=${code}&state=forged`, {
      redirect: "manual",
      headers: { cookie: loginCookie },
    });
    assert.equal(forged.headers.get("location"), "/?signin=expired");
    assert.equal(setCookie(forged, SESSION_COOKIE), null);

    const replay = await fetch(
      `${w.gateway.url}/auth/github/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { cookie: loginCookie } },
    );
    assert.equal(replay.headers.get("location"), "/?signin=expired", "a consumed attempt is gone");
    assert.equal(setCookie(replay, SESSION_COOKIE), null);
    assert.equal(w.github.exchanges.length, 0, "no code is exchanged without a matching attempt");
  } finally {
    await w.close();
  }
});

test("a callback without the pre-auth cookie (another browser) is refused", async () => {
  const w = await world();
  try {
    const result = await signIn(w.gateway, w.github, ADMIN, { cookie: null });
    assert.equal(result.location, "/?signin=expired");
    assert.equal(result.session, null);
  } finally {
    await w.close();
  }
});

test("a sign-in attempt expires after ten minutes", async () => {
  const w = await world();
  try {
    const start = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location") ?? "");
    const loginCookie = (setCookie(start, LOGIN_COOKIE) ?? "").split(";")[0] ?? "";
    const code = w.github.issue(ADMIN, authorize.searchParams.get("code_challenge") ?? "");
    w.gateway.advance(10 * 60 * 1000 + 1);
    const late = await fetch(
      `${w.gateway.url}/auth/github/callback?code=${code}&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { cookie: loginCookie } },
    );
    assert.equal(late.headers.get("location"), "/?signin=expired");
  } finally {
    await w.close();
  }
});

test("cancelling at GitHub reads as denied", async () => {
  const w = await world();
  try {
    const start = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("location") ?? "");
    const loginCookie = (setCookie(start, LOGIN_COOKIE) ?? "").split(";")[0] ?? "";
    const denied = await fetch(
      `${w.gateway.url}/auth/github/callback?error=access_denied&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { cookie: loginCookie } },
    );
    assert.equal(denied.headers.get("location"), "/?signin=denied");
    assert.equal(setCookie(denied, SESSION_COOKIE), null);
  } finally {
    await w.close();
  }
});

test("a code GitHub rejects fails the sign-in without echoing GitHub's error text", async () => {
  const w = await world();
  try {
    const result = await signIn(w.gateway, w.github, ADMIN, { code: "not-a-real-code" });
    assert.equal(result.location, "/?signin=failed");
    assert.equal(result.session, null);
    assert.ok(w.gateway.logs.some((line) => line.startsWith("github sign-in failed")));
    assert.ok(!w.gateway.logs.join("\n").includes("not-a-real-code"), "the code is never logged");
    assert.ok(!w.gateway.logs.join("\n").includes("leaky"), "GitHub's error body is never logged");
  } finally {
    await w.close();
  }
});

test("a profile read GitHub refuses fails the sign-in", async () => {
  const w = await world();
  try {
    w.github.failUser(500);
    const result = await signIn(w.gateway, w.github, ADMIN);
    assert.equal(result.location, "/?signin=failed");
    assert.equal(result.session, null);
  } finally {
    await w.close();
  }
});

test("a signed-in call reaches only the caller's own firstmate, with the tenant token and no browser credentials", async () => {
  const w = await world();
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);
    const response = await fetch(`${w.gateway.url}/api/status?x=1`, {
      headers: sessionHeaders(session, {
        authorization: "Bearer someone-elses-token",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.example",
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { upstream: "admin", path: "/api/status?x=1" });
    assert.equal(response.headers.get("set-cookie"), null, "an upstream cannot set a cookie on the gateway");
    assert.equal(response.headers.get("x-upstream-secret"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const [forwarded] = w.adminUpstream.requests;
    assert.ok(forwarded);
    assert.equal(forwarded.headers.authorization, `Bearer ${ADMIN_TOKEN}`);
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers["x-forwarded-for"], undefined);
    assert.equal(forwarded.headers["x-forwarded-host"], undefined);
    assert.equal(w.crewUpstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("two users are routed to their own firstmates and nothing in a request can redirect one to the other", async () => {
  const w = await world();
  try {
    const admin = await signIn(w.gateway, w.github, ADMIN);
    const crew = await signIn(w.gateway, w.github, CREW);
    assert.ok(admin.session && crew.session);

    const tricks = [
      `/api/sessions?upstream=${encodeURIComponent(w.adminUpstream.url)}`,
      "/api/receipts?user=1001",
      "/api/firstmate",
    ];
    for (const path of tricks) {
      const response = await fetch(`${w.gateway.url}${path}`, {
        headers: sessionHeaders(crew.session, { host: new URL(w.adminUpstream.url).host }),
      });
      assert.equal(response.status, 200, path);
      assert.equal((await json(response)).upstream, "crew", `${path} stays on the caller's own firstmate`);
    }
    assert.equal(w.adminUpstream.requests.length, 0);
    for (const request of w.crewUpstream.requests) {
      assert.equal(request.headers.authorization, `Bearer ${CREW_TOKEN}`);
    }

    const mine = await fetch(`${w.gateway.url}/api/firstmate`, { headers: sessionHeaders(admin.session) });
    assert.equal((await json(mine)).upstream, "admin");
  } finally {
    await w.close();
  }
});

test("only the firstmate API is proxied: other paths and methods stop at the gateway", async () => {
  const w = await world();
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);
    const notFound = ["/api/firstmate/x", "/api/sessions/w1:p1/extra", "/api/push/config/x", "/api/statusx"];
    for (const path of notFound) {
      const response = await fetch(`${w.gateway.url}${path}`, { headers: sessionHeaders(session) });
      assert.equal(response.status, 404, path);
    }
    const wrongMethod = await fetch(`${w.gateway.url}/api/note`, {
      method: "DELETE",
      headers: sessionHeaders(session, { origin: ORIGIN }),
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(w.adminUpstream.requests.length, 0);

    // A dot-segment path is normalized before the allowlist sees it.
    const normalized = await fetch(`${w.gateway.url}/api/receipts/../status`, { headers: sessionHeaders(session) });
    assert.equal(normalized.status, 200);
    assert.equal(w.adminUpstream.requests[0]?.url, "/api/status");

    const detail = await fetch(`${w.gateway.url}/api/sessions/w1%3Ap1?limit=5`, { headers: sessionHeaders(session) });
    assert.equal(detail.status, 200);
    assert.equal(w.adminUpstream.requests[1]?.url, "/api/sessions/w1%3Ap1?limit=5");
  } finally {
    await w.close();
  }
});

test("a cookie-authenticated write must come from the app's own origin", async () => {
  const w = await world();
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);
    const body = JSON.stringify({ text: "hello", requestId: "phone-1" });
    const post = (headers: Record<string, string>): Promise<Response> =>
      fetch(`${w.gateway.url}/api/note`, {
        method: "POST",
        headers: sessionHeaders(session, { "content-type": "application/json", ...headers }),
        body,
      });

    assert.equal((await post({})).status, 403, "no Origin and no Sec-Fetch-Site");
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(w.adminUpstream.requests.length, 0);

    const ok = await post({ origin: ORIGIN });
    assert.equal(ok.status, 200);
    const sameSite = await post({ "sec-fetch-site": "same-origin" });
    assert.equal(sameSite.status, 200);

    const [forwarded] = w.adminUpstream.requests;
    assert.equal(forwarded?.method, "POST");
    assert.equal(forwarded?.body, body);
    assert.equal(forwarded?.headers["content-type"], "application/json");
    assert.equal(forwarded?.headers.origin, undefined);
  } finally {
    await w.close();
  }
});

test("an oversized note is refused at the gateway", async () => {
  const w = await world();
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);
    const response = await fetch(`${w.gateway.url}/api/note`, {
      method: "POST",
      headers: sessionHeaders(session, { "content-type": "application/json", origin: ORIGIN }),
      body: JSON.stringify({ text: "x".repeat(64 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(w.adminUpstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("a visitor without a session gets signed_out, never a firstmate", async () => {
  const w = await world();
  try {
    const attempts: Array<Record<string, string>> = [
      {},
      { cookie: `${SESSION_COOKIE}=forged-session-id` },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    ];
    for (const headers of attempts) {
      const response = await fetch(`${w.gateway.url}/api/status`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await json(response), { error: "signed_out" });
    }
    assert.equal(w.adminUpstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("an admin with no firstmate yet is told so instead of being routed anywhere", async () => {
  const w = await world({ admins: [ADMIN.id, 4004] });
  try {
    const { session } = await signIn(w.gateway, w.github, { id: 4004, login: "second-admin" });
    assert.ok(session);
    const info = await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(session) }));
    assert.deepEqual(info.user, { login: "second-admin", admin: true, firstmate: "none", setup: false });
    const response = await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    assert.equal(response.status, 409);
    assert.deepEqual(await json(response), { error: "firstmate_not_provisioned" });
  } finally {
    await w.close();
  }
});

test("a firstmate that refuses the gateway's token, is down, or hangs surfaces as a gateway error, not a sign-out", async () => {
  const w = await world({ proxyTimeoutMs: 200 });
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);

    w.adminUpstream.respond((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    const refused = await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    assert.equal(refused.status, 502);

    w.adminUpstream.respond(() => {
      // Never answer.
    });
    const hung = await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    assert.equal(hung.status, 504);

    await w.adminUpstream.close();
    const down = await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    assert.equal(down.status, 502);
    assert.deepEqual(await json(down), { error: "your firstmate is not reachable" });
  } finally {
    await w.close();
  }
});

test("the legacy bridge accepts the retiring shared token as the first admin, flagged deprecated", async () => {
  const w = await world({ legacyBearer: true });
  try {
    const read = await fetch(`${w.gateway.url}/api/status`, { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } });
    assert.equal(read.status, 200);
    assert.equal((await json(read)).upstream, "admin");
    assert.equal(read.headers.get("x-wt-legacy-auth"), "deprecated");
    assert.equal(w.adminUpstream.requests[0]?.headers.authorization, `Bearer ${ADMIN_TOKEN}`);

    // A header token cannot be sent cross-site, so a write needs no Origin.
    const write = await fetch(`${w.gateway.url}/api/note`, {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(write.status, 200);

    const wrong = await fetch(`${w.gateway.url}/api/status`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    assert.equal(w.crewUpstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("with the legacy bridge off the shared token opens nothing", async () => {
  const github = await startFakeGithub();
  const upstream = await startFakeUpstream("admin");
  const gateway = await startGateway({
    github,
    staticTenants: [{ githubId: 1001, upstream: upstream.url, token: ADMIN_TOKEN }],
    legacyBearer: false,
    token: LEGACY_TOKEN,
  });
  try {
    const response = await fetch(`${gateway.url}/api/status`, { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } });
    assert.equal(response.status, 401);
    assert.equal(upstream.requests.length, 0);
  } finally {
    await gateway.close();
    await upstream.close();
    await github.close();
  }
});

test("sign-out needs the app's origin, ends the session, and clears the cookie", async () => {
  const w = await world();
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);

    const crossSite = await fetch(`${w.gateway.url}/auth/logout`, {
      method: "POST",
      headers: sessionHeaders(session, { origin: "https://evil.example" }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) })).status, 200);

    const out = await fetch(`${w.gateway.url}/auth/logout`, {
      method: "POST",
      headers: sessionHeaders(session, { origin: ORIGIN }),
    });
    assert.equal(out.status, 200);
    assert.match(setCookie(out, SESSION_COOKIE) ?? "", /Max-Age=0/);
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) })).status, 401);
    assert.ok((await readAudit(w.gateway.config.gateway?.dbPath ?? "")).some((entry) => entry.action === "signout"));
  } finally {
    await w.close();
  }
});

test("a session ends after 30 idle days, and after 90 days however active", async () => {
  const w = await world();
  try {
    const idle = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(idle.session);
    w.gateway.advance(SESSION_IDLE_MS - 60_000);
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(idle.session) })).status, 200);
    w.gateway.advance(SESSION_IDLE_MS - 60_000);
    assert.equal(
      (await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(idle.session) })).status,
      200,
      "use slides the idle window",
    );
    w.gateway.advance(SESSION_IDLE_MS);
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(idle.session) })).status, 401);

    const busy = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(busy.session);
    for (let day = 0; day < 89; day += 1) {
      w.gateway.advance(24 * 60 * 60 * 1000);
      await fetch(`${w.gateway.url}/api/health`, { headers: sessionHeaders(busy.session) });
    }
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(busy.session) })).status, 200);
    w.gateway.advance(24 * 60 * 60 * 1000);
    assert.equal((await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(busy.session) })).status, 401);
  } finally {
    await w.close();
  }
});

test("sign-in is rate-limited per client", async () => {
  let clock = 0;
  const now = (): number => clock;
  const w = await world({
    signInLimits: {
      perClient: new RateLimiter({ capacity: 3, refillPerMinute: 3, now }),
      global: new RateLimiter({ capacity: 100, refillPerMinute: 100, now }),
    },
  });
  try {
    const locations: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const start = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
      locations.push(start.headers.get("location") ?? "");
    }
    assert.ok(locations.slice(0, 3).every((location) => location.startsWith(w.github.url)));
    assert.equal(locations[3], "/?signin=busy");
    clock += 60_000;
    const later = await fetch(`${w.gateway.url}/auth/github/start`, { redirect: "manual" });
    assert.ok((later.headers.get("location") ?? "").startsWith(w.github.url), "the bucket refills");
  } finally {
    await w.close();
  }
});

test("no secret ever reaches a log line, the audit log, or the database file", async () => {
  const w = await world({ legacyBearer: true });
  try {
    const { session } = await signIn(w.gateway, w.github, ADMIN);
    assert.ok(session);
    await signIn(w.gateway, w.github, STRANGER);
    await signIn(w.gateway, w.github, ADMIN, { code: "canary-bad-code" });
    await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    await fetch(`${w.gateway.url}/api/status`, { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } });
    w.adminUpstream.respond((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });

    const secrets = [CLIENT_SECRET, ADMIN_TOKEN, CREW_TOKEN, LEGACY_TOKEN, session, "canary-bad-code", ...w.github.issuedTokens];
    for (const exchange of w.github.exchanges) {
      if (exchange.code) secrets.push(exchange.code);
      if (exchange.codeVerifier) secrets.push(exchange.codeVerifier);
    }
    const logs = w.gateway.logs.join("\n");
    const audit = JSON.stringify(await readAudit(w.gateway.config.gateway?.dbPath ?? ""));
    w.gateway.closeStore();
    const dbBytes = readFileSync(w.gateway.config.gateway?.dbPath ?? "").toString("latin1");
    for (const secret of secrets) {
      assert.ok(!logs.includes(secret), "a secret reached the log");
      assert.ok(!audit.includes(secret), "a secret reached the audit log");
      assert.ok(!dbBytes.includes(secret), "a secret reached the database file");
    }
  } finally {
    await w.close();
  }
});

test("the web app is served to everyone, and only for reads", async () => {
  const w = await world();
  try {
    const page = await fetch(`${w.gateway.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in with GitHub/);
    const post = await fetch(`${w.gateway.url}/index.html`, { method: "POST" });
    assert.equal(post.status, 405);
    const unknownAuth = await fetch(`${w.gateway.url}/auth/other`);
    assert.equal(unknownAuth.status, 404);
  } finally {
    await w.close();
  }
});

test("the client address trusts X-Forwarded-For only as far as the declared proxy hops", () => {
  const req = (xff: string | undefined, peer = "10.0.0.9"): IncomingMessage =>
    ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  assert.equal(clientAddress(req("1.2.3.4"), 0), "10.0.0.9", "no trusted hop: the socket peer");
  assert.equal(clientAddress(req("6.6.6.6, 1.2.3.4"), 1), "1.2.3.4", "a spoofed left entry is ignored");
  assert.equal(clientAddress(req("6.6.6.6, 1.2.3.4, 10.1.1.1"), 2), "1.2.3.4");
  assert.equal(clientAddress(req("1.2.3.4"), 2), "10.0.0.9", "too few entries falls back to the peer");
  assert.equal(clientAddress(req(undefined), 1), "10.0.0.9");
});

test("the device label is a coarse family, never the full User-Agent", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "Mac");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 15)"), "Android");
  assert.equal(deviceLabel(undefined), "Browser");
});
