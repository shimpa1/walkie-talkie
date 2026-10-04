import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";

import { clearCookie, parseCookies, serializeCookie } from "../src/cookies.js";
import {
  GatewayStore,
  LOGIN_ATTEMPT_MS,
  MAX_LIVE_LOGIN_ATTEMPTS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sha256Hex,
} from "../src/gateway-store.js";
import { RateLimiter } from "../src/rate-limit.js";

const T0 = Date.parse("2026-10-04T12:00:00Z");

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wt-store-")), "gateway.db");
}

test("the store file is owner-only and holds a session only as its hash", () => {
  const path = tempDbPath();
  const store = GatewayStore.open(sqlite, path);
  const user = store.createUser(1001, "captain", T0);
  const session = store.createSession(user.id, "iPhone", T0);
  store.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const bytes = readFileSync(path).toString("latin1");
  assert.ok(!bytes.includes(session), "the raw session id is not stored");
  assert.ok(bytes.includes(sha256Hex(session)), "its hash is");
});

test("reopening an existing store keeps its data and does not re-run migrations", () => {
  const path = tempDbPath();
  const first = GatewayStore.open(sqlite, path);
  const user = first.createUser(1001, "captain", T0);
  first.close();
  const second = GatewayStore.open(sqlite, path);
  assert.equal(second.userById(user.id)?.githubId, 1001);
  second.close();
});

test("a GitHub id maps to one user", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  store.createUser(1001, "captain", T0);
  assert.throws(() => store.createUser(1001, "someone-else", T0));
  store.close();
});

test("a session slides its idle window and ends at the absolute limit", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  const user = store.createUser(1001, "captain", T0);
  const session = store.createSession(user.id, "Mac", T0);

  assert.equal(store.touchSession(session, T0 + 1000)?.userId, user.id);
  assert.equal(store.touchSession("not-a-session", T0), null);
  assert.equal(store.touchSession("", T0), null);

  let at = T0;
  while (at + SESSION_IDLE_MS / 2 < T0 + SESSION_ABSOLUTE_MS) {
    at += SESSION_IDLE_MS / 2;
    assert.ok(store.touchSession(session, at), "regular use keeps the session");
  }
  assert.equal(store.touchSession(session, T0 + SESSION_ABSOLUTE_MS), null, "the absolute limit ends it");
  assert.equal(store.countSessions(user.id), 0, "an expired session is deleted");
  store.close();
});

test("an idle session expires", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  const user = store.createUser(1001, "captain", T0);
  const session = store.createSession(user.id, "Mac", T0);
  assert.equal(store.touchSession(session, T0 + SESSION_IDLE_MS), null);
  store.close();
});

test("suspending a user revokes every session; resuming does not bring them back", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  const user = store.createUser(1001, "captain", T0);
  const one = store.createSession(user.id, "Mac", T0);
  const two = store.createSession(user.id, "iPhone", T0);
  store.setUserState(user.id, "suspended");
  assert.equal(store.countSessions(user.id), 0);
  store.setUserState(user.id, "active");
  assert.equal(store.touchSession(one, T0), null);
  assert.equal(store.touchSession(two, T0), null);
  store.close();
});

test("a login attempt is consumed exactly once, whatever state is presented", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  const attempt = store.createLoginAttempt("the-state", "the-verifier", T0);
  assert.ok(attempt);
  assert.equal(store.consumeLoginAttempt(attempt, "wrong-state", T0), null);
  assert.equal(store.consumeLoginAttempt(attempt, "the-state", T0), null, "a wrong guess burns the attempt");

  const fresh = store.createLoginAttempt("s2", "v2", T0);
  assert.ok(fresh);
  assert.equal(store.consumeLoginAttempt(fresh, "s2", T0), "v2");
  assert.equal(store.consumeLoginAttempt(fresh, "s2", T0), null, "no replay");

  const late = store.createLoginAttempt("s3", "v3", T0);
  assert.ok(late);
  assert.equal(store.consumeLoginAttempt(late, "s3", T0 + LOGIN_ATTEMPT_MS), null, "expired");
  store.close();
});

test("concurrent unfinished sign-ins are capped", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  for (let i = 0; i < MAX_LIVE_LOGIN_ATTEMPTS; i += 1) {
    assert.ok(store.createLoginAttempt(`s${i}`, "v", T0));
  }
  assert.equal(store.createLoginAttempt("one-too-many", "v", T0), null);
  assert.ok(store.createLoginAttempt("after-expiry", "v", T0 + LOGIN_ATTEMPT_MS), "expired attempts free the cap");
  store.close();
});

test("the audit log keeps actions in order", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  store.audit({ at: T0, actor: null, action: "first", subject: null, detail: null });
  store.audit({ at: T0 + 1, actor: "u_x", action: "second", subject: "u_x", detail: { reason: "test", n: 1, ok: true } });
  assert.deepEqual(store.recentAudit(), [
    { at: T0 + 1, actor: "u_x", action: "second", subject: "u_x", detail: { reason: "test", n: 1, ok: true } },
    { at: T0, actor: null, action: "first", subject: null, detail: null },
  ]);
  store.close();
});

test("cookies are parsed defensively and always set as __Host- cookies", () => {
  const cookies = parseCookies("a=1; __Host-wt_session=abc; a=2; junk; =x; b=");
  assert.equal(cookies.get("a"), "1", "the first occurrence wins");
  assert.equal(cookies.get("__Host-wt_session"), "abc");
  assert.equal(cookies.get("b"), "");
  assert.equal(parseCookies(undefined).size, 0);
  assert.equal(parseCookies("x=".padEnd(9000, "y")).size, 0, "an oversized header is ignored");
  assert.equal(
    serializeCookie("__Host-wt_session", "v", 60),
    "__Host-wt_session=v; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
  );
  assert.match(clearCookie("__Host-wt_session"), /=; Path=\/; .*Max-Age=0$/);
});

test("the rate limiter allows a burst, then refills over time", () => {
  let clock = 0;
  const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 2, now: () => clock });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true, "keys are independent");
  clock += 30_000;
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
});

test("the rate limiter forgets the stalest key past its bound", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerMinute: 0, maxKeys: 2, now: () => 0 });
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("c"), true);
  assert.equal(limiter.allow("a"), true, "a was evicted, so it starts fresh");
  assert.equal(limiter.allow("c"), false);
});
