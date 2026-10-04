import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";

import { SESSION_COOKIE } from "../src/cookies.js";
import {
  ACCESS_REQUEST_MS,
  GatewayStore,
  INVITE_MS,
  LINK_CODE_ALPHABET,
  LINK_CODE_MS,
  MAX_PENDING_ACCESS_REQUESTS,
  newLinkCode,
  normalizeLinkCode,
} from "../src/gateway-store.js";
import { RateLimiter } from "../src/rate-limit.js";
import {
  cookieValue,
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
const NEWCOMER = { id: 5005, login: "Newcomer" };
const STRANGER = { id: 3003, login: "stranger" };
const ADMIN_TOKEN = "tenant-token-admin";
const CREW_TOKEN = "tenant-token-crew";
const LEGACY_TOKEN = "legacy-shared-token";
const DAY = 24 * 60 * 60 * 1000;

interface World {
  github: FakeGithub;
  upstream: FakeUpstream;
  gateway: GatewayHarness;
  admin: string;
  /** Call the gateway as `session`; writes carry the app's own Origin. */
  call: (session: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  close: () => Promise<void>;
}

/** An admin (signed in) and a crew member, each owning a static tenant. */
async function world(options: { accessRequests?: boolean; linkLimits?: { perClient: RateLimiter; global: RateLimiter } } = {}): Promise<World> {
  const github = await startFakeGithub();
  const upstream = await startFakeUpstream("tenant");
  const gateway = await startGateway({
    github,
    admins: [ADMIN.id],
    staticTenants: [
      { githubId: ADMIN.id, upstream: upstream.url, token: ADMIN_TOKEN },
      { githubId: CREW.id, upstream: upstream.url, token: CREW_TOKEN },
    ],
    legacyBearer: true,
    token: LEGACY_TOKEN,
    ...(options.accessRequests !== undefined ? { accessRequests: options.accessRequests } : {}),
    ...(options.linkLimits !== undefined ? { linkLimits: options.linkLimits } : {}),
    // These tests sign in many times from one address; the limit has its own test.
    signInLimits: {
      perClient: new RateLimiter({ capacity: 1000, refillPerMinute: 1000 }),
      global: new RateLimiter({ capacity: 1000, refillPerMinute: 1000 }),
    },
  });
  const admin = (await signIn(gateway, github, ADMIN)).session;
  assert.ok(admin);
  const call: World["call"] = (session, method, path, body, headers = {}) => {
    const write = method !== "GET" && method !== "HEAD";
    return fetch(`${gateway.url}${path}`, {
      method,
      headers: {
        ...(session === null ? {} : { cookie: `${SESSION_COOKIE}=${session}` }),
        ...(write ? { origin: ORIGIN } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  return {
    github,
    upstream,
    gateway,
    admin,
    call,
    close: async () => {
      await gateway.close();
      await upstream.close();
      await github.close();
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function auditActions(w: World): Promise<string[]> {
  return (await readAudit(w.gateway.config.gateway?.dbPath ?? "")).map((entry) => entry.action);
}

test("an invited GitHub login signs in once, which pins its account and spends the invite", async () => {
  const w = await world();
  try {
    const created = await w.call(w.admin, "POST", "/api/admin/invites", { login: "@newcomer" });
    assert.equal(created.status, 201);
    const invite = (await json(created)).invite as Record<string, unknown>;
    assert.equal(invite.login, "newcomer");
    assert.match(String(invite.id), /^inv_/);

    const listed = await json(await w.call(w.admin, "GET", "/api/admin/invites"));
    assert.deepEqual((listed.invites as Array<Record<string, unknown>>).map((entry) => entry.login), ["newcomer"]);

    // GitHub reports the login with its real case; matching ignores case.
    const result = await signIn(w.gateway, w.github, NEWCOMER);
    assert.equal(result.location, "/");
    assert.ok(result.session);
    const user = w.gateway.store.userByGithubId(NEWCOMER.id);
    assert.equal(user?.login, "Newcomer");
    assert.equal(user?.state, "active");

    assert.deepEqual((await json(await w.call(w.admin, "GET", "/api/admin/invites"))).invites, [], "the invite is spent");
    assert.ok((await auditActions(w)).includes("invite.redeemed"));

    // A second account that later takes the same login is not let in by the spent invite.
    const other = await signIn(w.gateway, w.github, { id: 6006, login: "newcomer" });
    assert.equal(other.session, null);
  } finally {
    await w.close();
  }
});

test("an invited user with no firstmate yet is signed in but told so", async () => {
  const w = await world();
  try {
    await w.call(w.admin, "POST", "/api/admin/invites", { login: NEWCOMER.login });
    const { session } = await signIn(w.gateway, w.github, NEWCOMER);
    assert.ok(session);
    const info = await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(session) }));
    assert.deepEqual(info.user, { login: "Newcomer", admin: false, firstmate: "none" });
    const api = await fetch(`${w.gateway.url}/api/status`, { headers: sessionHeaders(session) });
    assert.equal(api.status, 409);
    assert.equal(w.upstream.requests.length, 0);
  } finally {
    await w.close();
  }
});

test("an invite expires after 14 days, can be revoked, and re-inviting extends the open one", async () => {
  const w = await world({ accessRequests: false });
  try {
    const first = (await json(await w.call(w.admin, "POST", "/api/admin/invites", { login: "newcomer" }))).invite as Record<string, unknown>;
    w.gateway.advance(DAY);
    const again = (await json(await w.call(w.admin, "POST", "/api/admin/invites", { login: "NEWCOMER" }))).invite as Record<string, unknown>;
    assert.equal(again.id, first.id, "one open invite per login");
    assert.equal(Date.parse(String(again.expires_at)) - Date.parse(String(first.expires_at)), DAY);

    w.gateway.advance(INVITE_MS);
    assert.equal((await signIn(w.gateway, w.github, NEWCOMER)).location, "/?signin=not_invited", "an expired invite opens nothing");

    const fresh = (await json(await w.call(w.admin, "POST", "/api/admin/invites", { login: "newcomer" }))).invite as Record<string, unknown>;
    const revoked = await w.call(w.admin, "DELETE", `/api/admin/invites/${String(fresh.id)}`);
    assert.equal(revoked.status, 200);
    assert.equal((await w.call(w.admin, "DELETE", `/api/admin/invites/${String(fresh.id)}`)).status, 404);
    assert.equal((await signIn(w.gateway, w.github, NEWCOMER)).location, "/?signin=not_invited", "a revoked invite opens nothing");
  } finally {
    await w.close();
  }
});

test("an invite needs a valid GitHub login for someone who is not a user yet", async () => {
  const w = await world();
  try {
    for (const login of ["", "bad login", "-dash", "x".repeat(40), "a/b"]) {
      assert.equal((await w.call(w.admin, "POST", "/api/admin/invites", { login })).status, 400, login);
    }
    assert.equal((await w.call(w.admin, "POST", "/api/admin/invites", { nope: 1 })).status, 400);
    const exists = await w.call(w.admin, "POST", "/api/admin/invites", { login: "Captain" });
    assert.equal(exists.status, 409);
    const notJson = await fetch(`${w.gateway.url}/api/admin/invites`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${w.admin}`, origin: ORIGIN, "content-type": "text/plain" },
      body: "login=x",
    });
    assert.equal(notJson.status, 400);
  } finally {
    await w.close();
  }
});

test("an uninvited sign-in waits as an access request until the admin approves it", async () => {
  const w = await world();
  try {
    const first = await signIn(w.gateway, w.github, STRANGER);
    assert.equal(first.location, "/?signin=pending");
    assert.equal(first.session, null);
    assert.equal(w.gateway.store.userByGithubId(STRANGER.id), null, "a request creates no user");

    const again = await signIn(w.gateway, w.github, STRANGER);
    assert.equal(again.location, "/?signin=pending", "a repeat sign-in does not duplicate the request");
    const requests = (await json(await w.call(w.admin, "GET", "/api/admin/requests"))).requests as Array<Record<string, unknown>>;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.github_id, STRANGER.id);
    assert.equal(requests[0]?.login, "stranger");

    const approved = await w.call(w.admin, "POST", `/api/admin/requests/${STRANGER.id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(((await json(approved)).user as Record<string, unknown>).login, "stranger");
    assert.equal((await w.call(w.admin, "POST", `/api/admin/requests/${STRANGER.id}/approve`)).status, 404);

    const in_ = await signIn(w.gateway, w.github, STRANGER);
    assert.equal(in_.location, "/");
    assert.ok(in_.session);
    const actions = await auditActions(w);
    assert.ok(actions.includes("access.requested") && actions.includes("access.approved"));
  } finally {
    await w.close();
  }
});

test("a denied request is remembered for 30 days and not re-queued", async () => {
  const w = await world();
  try {
    await signIn(w.gateway, w.github, STRANGER);
    assert.equal((await w.call(w.admin, "POST", `/api/admin/requests/${STRANGER.id}/deny`)).status, 200);
    assert.equal((await w.call(w.admin, "POST", `/api/admin/requests/${STRANGER.id}/deny`)).status, 404);

    const refused = await signIn(w.gateway, w.github, STRANGER);
    assert.equal(refused.location, "/?signin=not_invited");
    assert.deepEqual((await json(await w.call(w.admin, "GET", "/api/admin/requests"))).requests, []);

    w.gateway.advance(ACCESS_REQUEST_MS + 1);
    assert.equal((await signIn(w.gateway, w.github, STRANGER)).location, "/?signin=pending", "after 30 days they may ask again");
  } finally {
    await w.close();
  }
});

test("pending requests are capped, and an unanswered one expires after 30 days", async () => {
  const w = await world();
  try {
    for (let i = 0; i < MAX_PENDING_ACCESS_REQUESTS; i += 1) {
      assert.equal(w.gateway.store.recordAccessRequest(10_000 + i, `asker-${i}`, Date.parse("2026-10-04T12:00:00Z")), "pending");
    }
    assert.equal((await signIn(w.gateway, w.github, STRANGER)).location, "/?signin=not_invited", "a full queue records nothing");
    w.gateway.advance(ACCESS_REQUEST_MS + 1);
    // The admin's own session idled out over those 30 days too.
    const admin = (await signIn(w.gateway, w.github, ADMIN)).session;
    assert.ok(admin);
    assert.deepEqual((await json(await w.call(admin, "GET", "/api/admin/requests"))).requests, []);
    assert.equal((await signIn(w.gateway, w.github, STRANGER)).location, "/?signin=pending");
  } finally {
    await w.close();
  }
});

test("only a signed-in admin reaches the admin routes, writes need the app's origin, and the shared token opens none", async () => {
  const w = await world();
  try {
    const crew = (await signIn(w.gateway, w.github, CREW)).session;
    assert.ok(crew);
    const routes: Array<[string, string]> = [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/invites"],
      ["GET", "/api/admin/requests"],
      ["GET", "/api/admin/audit"],
      ["POST", "/api/admin/invites"],
    ];
    for (const [method, path] of routes) {
      const body = method === "POST" ? { login: "someone" } : undefined;
      assert.equal((await w.call(crew, method, path, body)).status, 403, `${method} ${path} as a plain user`);
      assert.equal((await w.call(null, method, path, body)).status, 401, `${method} ${path} signed out`);
      assert.equal(
        (await w.call(null, method, path, body, { authorization: `Bearer ${LEGACY_TOKEN}` })).status,
        401,
        `${method} ${path} with the shared token`,
      );
    }
    const crossSite = await w.call(w.admin, "POST", "/api/admin/invites", { login: "someone" }, { origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    assert.equal(w.gateway.store.listInvites(Date.now() + 1).length, 0);
    assert.equal((await w.call(w.admin, "GET", "/api/admin/nope")).status, 404);
    assert.equal((await w.call(w.admin, "PUT", "/api/admin/invites", { login: "x" })).status, 405);
  } finally {
    await w.close();
  }
});

test("the admin can suspend, resume and remove an invited user, but not themselves or a declared account", async () => {
  const w = await world();
  try {
    await w.call(w.admin, "POST", "/api/admin/invites", { login: NEWCOMER.login });
    const session = (await signIn(w.gateway, w.github, NEWCOMER)).session;
    assert.ok(session);
    const users = (await json(await w.call(w.admin, "GET", "/api/admin/users"))).users as Array<Record<string, unknown>>;
    const newcomer = users.find((user) => user.login === "Newcomer");
    const captain = users.find((user) => user.login === "captain");
    assert.ok(newcomer && captain);
    assert.equal(newcomer.declared, false);
    assert.equal(newcomer.sessions, 1);
    assert.equal(captain.admin, true);
    assert.equal(captain.declared, true);

    const suspended = await w.call(w.admin, "POST", `/api/admin/users/${String(newcomer.id)}/suspend`);
    assert.equal(suspended.status, 200);
    assert.equal(((await json(suspended)).user as Record<string, unknown>).state, "suspended");
    const info = await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(session) }));
    assert.equal(info.signed_in, false, "suspension signs them out everywhere");
    assert.equal((await signIn(w.gateway, w.github, NEWCOMER)).location, "/?signin=suspended");

    assert.equal((await w.call(w.admin, "POST", `/api/admin/users/${String(newcomer.id)}/resume`)).status, 200);
    assert.ok((await signIn(w.gateway, w.github, NEWCOMER)).session);

    assert.equal((await w.call(w.admin, "POST", `/api/admin/users/${String(captain.id)}/suspend`)).status, 409, "not yourself");
    const crewUser = w.gateway.store.userByGithubId(CREW.id) ?? (await signIn(w.gateway, w.github, CREW), w.gateway.store.userByGithubId(CREW.id));
    assert.ok(crewUser);
    assert.equal((await w.call(w.admin, "DELETE", `/api/admin/users/${crewUser.id}`)).status, 409, "a declared account is managed in configuration");
    assert.equal((await w.call(w.admin, "GET", `/api/admin/users/${crewUser.id}`)).status, 405);
    assert.equal((await w.call(w.admin, "DELETE", "/api/admin/users/u_missing")).status, 404);

    assert.equal((await w.call(w.admin, "DELETE", `/api/admin/users/${String(newcomer.id)}`)).status, 200);
    assert.equal(w.gateway.store.userByGithubId(NEWCOMER.id), null);
    assert.equal((await signIn(w.gateway, w.github, NEWCOMER)).location, "/?signin=pending", "a removed user starts over");
    const actions = await auditActions(w);
    for (const action of ["user.suspended", "user.resumed", "user.removed"]) assert.ok(actions.includes(action), action);
  } finally {
    await w.close();
  }
});

test("a user sees their own devices and can sign out one, the others, or this one", async () => {
  const w = await world();
  try {
    const laptop = (await signIn(w.gateway, w.github, CREW)).session;
    const phone = (await signIn(w.gateway, w.github, CREW)).session;
    const tablet = (await signIn(w.gateway, w.github, CREW)).session;
    assert.ok(laptop && phone && tablet);

    const listed = (await json(await w.call(laptop, "GET", "/api/me/devices"))).devices as Array<Record<string, unknown>>;
    assert.equal(listed.length, 3);
    assert.equal(listed.filter((device) => device.current === true).length, 1);
    for (const device of listed) {
      assert.match(String(device.id), /^[0-9a-f]{16}$/);
      for (const session of [laptop, phone, tablet]) assert.ok(!JSON.stringify(device).includes(session), "a device never shows a session id");
    }

    const phoneHandle = GatewayStore.deviceHandle(phone);
    assert.equal((await w.call(w.admin, "DELETE", `/api/me/devices/${phoneHandle}`)).status, 404, "another user's device is out of reach");
    assert.equal((await w.call(laptop, "DELETE", `/api/me/devices/${phoneHandle}`)).status, 200);
    assert.equal((await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(phone) }))).signed_in, false);

    const others = await json(await w.call(laptop, "DELETE", "/api/me/devices"));
    assert.equal(others.removed, 1);
    assert.equal((await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(tablet) }))).signed_in, false);
    assert.equal((await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(laptop) }))).signed_in, true);

    const self = await w.call(laptop, "DELETE", `/api/me/devices/${GatewayStore.deviceHandle(laptop)}`);
    assert.equal(self.status, 200);
    assert.equal((await json(self)).current, true);
    assert.match(setCookie(self, SESSION_COOKIE) ?? "", /Max-Age=0/);
    assert.equal((await w.call(laptop, "GET", "/api/me/devices")).status, 401);
    assert.equal((await w.call(null, "GET", "/api/me/devices", undefined, { authorization: `Bearer ${LEGACY_TOKEN}` })).status, 401);
  } finally {
    await w.close();
  }
});

