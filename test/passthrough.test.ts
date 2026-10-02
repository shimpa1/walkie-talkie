import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FirstmateClient, RunResult } from "../src/firstmate.js";
import { FIXTURES_DIR, getJson, startTestServer } from "./helpers.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

function receiptsFixture(after: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, "receipts.json"), "utf8").replace("__AFTER__", after),
  );
}

test("GET /api/status passes the bearings fixture through unchanged", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await getJson(server.url, "/api/status", "t");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, fixture("bearings.json"));
  } finally {
    await server.close();
  }
});

test("GET /api/receipts passes the receipts fixture through unchanged", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await getJson(server.url, "/api/receipts", "t");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, receiptsFixture(""));
  } finally {
    await server.close();
  }
});

test("GET /api/receipts forwards the after cursor to firstmate", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await getJson(server.url, "/api/receipts?after=cursor-42", "t");
    assert.equal(result.status, 200);
    const body = result.body as { reply_cursor: string };
    assert.equal(body.reply_cursor, "cursor-42");
  } finally {
    await server.close();
  }
});

test("a hung receipts read is bounded and fails fast instead of holding the request", async () => {
  const client: FirstmateClient = {
    run(script, args) {
      if (script === "fm-inbox.sh" && args[0] === "receipts") {
        return new Promise<RunResult>(() => {});
      }
      return Promise.resolve({ stdout: "{}", stderr: "", code: 0 });
    },
  };
  const server = await startTestServer({ token: "t", firstmate: client, receiptsReadTimeoutMs: 20 });
  try {
    const started = Date.now();
    const result = await getJson(server.url, "/api/receipts", "t");
    assert.equal(result.status, 502);
    assert.ok(Date.now() - started < 2000, "the read is bounded, not held for the child timeout");
  } finally {
    await server.close();
  }
});

test("GET /api/health passes the ready fixture through unchanged", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await getJson(server.url, "/api/health");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, fixture("ready.json"));
  } finally {
    await server.close();
  }
});
