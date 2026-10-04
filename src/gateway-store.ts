import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { constantTimeEqual } from "./auth.js";

/**
 * The gateway's durable state: users, login sessions, in-flight GitHub login
 * attempts, and an append-only audit log.
 *
 * It is SQLite through Node's built-in `node:sqlite`, so it adds no runtime
 * dependency. Secrets that must be compared later (a session id, a login
 * attempt id, an OAuth `state`) are stored only as SHA-256 hashes, so a copy of
 * the database yields no live session. The file is created owner-only (0600);
 * SQLite gives its WAL and shared-memory files the same mode.
 *
 * The store never holds a GitHub access token, a cookie value, or any firstmate
 * conversation content.
 */

type SqliteDatabase = import("node:sqlite").DatabaseSync;
type SqliteModule = typeof import("node:sqlite");

export type UserState = "active" | "suspended";

export interface UserRecord {
  id: string;
  githubId: number;
  login: string;
  state: UserState;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SessionRecord {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string;
}

export interface LoginAttempt {
  /** The raw OAuth `state` is not stored; only its hash, compared in constant time. */
  stateHash: string;
  codeVerifier: string;
}

export interface AuditEntry {
  at: number;
  actor: string | null;
  action: string;
  subject: string | null;
  detail: Record<string, string | number | boolean> | null;
}

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const LOGIN_ATTEMPT_MS = 10 * 60 * 1000;
/** last_seen is written at most this often per session, not on every request. */
const LAST_SEEN_WRITE_MS = 60 * 1000;
/** Bound on concurrent unfinished logins, so the table cannot be grown without limit. */
export const MAX_LIVE_LOGIN_ATTEMPTS = 1000;

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      github_id INTEGER NOT NULL UNIQUE,
      login TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'suspended')),
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE sessions (
      id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      label TEXT NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE login_attempts (
      id_hash TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      subject TEXT,
      detail TEXT
    );
  `,
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A random URL-safe secret of `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function newUserId(): string {
  return `u_${randomBytes(9).toString("base64url")}`;
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : (value as number);
}

function toUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    githubId: asNumber(row.github_id),
    login: String(row.login),
    state: row.state === "suspended" ? "suspended" : "active",
    createdAt: asNumber(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : asNumber(row.last_login_at),
  };
}

export class GatewayStore {
  private readonly db: SqliteDatabase;

