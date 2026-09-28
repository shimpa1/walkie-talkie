import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startTestServer } from "./helpers.js";

interface NoteReceipt {
  schema: string;
  outcome: string;
  note_id: string;
  request_id: string;
  saved: boolean;
  announced: boolean;
}

async function postNote(
  url: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: NoteReceipt | { error: string } }> {
  const response = await fetch(`${url}/api/note`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

function noteFiles(home: string): string[] {
  const dir = join(home, "state", "notes");
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("the same request id queues once; a new id queues again", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const first = await postNote(server.url, "t", { text: "check the west gate", requestId: "req-1" });
    assert.equal(first.status, 200);
    assert.equal((first.body as NoteReceipt).outcome, "created");
    assert.equal(noteFiles(server.home).length, 1);

    const retry = await postNote(server.url, "t", { text: "check the west gate", requestId: "req-1" });
    assert.equal(retry.status, 200);
    assert.equal((retry.body as NoteReceipt).outcome, "replay");
    assert.equal((retry.body as NoteReceipt).note_id, (first.body as NoteReceipt).note_id);
    assert.equal(noteFiles(server.home).length, 1);

    const second = await postNote(server.url, "t", { text: "and the east gate", requestId: "req-2" });
    assert.equal(second.status, 200);
    assert.equal((second.body as NoteReceipt).outcome, "created");
    assert.equal(noteFiles(server.home).length, 2);
  } finally {
    await server.close();
  }
});

test("the queued body is the instruction text exactly", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const text = "line one\nline two: keep '\"quotes\"' and $dollars intact";
    const result = await postNote(server.url, "t", { text, requestId: "req-body" });
    assert.equal(result.status, 200);
    const stored = readFileSync(join(server.home, "state", "notes", "req-body"), "utf8");
    assert.equal(stored, text);
  } finally {
    await server.close();
  }
});

test("a JSON request without a requestId is still accepted and gets one", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await postNote(server.url, "t", { text: "no id supplied" });
    assert.equal(result.status, 200);
    assert.match((result.body as NoteReceipt).request_id, /^[0-9a-f-]{36}$/);
  } finally {
    await server.close();
  }
});

test("plain text body with an X-Request-Id header is accepted", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const response = await fetch(`${server.url}/api/note`, {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "text/plain",
        "x-request-id": "header-req",
      },
      body: "from a plain client",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as NoteReceipt;
    assert.equal(body.request_id, "header-req");
    assert.equal(readFileSync(join(server.home, "state", "notes", "header-req"), "utf8"), "from a plain client");
  } finally {
    await server.close();
  }
});

test("an empty instruction is rejected without invoking firstmate", async () => {
  const server = await startTestServer({ token: "t" });
  try {
    const result = await postNote(server.url, "t", { text: "   ", requestId: "empty" });
    assert.equal(result.status, 400);
    assert.deepEqual(noteFiles(server.home), []);
  } finally {
    await server.close();
  }
});
