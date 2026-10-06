import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";

import { GatewayStore } from "../src/gateway-store.js";
import { credentialAad, parseKeyring, Vault, VaultError } from "../src/vault.js";

const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");
const CANARY = "sk-canary-vault-9f3e7d21c0b4";

function plain(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

test("the keyring parses ids and 32-byte keys, and refuses anything else without echoing a key", () => {
  const ring = parseKeyring(` k1:${K1} , k2:${K2} `);
  assert.deepEqual([...ring.keys()], ["k1", "k2"]);
  assert.equal(ring.get("k1")?.length, 32);

  const short = randomBytes(16).toString("base64");
  for (const bad of ["", "k1", `:${K1}`, `k 1:${K1}`, `k1:${short}`, `k1:${K1},k1:${K2}`, "k1:not base64!"]) {
    assert.throws(
      () => parseKeyring(bad),
      (error: unknown) => error instanceof VaultError && !error.message.includes(short) && !error.message.includes(K1),
      bad,
    );
  }
  assert.throws(() => new Vault(parseKeyring(`k1:${K1}`), "k2"), /not in the keyring/);
});

test("a sealed credential opens for its owner and slot (round trip)", () => {
  const vault = Vault.fromSettings(`k1:${K1}`, "k1");
  const sealed = vault.seal("u_alice", "ANTHROPIC_API_KEY", plain(CANARY));
  assert.equal(sealed.kid, "k1");
  // 96-bit nonce + ciphertext + 128-bit tag; the plaintext is nowhere in it.
  assert.equal(sealed.blob.length, 12 + Buffer.byteLength(CANARY) + 16);
  assert.equal(Buffer.from(sealed.blob).includes(plain(CANARY)), false);
  assert.equal(vault.open("u_alice", "ANTHROPIC_API_KEY", sealed).toString("utf8"), CANARY);

  // Every write draws a fresh nonce: sealing the same key twice differs.
  const again = vault.seal("u_alice", "ANTHROPIC_API_KEY", plain(CANARY));
  assert.notDeepEqual(Buffer.from(again.blob), Buffer.from(sealed.blob));
});

test("any tampering with a sealed credential fails authentication", () => {
  const vault = Vault.fromSettings(`k1:${K1}`, "k1");
  const sealed = vault.seal("u_alice", "OPENAI_API_KEY", plain(CANARY));
  const blob = Buffer.from(sealed.blob);
  for (const index of [0, 11, 12, blob.length - 17, blob.length - 1]) {
    const tampered = Buffer.from(blob);
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    assert.throws(() => vault.open("u_alice", "OPENAI_API_KEY", { kid: "k1", blob: tampered }), VaultError, `byte ${index}`);
  }
  assert.throws(() => vault.open("u_alice", "OPENAI_API_KEY", { kid: "k1", blob: blob.subarray(0, 20) }), /truncated/);
});

test("the AAD binds a credential to its owner, slot and key id", () => {
  const vault = Vault.fromSettings(`k1:${K1},k2:${K2}`, "k1");
  const sealed = vault.seal("u_alice", "ANTHROPIC_API_KEY", plain(CANARY));
  assert.equal(
    credentialAad("u_alice", "ANTHROPIC_API_KEY", "k1").toString("utf8"),
    "walkie-talkie/credential/v1\0u_alice\0ANTHROPIC_API_KEY\0k1",
  );
  // Copied to another user: refused rather than handing Bob Alice's key.
  assert.throws(() => vault.open("u_bob", "ANTHROPIC_API_KEY", sealed), VaultError);
  // Copied to another slot of the same user.
  assert.throws(() => vault.open("u_alice", "OPENAI_API_KEY", sealed), VaultError);
  // Relabelled with another key id that is in the keyring.
  assert.throws(() => vault.open("u_alice", "ANTHROPIC_API_KEY", { kid: "k2", blob: sealed.blob }), VaultError);
  // The ids are separated, so shifting a boundary does not collide.
  assert.notDeepEqual(credentialAad("u_a", "bX", "k1"), credentialAad("u_ab", "X", "k1"));
});

test("a credential sealed under a key id the keyring no longer has will not open", () => {
  const old = Vault.fromSettings(`k1:${K1}`, "k1");
  const sealed = old.seal("u_alice", "GH_TOKEN", plain(CANARY));
  const rotatedAway = Vault.fromSettings(`k2:${K2}`, "k2");
  assert.throws(() => rotatedAway.open("u_alice", "GH_TOKEN", sealed), /vault key k1 is not in the keyring/);
  // Same id, different key material: the tag check fails.
  const wrongKey = Vault.fromSettings(`k1:${K2}`, "k1");
  assert.throws(() => wrongKey.open("u_alice", "GH_TOKEN", sealed), /failed authentication/);
});

function openStore(path: string): GatewayStore {
  return GatewayStore.open(sqlite, path);
}

test("vault rotate re-seals every row under the active key, after which the old key can go", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wt-vault-")), "gateway.db");
  const store = openStore(path);
  const now = Date.parse("2026-10-05T12:00:00Z");
  const alice = store.createUser(2001, "alice", now);
  const bob = store.createUser(2002, "bob", now);
  const v1 = Vault.fromSettings(`k1:${K1}`, "k1");
  store.putCredential(alice.id, "ANTHROPIC_API_KEY", "anthropic", v1.seal(alice.id, "ANTHROPIC_API_KEY", plain(`${CANARY}-a`)), null, now);
  store.putCredential(bob.id, "OPENAI_API_KEY", "openai", v1.seal(bob.id, "OPENAI_API_KEY", plain(`${CANARY}-b`)), ["gpt-5"], now);

  // The new key is added and made active; old rows still open under k1.
  const both = Vault.fromSettings(`k1:${K1},k2:${K2}`, "k2");
  store.putCredential(bob.id, "GH_TOKEN", "github", both.seal(bob.id, "GH_TOKEN", plain(`${CANARY}-g`)), null, now);
  assert.deepEqual(store.rotateCredentials(both), { rotated: 2, current: 1 });
  // Idempotent: a second run has nothing to do.
  assert.deepEqual(store.rotateCredentials(both), { rotated: 0, current: 3 });
  store.close();

  // With k1 dropped, every row opens under k2 alone, with its metadata intact.
  const db = new sqlite.DatabaseSync(path);
  const rows = db.prepare("SELECT user_id, name, kid, sealed FROM credentials ORDER BY name").all();
  db.close();
  const onlyK2 = Vault.fromSettings(`k2:${K2}`, "k2");
  const opened = rows.map((row) => {
    assert.equal(row.kid, "k2");
    return onlyK2.open(String(row.user_id), String(row.name), { kid: "k2", blob: row.sealed as Uint8Array }).toString("utf8");
  });
  assert.deepEqual(opened.sort(), [`${CANARY}-a`, `${CANARY}-b`, `${CANARY}-g`]);
  const reopened = openStore(path);
  assert.deepEqual(reopened.credential(bob.id, "OPENAI_API_KEY")?.models, ["gpt-5"]);
  reopened.close();

  // The database file never holds a key in the clear.
  assert.equal(readFileSync(path).includes(plain(CANARY)), false);
});

