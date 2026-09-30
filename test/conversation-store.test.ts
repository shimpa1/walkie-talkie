import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  OpencodeStore,
  clampHistoryLimit,
  isValidHistoryCursor,
} from "../src/conversation-store.js";

const SESSION = "ses_test_session";

interface Seeder {
  db: DatabaseSync;
  path: string;
}

function seedStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY);
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL DEFAULT 0,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL DEFAULT 0,
      data text NOT NULL
    );
  `);
  db.prepare("INSERT INTO session (id) VALUES (?)").run(SESSION);
  return db;
}

function makeStore(): Seeder {
  const dir = mkdtempSync(join(tmpdir(), "reach-store-"));
  const path = join(dir, "opencode.db");
  return { db: seedStore(path), path };
}

function addMessage(
  db: DatabaseSync,
  id: string,
  time: number,
  role: string,
  parts: Array<Record<string, unknown>>,
): void {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    id,
    SESSION,
    time,
    JSON.stringify({ role }),
  );
  parts.forEach((part, index) => {
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    ).run(`${id}_p${index}`, id, SESSION, time + index, JSON.stringify(part));
  });
}

test("clampHistoryLimit defaults, bounds, and passes through a valid count", () => {
  assert.equal(clampHistoryLimit(null), DEFAULT_HISTORY_LIMIT);
  assert.equal(clampHistoryLimit("soon"), DEFAULT_HISTORY_LIMIT);
  assert.equal(clampHistoryLimit("0"), 1);
  assert.equal(clampHistoryLimit("999999"), MAX_HISTORY_LIMIT);
  assert.equal(clampHistoryLimit("120"), 120);
  assert.equal(clampHistoryLimit(50), 50);
});

test("isValidHistoryCursor accepts the opaque time:id shape and rejects junk", () => {
  assert.equal(isValidHistoryCursor("1790000000000:msg_abc123"), true);
  assert.equal(isValidHistoryCursor("not-a-cursor"), false);
  assert.equal(isValidHistoryCursor(":msg_abc"), false);
  assert.equal(isValidHistoryCursor("123:"), false);
  assert.equal(isValidHistoryCursor("123:bad id"), false);
});

test("readHistory returns the latest page oldest-first with cursors", async () => {
  const { db, path } = makeStore();
  for (let index = 0; index < 5; index += 1) {
    addMessage(db, `msg_${index}`, 1000 + index, index % 2 === 0 ? "user" : "assistant", [
      { type: "text", text: `message ${index}` },
    ]);
  }
  db.close();

  const page = await new OpencodeStore({ dbPath: path }).readHistory(SESSION, { limit: 2 });
  assert.ok(page);
  assert.deepEqual(
    page.messages.map((message) => [message.id, message.role, message.text]),
    [
      ["msg_3", "assistant", "message 3"],
      ["msg_4", "user", "message 4"],
    ],
  );
  assert.equal(page.has_older, true);
  assert.equal(page.has_newer, false);
  assert.equal(page.oldest_cursor, "1003:msg_3");
  assert.equal(page.newest_cursor, "1004:msg_4");
});

test("readHistory paginates older messages with a before cursor", async () => {
  const { db, path } = makeStore();
  for (let index = 0; index < 5; index += 1) {
    addMessage(db, `msg_${index}`, 1000 + index, "assistant", [{ type: "text", text: `message ${index}` }]);
  }
  db.close();

  const store = new OpencodeStore({ dbPath: path });
  const page = await store.readHistory(SESSION, { limit: 3, before: "1002:msg_2" });
  assert.ok(page);
  assert.deepEqual(
    page.messages.map((message) => message.id),
    ["msg_0", "msg_1"],
  );
  assert.equal(page.has_older, false);
  assert.equal(page.has_newer, true);
  assert.equal(page.oldest_cursor, "1000:msg_0");
});

test("readHistory returns newer messages with an after cursor", async () => {
  const { db, path } = makeStore();
  for (let index = 0; index < 5; index += 1) {
    addMessage(db, `msg_${index}`, 1000 + index, "assistant", [{ type: "text", text: `message ${index}` }]);
  }
  db.close();

  const store = new OpencodeStore({ dbPath: path });
  const page = await store.readHistory(SESSION, { limit: 10, after: "1001:msg_1" });
  assert.ok(page);
  assert.deepEqual(
    page.messages.map((message) => message.id),
    ["msg_2", "msg_3", "msg_4"],
  );
  assert.equal(page.has_newer, false);
  assert.equal(page.has_older, true);
  assert.equal(page.newest_cursor, "1004:msg_4");
});

test("readHistory joins a message's text parts and ignores non-text parts", async () => {
  const { db, path } = makeStore();
  addMessage(db, "msg_user", 1000, "user", [
    { type: "text", text: "first line" },
    { type: "text", text: "second line" },
  ]);
  addMessage(db, "msg_tool", 1001, "assistant", [{ type: "tool", tool: "bash" }]);
  addMessage(db, "msg_reply", 1002, "assistant", [{ type: "text", text: "done" }]);
  db.close();

  const page = await new OpencodeStore({ dbPath: path }).readHistory(SESSION, { limit: 10 });
  assert.ok(page);
  assert.deepEqual(
    page.messages.map((message) => [message.id, message.text]),
    [
      ["msg_user", "first line\nsecond line"],
      ["msg_reply", "done"],
    ],
  );
});

test("readHistory returns null for an unknown session, bad id, or missing store", async () => {
  const { db, path } = makeStore();
  addMessage(db, "msg_0", 1000, "assistant", [{ type: "text", text: "hi" }]);
  db.close();
  const store = new OpencodeStore({ dbPath: path });
  assert.equal(await store.readHistory("ses_missing", { limit: 10 }), null);
  assert.equal(await store.readHistory("not-a-session", { limit: 10 }), null);
  const missing = await new OpencodeStore({ dbPath: join(path, "..", "nope.db") }).readHistory(SESSION, {
    limit: 10,
  });
  assert.equal(missing, null);
});

test("readHistory retries and recovers once the store appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-store-late-"));
  const path = join(dir, "opencode.db");
  const store = new OpencodeStore({ dbPath: path });

  assert.equal(await store.readHistory(SESSION, { limit: 10 }), null);

  const db = seedStore(path);
  addMessage(db, "msg_0", 1000, "assistant", [{ type: "text", text: "appeared later" }]);
  db.close();

  const page = await store.readHistory(SESSION, { limit: 10 });
  assert.ok(page);
  assert.deepEqual(page.messages.map((message) => message.text), ["appeared later"]);
});

test("readHistory is read-only: a query cannot mutate the store", async () => {
  const { db, path } = makeStore();
  addMessage(db, "msg_0", 1000, "assistant", [{ type: "text", text: "hi" }]);
  db.close();
  const before = new DatabaseSync(path).prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number };
  await new OpencodeStore({ dbPath: path }).readHistory(SESSION, { limit: 10 });
  const after = new DatabaseSync(path).prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number };
  assert.equal(before.n, after.n);
});
