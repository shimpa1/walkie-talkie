import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