test("a rotation that meets an unopenable row changes nothing and names no secret", () => {
  const path = join(mkdtempSync(join(tmpdir(), "wt-vault-")), "gateway.db");
  const store = openStore(path);
  const now = Date.parse("2026-10-05T12:00:00Z");
  const alice = store.createUser(2001, "alice", now);
  const v1 = Vault.fromSettings(`k1:${K1}`, "k1");
  store.putCredential(alice.id, "A_KEY", "a", v1.seal(alice.id, "A_KEY", plain(CANARY)), null, now);
  // A row copied under another user's slot: its AAD no longer matches.
  const bob = store.createUser(2002, "bob", now);
  store.putCredential(bob.id, "B_KEY", "b", v1.seal(alice.id, "A_KEY", plain(CANARY)), null, now);

  const next = Vault.fromSettings(`k1:${K1},k2:${K2}`, "k2");
  assert.throws(
    () => store.rotateCredentials(next),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(bob.id) &&
      error.message.includes("B_KEY") &&
      !error.message.includes(CANARY),
  );
  // All or nothing: alice's row was not moved to k2 either.
  assert.deepEqual(store.rotateCredentials(Vault.fromSettings(`k1:${K1}`, "k1")), { rotated: 0, current: 2 });
  store.close();
});

test("removing a user deletes their credentials and model choice", () => {
  const store = GatewayStore.open(sqlite, ":memory:");
  const now = Date.parse("2026-10-05T12:00:00Z");
  const alice = store.createUser(2001, "alice", now);
  const vault = Vault.fromSettings(`k1:${K1}`, "k1");
  store.putCredential(alice.id, "A_KEY", "a", vault.seal(alice.id, "A_KEY", plain(CANARY)), null, now);
  store.setModelChoice(alice.id, { harness: "opencode", provider: "a", model: "m", routineModel: null }, now);
  store.deleteUser(alice.id, now);
  assert.deepEqual(store.listCredentials(alice.id), []);
  assert.equal(store.modelChoice(alice.id), null);
  store.close();
});