test("a link code signs another device in as the same user, once, within five minutes", async () => {
  const w = await world();
  try {
    const crew = (await signIn(w.gateway, w.github, CREW)).session;
    assert.ok(crew);
    const minted = await w.call(crew, "POST", "/auth/link/code", {});
    assert.equal(minted.status, 200);
    const { code } = (await json(minted)) as { code: string };
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const redeem = (value: string, headers: Record<string, string> = {}): Promise<Response> => w.call(null, "POST", "/auth/link/redeem", { code: value }, headers);
    assert.equal((await redeem(code, { origin: "https://evil.example" })).status, 403, "only from the app itself");
    const linked = await redeem(code.toLowerCase().replace("-", " "));
    assert.equal(linked.status, 200);
    const newSession = cookieValue(linked, SESSION_COOKIE);
    assert.ok(newSession && newSession !== crew);
    const info = await json(await fetch(`${w.gateway.url}/auth/session`, { headers: sessionHeaders(newSession) }));
    assert.equal((info.user as Record<string, unknown>).login, "crew-member");
    assert.equal((await redeem(code)).status, 400, "single use");
    assert.ok((await auditActions(w)).includes("device.linked"));

    const second = (await json(await w.call(crew, "POST", "/auth/link/code", {}))) as { code: string };
    w.gateway.advance(LINK_CODE_MS);
    assert.equal((await redeem(second.code)).status, 400, "expired");

    assert.equal((await w.call(null, "POST", "/auth/link/code", {})).status, 401, "minting needs a session");
    assert.equal((await w.call(crew, "POST", "/auth/link/code", {}, { origin: "https://evil.example" })).status, 403);
  } finally {
    await w.close();
  }
});

