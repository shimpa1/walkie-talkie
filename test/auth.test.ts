import { test } from "node:test";
import assert from "node:assert/strict";

import { bearerToken, constantTimeEqual, isAuthorized } from "../src/auth.js";
import { getJson, startTestServer } from "./helpers.js";

test("constantTimeEqual matches only identical secrets", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcdef"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("bearerToken parses only bearer credentials", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer abc123"), "abc123");
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(""), null);
});

test("isAuthorized rejects a missing or wrong token and accepts the right one", () => {
  assert.equal(isAuthorized(undefined, "secret"), false);
  assert.equal(isAuthorized("Bearer nope", "secret"), false);
  assert.equal(isAuthorized("Bearer secret", "secret"), true);
});

test("missing or wrong token is rejected on protected endpoints", async () => {
  const server = await startTestServer({ token: "correct-token" });
  try {
    const missing = await getJson(server.url, "/api/status");
    assert.equal(missing.status, 401);

    const wrong = await getJson(server.url, "/api/status", "wrong-token");
    assert.equal(wrong.status, 401);

    const right = await getJson(server.url, "/api/status", "correct-token");
    assert.equal(right.status, 200);
  } finally {
    await server.close();
  }
});

test("health is open and does not require a token", async () => {
  const server = await startTestServer({ token: "correct-token" });
  try {
    const health = await getJson(server.url, "/api/health");
    assert.equal(health.status, 200);
    assert.equal((health.body as { schema: string }).schema, "fm-primary-ready.v1");
  } finally {
    await server.close();
  }
});