test("the vault rotate command re-seals through the gateway's settings and prints no secret", async () => {
  const { spawnSync } = await import("node:child_process");
  const { runVaultCommand } = await import("../src/vault-cli.js");
  const { REPO_ROOT } = await import("./helpers.js");
  const dir = mkdtempSync(join(tmpdir(), "wt-vault-cli-"));
  const path = join(dir, "gateway.db");
  const store = openStore(path);
  const now = Date.parse("2026-10-05T12:00:00Z");
  const alice = store.createUser(2001, "alice", now);
  const v1 = Vault.fromSettings(`k1:${K1}`, "k1");
  store.putCredential(alice.id, "A_KEY", "a", v1.seal(alice.id, "A_KEY", plain(CANARY)), null, now);
  store.close();

  const lines: string[] = [];
  const io = (env: NodeJS.ProcessEnv) => ({ env, cwd: dir, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
  assert.equal(await runVaultCommand(["spin"], io({})), 2);
  assert.equal(await runVaultCommand(["rotate"], io({ FM_WT_GATEWAY_DB: path })), 1, "no keyring");
  assert.equal(
    await runVaultCommand(["rotate"], io({ FM_WT_GATEWAY_DB: path, FM_WT_VAULT_KEYS: `k2:${K2}`, FM_WT_VAULT_ACTIVE_KEY: "k2" })),
    1,
    "k1 left the keyring before the rotation",
  );

  // The real entrypoint, as an operator runs it in the gateway container.
  const env = { ...process.env, FM_WT_GATEWAY_DB: path, FM_WT_VAULT_KEYS: `k1:${K1},k2:${K2}`, FM_WT_VAULT_ACTIVE_KEY: "k2", FM_WT_CONFIG: join(dir, "none.json") };
  const run = spawnSync(process.execPath, [join(REPO_ROOT, "dist", "src", "index.js"), "vault", "rotate"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 credential\(s\) re-sealed under k2, 0 already current/);

  const after = openStore(path);
  assert.deepEqual(after.rotateCredentials(Vault.fromSettings(`k2:${K2}`, "k2")), { rotated: 0, current: 1 });
  after.close();
  const output = [...lines, run.stdout, run.stderr].join("\n");
  for (const secret of [CANARY, K1, K2]) assert.equal(output.includes(secret), false);
});

test("the gateway re-seals credentials under an older key at start-up, and a failure changes nothing", async () => {
  const { resealOnStart } = await import("../src/vault-cli.js");
  const store = openStore(":memory:");
  const now = Date.parse("2026-10-06T12:00:00Z");
  const alice = store.createUser(2001, "alice", now);
  const bob = store.createUser(2002, "bob", now);
  const v1 = Vault.fromSettings(`k1:${K1}`, "k1");
  store.putCredential(alice.id, "A_KEY", "a", v1.seal(alice.id, "A_KEY", plain(CANARY)), null, now);
  store.putCredential(bob.id, "B_KEY", "b", v1.seal(bob.id, "B_KEY", plain(`${CANARY}-b`)), null, now);
  const logs: string[] = [];

  // The new key is active but k1 has left the keyring too early: nothing moves.
  assert.equal(resealOnStart(store, Vault.fromSettings(`k2:${K2}`, "k2"), (line) => logs.push(line), now), null);
  assert.equal(store.countCredentialsNotUnder("k2"), 2);
  assert.match(logs.at(-1) ?? "", /^vault: re-seal at start-up failed, nothing changed: cannot rotate the credential /);

  // Both keys in the keyring, k2 active: every row moves at start-up.
  const v2 = Vault.fromSettings(`k1:${K1},k2:${K2}`, "k2");
  assert.deepEqual(resealOnStart(store, v2, (line) => logs.push(line), now), { rotated: 2, current: 0 });
  assert.equal(store.countCredentialsNotUnder("k2"), 0);
  assert.equal(logs.at(-1), "vault: re-sealed 2 credential(s) under k2 at start-up");
  assert.deepEqual(store.recentAudit(1)[0]?.detail, { kid: "k2", rotated: 2 });
  // Now k1 can leave the keyring: the rows open under k2 alone.
  const only2 = Vault.fromSettings(`k2:${K2}`, "k2");
  const sealed = store.sealedCredential(alice.id, "A_KEY");
  assert.ok(sealed);
  assert.equal(only2.open(alice.id, "A_KEY", sealed).toString("utf8"), CANARY);

  // Nothing stale: no write, no audit.
  const audits = store.recentAudit(100).length;
  assert.deepEqual(resealOnStart(store, only2, (line) => logs.push(line), now), { rotated: 0, current: 0 });
  assert.equal(store.recentAudit(100).length, audits);
  assert.equal(logs.join("\n").includes(CANARY), false);
  store.close();
});