test("a new link code replaces the last one, and a suspended user's code is void", async () => {
  const w = await world();
  try {
    await w.call(w.admin, "POST", "/api/admin/invites", { login: NEWCOMER.login });
    const session = (await signIn(w.gateway, w.github, NEWCOMER)).session;
    assert.ok(session);
    const first = (await json(await w.call(session, "POST", "/auth/link/code", {}))) as { code: string };
    const second = (await json(await w.call(session, "POST", "/auth/link/code", {}))) as { code: string };
    assert.equal((await w.call(null, "POST", "/auth/link/redeem", { code: first.code })).status, 400);

    const user = w.gateway.store.userByGithubId(NEWCOMER.id);
    assert.ok(user);
    await w.call(w.admin, "POST", `/api/admin/users/${user.id}/suspend`);
    assert.equal((await w.call(null, "POST", "/auth/link/redeem", { code: second.code })).status, 400);
  } finally {
    await w.close();
  }
});

test("redeeming link codes is rate-limited and rejects junk before any lookup", async () => {
  let clock = 0;
  const w = await world({
    linkLimits: {
      perClient: new RateLimiter({ capacity: 3, refillPerMinute: 3, now: () => clock }),
      global: new RateLimiter({ capacity: 100, refillPerMinute: 100, now: () => clock }),
    },
  });
  try {
    const statuses: number[] = [];
    for (const code of ["AAAA-AAAA", "not a code", "0000-1111"]) {
      statuses.push((await w.call(null, "POST", "/auth/link/redeem", { code })).status);
    }
    assert.deepEqual(statuses, [400, 400, 400]);
    assert.equal((await w.call(null, "POST", "/auth/link/redeem", { code: "AAAA-AAAA" })).status, 429);
    clock += 60_000;
    assert.equal((await w.call(null, "POST", "/auth/link/redeem", { code: 42 })).status, 400);
    const raw = await fetch(`${w.gateway.url}/auth/link/redeem`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" });
    assert.equal(raw.status, 400);
  } finally {
    await w.close();
  }
});

test("the admin audit view records who did what, and never a secret", async () => {
  const w = await world();
  try {
    await w.call(w.admin, "POST", "/api/admin/invites", { login: NEWCOMER.login });
    const session = (await signIn(w.gateway, w.github, NEWCOMER)).session;
    assert.ok(session);
    const { code } = (await json(await w.call(session, "POST", "/auth/link/code", {}))) as { code: string };
    const linked = cookieValue(await w.call(null, "POST", "/auth/link/redeem", { code }), SESSION_COOKIE);
    assert.ok(linked);

    const entries = (await json(await w.call(w.admin, "GET", "/api/admin/audit"))).entries as Array<Record<string, unknown>>;
    const actions = entries.map((entry) => entry.action);
    for (const action of ["invite.created", "invite.redeemed", "device.link_code", "device.linked", "signin"]) {
      assert.ok(actions.includes(action), action);
    }
    const text = JSON.stringify(entries);
    for (const secret of [session, linked, code, code.replace("-", ""), w.admin, ADMIN_TOKEN, CREW_TOKEN, LEGACY_TOKEN]) {
      assert.ok(!text.includes(secret), "a secret reached the audit view");
    }
  } finally {
    await w.close();
  }
});

test("link codes are drawn from the unambiguous alphabet and typed codes are normalized strictly", () => {
  for (let i = 0; i < 50; i += 1) {
    const code = newLinkCode();
    assert.equal(code.length, 8);
    for (const char of code) assert.ok(LINK_CODE_ALPHABET.includes(char));
  }
  assert.equal(normalizeLinkCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normalizeLinkCode(" ab cd ef gh "), "ABCDEFGH");
  assert.equal(normalizeLinkCode("ABCD-EFG"), null, "too short");
  assert.equal(normalizeLinkCode("ABCD-EFG0"), null, "0 is not in the alphabet");
  assert.equal(normalizeLinkCode("ABCD-EFGI"), null, "I is not in the alphabet");
  assert.equal(normalizeLinkCode("A".repeat(65)), null);
});

test("a phase 1 database upgrades in place and keeps its users and sessions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wt-migrate-")), "gateway.db");
  const v1 = new sqlite.DatabaseSync(path);
  // The schema phase 1 shipped (version 1), as persisted on disk.
  v1.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'suspended')), created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, label TEXT NOT NULL);
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE login_attempts (id_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL, code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL,
      subject TEXT, detail TEXT);
    PRAGMA user_version = 1;
  `);
  v1.close();

  const before = GatewayStore.open(sqlite, path);
  const now = Date.parse("2026-10-04T12:00:00Z");
  const user = before.createUser(1001, "captain", now);
  const session = before.createSession(user.id, "iPhone", now);
  before.createInvite("newcomer", user.id, now);
  before.close();

  const after = GatewayStore.open(sqlite, path);
  assert.equal(after.userByGithubId(1001)?.id, user.id);
  assert.equal(after.touchSession(session, now + 1000)?.userId, user.id);
  assert.equal(after.listInvites(now).length, 1);
  after.close();
  const version = new sqlite.DatabaseSync(path);
  assert.deepEqual({ ...version.prepare("PRAGMA user_version").get() }, { user_version: 2 });
  version.close();
});