  private constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Open (creating if needed) the store at `path`. `:memory:` is accepted for
   * tests. The module is passed in by `openGatewayStore` so a runtime without
   * `node:sqlite` fails with a clear message at startup instead of a crash.
   */
  static open(sqlite: SqliteModule, path: string): GatewayStore {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const created = path !== ":memory:" && !existsSync(path);
    const db = new sqlite.DatabaseSync(path);
    if (created) chmodSync(path, 0o600);
    // Overwrite deleted rows, so a consumed login attempt's PKCE verifier or a
    // revoked session's hash does not linger in free pages of the file.
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    const store = new GatewayStore(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    let version = row === undefined ? 0 : asNumber(row.user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`gateway store schema ${version} is newer than this build understands (${SCHEMA_VERSION})`);
    }
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      const sql = MIGRATIONS[next];
      if (sql === undefined) throw new Error(`missing gateway store migration ${next}`);
      this.transaction(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${next}`);
      });
      version = next;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- users -------------------------------------------------------------

  userByGithubId(githubId: number): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId);
    return row === undefined ? null : toUser(row as Record<string, unknown>);
  }

  userById(id: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row === undefined ? null : toUser(row as Record<string, unknown>);
  }

  /** Create an active user for a GitHub account the operator declared. */
  createUser(githubId: number, login: string, now: number): UserRecord {
    const id = newUserId();
    this.db
      .prepare("INSERT INTO users (id, github_id, login, state, created_at, last_login_at) VALUES (?, ?, ?, 'active', ?, NULL)")
      .run(id, githubId, login, now);
    const user = this.userById(id);
    if (user === null) throw new Error("user insert did not persist");
    return user;
  }

  /** Record a sign-in: the login is refreshed because GitHub logins can be renamed. */
  recordLogin(userId: string, login: string, now: number): void {
    this.db.prepare("UPDATE users SET login = ?, last_login_at = ? WHERE id = ?").run(login, now, userId);
  }

  // ---- sessions ----------------------------------------------------------

  /** Create a session and return its raw id; only the hash is stored. */
  createSession(userId: string, label: string, now: number): string {
    const id = randomToken(32);
    this.db
      .prepare(
        "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, label) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sha256Hex(id), userId, now, now, now + SESSION_ABSOLUTE_MS, label);
    return id;
  }

  /**
   * Resolve a presented session id to its live session, sliding its idle
   * window. Returns null for an unknown, idle-expired or absolutely-expired
   * session (deleting the expired row) or one whose user is not active.
   */
  touchSession(id: string, now: number): SessionRecord | null {
    if (id.length === 0 || id.length > 256) return null;
    const idHash = sha256Hex(id);
    const row = this.db
      .prepare(
        "SELECT s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.label, u.state " +
          "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?",
      )
      .get(idHash) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const lastSeenAt = asNumber(row.last_seen_at);
    const expiresAt = asNumber(row.expires_at);
    if (now >= expiresAt || now - lastSeenAt >= SESSION_IDLE_MS) {
      this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
      return null;
    }
    if (row.state !== "active") return null;
    if (now - lastSeenAt >= LAST_SEEN_WRITE_MS) {
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, idHash);
    }
    return {
      userId: String(row.user_id),
      createdAt: asNumber(row.created_at),
      lastSeenAt: Math.max(lastSeenAt, now),
      expiresAt,
      label: String(row.label),
    };
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256Hex(id));
    return asNumber(result.changes) > 0;
  }

  // ---- login attempts ----------------------------------------------------

  /**
   * Start a login: returns the attempt id for the pre-auth cookie. Returns
   * null when too many logins are already in flight.
   */
  createLoginAttempt(state: string, codeVerifier: string, now: number): string | null {
    this.purgeExpired(now);
    const live = this.db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get() as { n: number } | undefined;
    if (live !== undefined && asNumber(live.n) >= MAX_LIVE_LOGIN_ATTEMPTS) return null;
    const id = randomToken(32);
    this.db
      .prepare(
        "INSERT INTO login_attempts (id_hash, state_hash, code_verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sha256Hex(id), sha256Hex(state), codeVerifier, now, now + LOGIN_ATTEMPT_MS);
    return id;
  }

  /**
   * Take a login attempt exactly once: it is deleted whether or not the
   * presented `state` matches, so an attempt can never be replayed. Returns the
   * PKCE verifier only when the attempt is live and `state` matches.
   */
  consumeLoginAttempt(id: string, state: string, now: number): string | null {
    if (id.length === 0 || id.length > 256 || state.length === 0 || state.length > 512) return null;
    const idHash = sha256Hex(id);
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT state_hash, code_verifier, expires_at FROM login_attempts WHERE id_hash = ?")
        .get(idHash) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      this.db.prepare("DELETE FROM login_attempts WHERE id_hash = ?").run(idHash);
      if (now >= asNumber(row.expires_at)) return null;
      if (!constantTimeEqual(String(row.state_hash), sha256Hex(state))) return null;
      return String(row.code_verifier);
    });
  }

  /** Drop expired login attempts and sessions. */
  purgeExpired(now: number): void {
    this.db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").run(now);
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?")
      .run(now, now - SESSION_IDLE_MS);
  }

  // ---- audit -------------------------------------------------------------

  /** Append an audit entry. Callers pass ids and outcomes only, never secret values. */
  audit(entry: AuditEntry): void {
    this.db
      .prepare("INSERT INTO audit (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)")
      .run(entry.at, entry.actor, entry.action, entry.subject, entry.detail === null ? null : JSON.stringify(entry.detail));
  }
}

/** Open the gateway store, loading `node:sqlite` lazily for a clear startup error. */
export async function openGatewayStore(path: string): Promise<GatewayStore> {
  let sqlite: SqliteModule;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `gateway mode needs node:sqlite (Node 22.13 or newer): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return GatewayStore.open(sqlite, path);
}
