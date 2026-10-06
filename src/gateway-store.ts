import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { constantTimeEqual } from "./auth.js";
import { newTenantId } from "./tenant-tokens.js";
import { wipe, type SealedValue, type Vault } from "./vault.js";

/**
 * The gateway's durable state: users, login sessions, in-flight GitHub login
 * attempts, invites, access requests, device link codes, and an append-only
 * audit log.
 *
 * It is SQLite through Node's built-in `node:sqlite`, so it adds no runtime
 * dependency. Secrets that must be compared later (a session id, a login
 * attempt id, an OAuth `state`) are stored only as SHA-256 hashes, so a copy of
 * the database yields no live session. The file is created owner-only (0600);
 * SQLite gives its WAL and shared-memory files the same mode.
 *
 * Users' provider keys and GitHub tokens are held only sealed by the vault
 * (AES-256-GCM, see vault.ts); the store never sees them in the clear. Each
 * user's managed firstmate (tenant) is recorded by its opaque cluster id and
 * desired state; its cluster objects are derived from that, never stored. It never
 * holds a sign-in access token, a cookie value, or any firstmate conversation
 * content.
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

/** A user with what the admin view shows about them. */
export interface UserSummary extends UserRecord {
  /** Live sessions (signed-in devices). */
  sessions: number;
}

/** A signed-in device as its owner sees it; `id` is a handle, never the session id. */
export interface DeviceRecord {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface InviteRecord {
  id: string;
  /** The invited GitHub login, lowercased. */
  login: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface AccessRequest {
  githubId: number;
  login: string;
  requestedAt: number;
}

/** What recording an uninvited sign-in did. */
export type AccessRequestOutcome = "pending" | "denied" | "full";

export interface AuditEntry {
  at: number;
  actor: string | null;
  action: string;
  subject: string | null;
  detail: Record<string, string | number | boolean> | null;
}

/** A stored credential as its owner sees it: metadata only, never the value. */
export interface CredentialRecord {
  name: string;
  provider: string;
  addedAt: number;
  validatedAt: number;
  /**
   * Catalog models the provider listed for this key when it was validated, or
   * null when the provider lists none.
   */
  models: string[] | null;
}

/** A user's choice of what their firstmate runs on. */
export interface ModelChoice {
  harness: string;
  provider: string;
  model: string;
  /** An optional cheaper model from the same provider for routine work. */
  routineModel: string | null;
  updatedAt: number;
}

/** What a user wants their managed firstmate to be doing. */
export type TenantDesired = "none" | "running" | "stopped";

/** What the reconciler last saw of a managed firstmate in the cluster. */
export type TenantObserved = "none" | "pending" | "running" | "crashloop" | "stopped";

/** A user's managed firstmate: its cluster id, desired state and last observation. */
export interface TenantRecord {
  userId: string;
  /** Opaque DNS-safe id used in every cluster object name; never derived from the login. */
  tid: string;
  desired: TenantDesired;
  /** Bumped when the delivered credentials change, so the pod restarts and fetches them again. */
  configVersion: number;
  observed: TenantObserved;
  observedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A removed user's tenant: its objects are pruned, its home volume is kept until purged. */
export interface RetainedTenant {
  tid: string;
  removedAt: number;
}

/** A tenant with what the reconciler and delivery need about its owner. */
export interface TenantOwner extends TenantRecord {
  githubId: number;
  login: string;
  userState: UserState;
}

/** What `vault rotate` did. */
export interface RotationResult {
  /** Rows re-sealed under the active key. */
  rotated: number;
  /** Rows already under the active key, left as they were. */
  current: number;
}

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const LOGIN_ATTEMPT_MS = 10 * 60 * 1000;
/** last_seen is written at most this often per session, not on every request. */
const LAST_SEEN_WRITE_MS = 60 * 1000;
/** Bound on concurrent unfinished logins, so the table cannot be grown without limit. */
export const MAX_LIVE_LOGIN_ATTEMPTS = 1000;
export const INVITE_MS = 14 * 24 * 60 * 60 * 1000;
/** A pending request expires, and a denial is remembered, for this long. */
export const ACCESS_REQUEST_MS = 30 * 24 * 60 * 60 * 1000;
/** Pending access requests are capped, so strangers cannot grow the queue without limit. */
export const MAX_PENDING_ACCESS_REQUESTS = 50;
export const LINK_CODE_MS = 5 * 60 * 1000;
/** Link codes use an unambiguous alphabet: no 0/O or 1/I. 32 symbols, 5 bits each. */
export const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 8;
/** A device's public handle: a prefix of its session hash, which reveals nothing usable. */
const DEVICE_HANDLE_LENGTH = 16;

const SCHEMA_VERSION = 4;

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
  2: `
    CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      login_lower TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      redeemed_by TEXT,
      redeemed_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX invites_login ON invites(login_lower);
    CREATE TABLE access_requests (
      github_id INTEGER PRIMARY KEY,
      login TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'denied')),
      decided_at INTEGER,
      decided_by TEXT
    );
    CREATE TABLE link_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `,
  3: `
    CREATE TABLE credentials (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      kid TEXT NOT NULL,
      sealed BLOB NOT NULL,
      added_at INTEGER NOT NULL,
      validated_at INTEGER NOT NULL,
      models TEXT,
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE model_choices (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      harness TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      routine_model TEXT,
      updated_at INTEGER NOT NULL
    );
  `,
  4: `
    CREATE TABLE tenants (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tid TEXT NOT NULL UNIQUE,
      desired TEXT NOT NULL CHECK (desired IN ('none', 'running', 'stopped')),
      config_version INTEGER NOT NULL,
      observed TEXT NOT NULL CHECK (observed IN ('none', 'pending', 'running', 'crashloop', 'stopped')),
      observed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE retained_tenants (
      tid TEXT PRIMARY KEY,
      removed_at INTEGER NOT NULL
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

function newInviteId(): string {
  return `inv_${randomBytes(9).toString("base64url")}`;
}

/** A fresh device link code: LINK_CODE_LENGTH symbols drawn uniformly from the alphabet. */
export function newLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  let code = "";
  // 256 is a multiple of 32, so masking keeps the draw uniform.
  for (const byte of bytes) code += LINK_CODE_ALPHABET[byte & 31];
  return code;
}

/**
 * Normalize a typed link code: case and separators are ignored. Returns null
 * for anything that cannot be a code, so a malformed guess never reaches SQL.
 */
export function normalizeLinkCode(value: string): string | null {
  if (value.length > 64) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== LINK_CODE_LENGTH) return null;
  for (const char of code) if (!LINK_CODE_ALPHABET.includes(char)) return null;
  return code;
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

  userByLogin(login: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE lower(login) = ?").get(login.toLowerCase());
    return row === undefined ? null : toUser(row as Record<string, unknown>);
  }

  listUsers(): UserSummary[] {
    const rows = this.db
      .prepare(
        "SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions " +
          "FROM users u ORDER BY u.created_at, u.id",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...toUser(row), sessions: asNumber(row.sessions) }));
  }

  /** Suspend or resume a user. Suspending also signs them out everywhere. */
  setUserState(userId: string, state: UserState): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE users SET state = ? WHERE id = ?").run(state, userId);
      if (state !== "active") {
        this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        this.db.prepare("DELETE FROM link_codes WHERE user_id = ?").run(userId);
      }
      return asNumber(result.changes) > 0;
    });
  }

  /**
   * Remove a user; their sessions, link codes, credentials, model choice and
   * tenant go with them. A tenant's home volume outlives it in the cluster, so
   * its id is kept as retained until that volume is purged.
   */
  deleteUser(userId: string, now: number): boolean {
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO retained_tenants (tid, removed_at) SELECT tid, ? FROM tenants WHERE user_id = ?")
        .run(now, userId);
      const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return asNumber(result.changes) > 0;
    });
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

  /** A user's signed-in devices, newest first; `currentId` marks the caller's own. */
  listDevices(userId: string, currentId: string | null): DeviceRecord[] {
    const currentHash = currentId === null ? null : sha256Hex(currentId);
    const rows = this.db
      .prepare(
        "SELECT id_hash, label, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, id_hash",
      )
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id_hash).slice(0, DEVICE_HANDLE_LENGTH),
      label: String(row.label),
      createdAt: asNumber(row.created_at),
      lastSeenAt: asNumber(row.last_seen_at),
      current: String(row.id_hash) === currentHash,
    }));
  }

  /** Sign out one of the user's own devices by its handle. Another user's handle matches nothing. */
  deleteDevice(userId: string, handle: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(handle)) return false;
    const result = this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, ?) = ?")
      .run(userId, DEVICE_HANDLE_LENGTH, handle);
    return asNumber(result.changes) > 0;
  }

  /** Sign out every device of the user except the one presenting `keepId`. */
  deleteOtherDevices(userId: string, keepId: string): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?")
      .run(userId, sha256Hex(keepId));
    return asNumber(result.changes);
  }

  /** The device handle of a raw session id, to tell a caller which device is theirs. */
  static deviceHandle(sessionId: string): string {
    return sha256Hex(sessionId).slice(0, DEVICE_HANDLE_LENGTH);
  }

  // ---- invites -------------------------------------------------------------

  /**
   * Invite a GitHub login. An open invite for the same login is extended
   * rather than duplicated. The invite is redeemed by the first sign-in from
   * that login, which then pins the account's numeric id.
   */
  createInvite(login: string, createdBy: string, now: number): InviteRecord {
    const lower = login.toLowerCase();
    return this.transaction(() => {
      const open = this.openInviteRow(lower, now);
      if (open !== null) {
        this.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(now + INVITE_MS, open.id);
        return { ...open, expiresAt: now + INVITE_MS };
      }
      const id = newInviteId();
      this.db
        .prepare("INSERT INTO invites (id, login_lower, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, lower, createdBy, now, now + INVITE_MS);
      return { id, login: lower, createdBy, createdAt: now, expiresAt: now + INVITE_MS };
    });
  }

  private openInviteRow(lower: string, now: number): InviteRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM invites WHERE login_lower = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ? " +
          "ORDER BY created_at DESC LIMIT 1",
      )
      .get(lower, now) as Record<string, unknown> | undefined;
    return row === undefined ? null : toInvite(row);
  }

  /** Open invites (not redeemed, revoked or expired), oldest first. */
  listInvites(now: number): InviteRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM invites WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, id",
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(toInvite);
  }

  revokeInvite(id: string, now: number): boolean {
    const result = this.db
      .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL")
      .run(now, id);
    return asNumber(result.changes) > 0;
  }

  /**
   * Let an invited login in: when an open invite matches, create the user and
   * mark the invite redeemed in one transaction. Returns null without one.
   */
  redeemInvite(githubId: number, login: string, now: number): { user: UserRecord; invite: InviteRecord } | null {
    return this.transaction(() => {
      const invite = this.openInviteRow(login.toLowerCase(), now);
      if (invite === null) return null;
      const user = this.createUser(githubId, login, now);
      this.db.prepare("UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE id = ?").run(user.id, now, invite.id);
      this.db.prepare("DELETE FROM access_requests WHERE github_id = ?").run(githubId);
      return { user, invite };
    });
  }

  // ---- access requests -----------------------------------------------------

  /**
   * Record an uninvited sign-in as a request for access. A request already
   * pending is refreshed; a denial within ACCESS_REQUEST_MS is remembered and
   * not re-queued; past MAX_PENDING_ACCESS_REQUESTS nothing new is recorded.
   */
  recordAccessRequest(githubId: number, login: string, now: number): AccessRequestOutcome {
    return this.transaction(() => {
      this.purgeAccessRequests(now);
      const row = this.db.prepare("SELECT state FROM access_requests WHERE github_id = ?").get(githubId) as
        | Record<string, unknown>
        | undefined;
      if (row?.state === "denied") return "denied";
      if (row?.state === "pending") {
        this.db.prepare("UPDATE access_requests SET login = ? WHERE github_id = ?").run(login, githubId);
        return "pending";
      }
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE state = 'pending'").get() as
        | Record<string, unknown>
        | undefined;
      if (pending !== undefined && asNumber(pending.n) >= MAX_PENDING_ACCESS_REQUESTS) return "full";
      this.db
        .prepare("INSERT INTO access_requests (github_id, login, requested_at, state) VALUES (?, ?, ?, 'pending')")
        .run(githubId, login, now);
      return "pending";
    });
  }

  listAccessRequests(now: number): AccessRequest[] {
    this.purgeAccessRequests(now);
    const rows = this.db
      .prepare("SELECT github_id, login, requested_at FROM access_requests WHERE state = 'pending' ORDER BY requested_at, github_id")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      githubId: asNumber(row.github_id),
      login: String(row.login),
      requestedAt: asNumber(row.requested_at),
    }));
  }

  /** Approve a pending request: the account becomes an active user. Null when none is pending. */
  approveAccessRequest(githubId: number, now: number): UserRecord | null {
    return this.transaction(() => {
      this.purgeAccessRequests(now);
      const row = this.db
        .prepare("SELECT login FROM access_requests WHERE github_id = ? AND state = 'pending'")
        .get(githubId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      this.db.prepare("DELETE FROM access_requests WHERE github_id = ?").run(githubId);
      return this.userByGithubId(githubId) ?? this.createUser(githubId, String(row.login), now);
    });
  }

  /** Deny a pending request; the denial is remembered for ACCESS_REQUEST_MS. */
  denyAccessRequest(githubId: number, deniedBy: string, now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE access_requests SET state = 'denied', decided_at = ?, decided_by = ? WHERE github_id = ? AND state = 'pending'",
      )
      .run(now, deniedBy, githubId);
    return asNumber(result.changes) > 0;
  }

  private purgeAccessRequests(now: number): void {
    this.db
      .prepare(
        "DELETE FROM access_requests WHERE (state = 'pending' AND requested_at <= ?) OR (state = 'denied' AND decided_at <= ?)",
      )
      .run(now - ACCESS_REQUEST_MS, now - ACCESS_REQUEST_MS);
  }

  // ---- device link codes ---------------------------------------------------

  /**
   * Mint a short-lived, single-use code that signs another device in as this
   * user. A user has at most one live code: a new one replaces the last.
   */
  createLinkCode(userId: string, now: number): { code: string; expiresAt: number } {
    const code = newLinkCode();
    this.transaction(() => {
      this.db.prepare("DELETE FROM link_codes WHERE user_id = ? OR expires_at <= ?").run(userId, now);
      this.db
        .prepare("INSERT INTO link_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(sha256Hex(code), userId, now, now + LINK_CODE_MS);
    });
    return { code, expiresAt: now + LINK_CODE_MS };
  }

  /** Spend a link code: returns its active user's id once, or null. */
  redeemLinkCode(typed: string, now: number): string | null {
    const code = normalizeLinkCode(typed);
    if (code === null) return null;
    const codeHash = sha256Hex(code);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT l.user_id, l.expires_at, u.state FROM link_codes l JOIN users u ON u.id = l.user_id WHERE l.code_hash = ?",
        )
        .get(codeHash) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      this.db.prepare("DELETE FROM link_codes WHERE code_hash = ?").run(codeHash);
      if (now >= asNumber(row.expires_at) || row.state !== "active") return null;
      return String(row.user_id);
    });
  }

  // ---- credentials (sealed) -------------------------------------------------

  /** Store (or replace) a sealed credential that was just validated. */
  putCredential(
    userId: string,
    name: string,
    provider: string,
    sealed: SealedValue,
    models: string[] | null,
    now: number,
  ): CredentialRecord {
    this.db
      .prepare(
        "INSERT INTO credentials (user_id, name, provider, kid, sealed, added_at, validated_at, models) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET " +
          "provider = excluded.provider, kid = excluded.kid, sealed = excluded.sealed, " +
          "added_at = excluded.added_at, validated_at = excluded.validated_at, models = excluded.models",
      )
      .run(userId, name, provider, sealed.kid, sealed.blob, now, now, models === null ? null : JSON.stringify(models));
    return { name, provider, addedAt: now, validatedAt: now, models };
  }

  /** A user's credentials, metadata only: the sealed value is never read here. */
  listCredentials(userId: string): CredentialRecord[] {
    const rows = this.db
      .prepare("SELECT name, provider, added_at, validated_at, models FROM credentials WHERE user_id = ? ORDER BY name")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toCredential);
  }

  credential(userId: string, name: string): CredentialRecord | null {
    const row = this.db
      .prepare("SELECT name, provider, added_at, validated_at, models FROM credentials WHERE user_id = ? AND name = ?")
      .get(userId, name) as Record<string, unknown> | undefined;
    return row === undefined ? null : toCredential(row);
  }

  /**
   * One credential's sealed value. Only credential delivery reads it, for the
   * owner's own firstmate; the vault opens it and the caller wipes the result.
   */
  sealedCredential(userId: string, name: string): SealedValue | null {
    const row = this.db
      .prepare("SELECT kid, sealed FROM credentials WHERE user_id = ? AND name = ?")
      .get(userId, name) as Record<string, unknown> | undefined;
    return row === undefined ? null : { kid: String(row.kid), blob: row.sealed as Uint8Array };
  }

  deleteCredential(userId: string, name: string): boolean {
    const result = this.db.prepare("DELETE FROM credentials WHERE user_id = ? AND name = ?").run(userId, name);
    return asNumber(result.changes) > 0;
  }

  /**
   * Re-seal every credential under the vault's active key, in one transaction:
   * either every row moves or none does. A row that will not open (its key id
   * left the keyring, or it was tampered with) aborts the whole rotation, and
   * the error names only the row's owner id and slot.
   */
  rotateCredentials(vault: Vault): RotationResult {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT user_id, name, kid, sealed FROM credentials ORDER BY user_id, name")
        .all() as Array<Record<string, unknown>>;
      let rotated = 0;
      let current = 0;
      const update = this.db.prepare("UPDATE credentials SET kid = ?, sealed = ? WHERE user_id = ? AND name = ?");
      for (const row of rows) {
        const userId = String(row.user_id);
        const name = String(row.name);
        const kid = String(row.kid);
        if (kid === vault.activeKid) {
          current += 1;
          continue;
        }
        let plaintext: Buffer | null = null;
        try {
          plaintext = vault.open(userId, name, { kid, blob: row.sealed as Uint8Array });
          const sealed = vault.seal(userId, name, plaintext);
          update.run(sealed.kid, sealed.blob, userId, name);
          rotated += 1;
        } catch (error) {
          throw new Error(
            `cannot rotate the credential ${name} of user ${userId}: ${error instanceof Error ? error.message : "error"}`,
          );
        } finally {
          wipe(plaintext);
        }
      }
      return { rotated, current };
    });
  }

  // ---- model choice ----------------------------------------------------------

  modelChoice(userId: string): ModelChoice | null {
    const row = this.db.prepare("SELECT * FROM model_choices WHERE user_id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return {
      harness: String(row.harness),
      provider: String(row.provider),
      model: String(row.model),
      routineModel: row.routine_model === null ? null : String(row.routine_model),
      updatedAt: asNumber(row.updated_at),
    };
  }

  setModelChoice(userId: string, choice: Omit<ModelChoice, "updatedAt">, now: number): ModelChoice {
    this.db
      .prepare(
        "INSERT INTO model_choices (user_id, harness, provider, model, routine_model, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (user_id) DO UPDATE SET harness = excluded.harness, provider = excluded.provider, " +
          "model = excluded.model, routine_model = excluded.routine_model, updated_at = excluded.updated_at",
      )
      .run(userId, choice.harness, choice.provider, choice.model, choice.routineModel, now);
    return { ...choice, updatedAt: now };
  }

  // ---- managed tenants -------------------------------------------------------

  /** The user's tenant, with its owner. */
  tenantByUser(userId: string): TenantOwner | null {
    const row = this.db
      .prepare(
        "SELECT t.*, u.github_id, u.login, u.state AS user_state FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.user_id = ?",
      )
      .get(userId) as Record<string, unknown> | undefined;
    return row === undefined ? null : toTenantOwner(row);
  }

  /** A tenant by its cluster id, with its owner. */
  tenantByTid(tid: string): TenantOwner | null {
    const row = this.db
      .prepare(
        "SELECT t.*, u.github_id, u.login, u.state AS user_state FROM tenants t JOIN users u ON u.id = t.user_id WHERE t.tid = ?",
      )
      .get(tid) as Record<string, unknown> | undefined;
    return row === undefined ? null : toTenantOwner(row);
  }

  /** The user's tenant, created on first use with a fresh id and nothing desired yet. */
  ensureTenant(userId: string, now: number): TenantRecord {
    const existing = this.tenantByUser(userId);
    if (existing !== null) return existing;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = this.db
        .prepare(
          "INSERT INTO tenants (user_id, tid, desired, config_version, observed, observed_at, created_at, updated_at) " +
            "VALUES (?, ?, 'none', 1, 'none', NULL, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(userId, newTenantId(), now, now);
      const tenant = this.tenantByUser(userId);
      if (tenant !== null) return tenant;
      if (asNumber(result.changes) > 0) break;
    }
    throw new Error("could not allocate a tenant id");
  }

  setTenantDesired(userId: string, desired: TenantDesired, now: number): TenantRecord | null {
    this.db.prepare("UPDATE tenants SET desired = ?, updated_at = ? WHERE user_id = ?").run(desired, now, userId);
    return this.tenantByUser(userId);
  }

  /** Make the tenant's pod restart onto freshly delivered credentials. */
  bumpTenantConfig(userId: string, now: number): void {
    this.db
      .prepare("UPDATE tenants SET config_version = config_version + 1, updated_at = ? WHERE user_id = ?")
      .run(now, userId);
  }

  recordTenantObserved(tid: string, observed: TenantObserved, now: number): void {
    this.db
      .prepare("UPDATE tenants SET observed = ?, observed_at = ? WHERE tid = ?")
      .run(observed, now, tid);
  }

  /** Every tenant with its owner, oldest first. */
  listTenants(): TenantOwner[] {
    const rows = this.db
      .prepare(
        "SELECT t.*, u.github_id, u.login, u.state AS user_state FROM tenants t JOIN users u ON u.id = t.user_id " +
          "ORDER BY t.created_at, t.tid",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toTenantOwner);
  }

  /** Tenants that hold cluster resources: desired running or stopped. */
  countActiveTenants(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE desired != 'none'").get() as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? 0 : asNumber(row.n);
  }

  /** Removed users' tenants whose home volume is still in the cluster, oldest first. */
  listRetainedTenants(): RetainedTenant[] {
    const rows = this.db.prepare("SELECT tid, removed_at FROM retained_tenants ORDER BY removed_at, tid").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({ tid: String(row.tid), removedAt: asNumber(row.removed_at) }));
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

  /** Drop expired login attempts, sessions, link codes and stale access requests. */
  purgeExpired(now: number): void {
    this.db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM link_codes WHERE expires_at <= ?").run(now);
    this.purgeAccessRequests(now);
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

  /** The newest audit entries, for the admin view. */
  recentAudit(limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare("SELECT at, actor, action, subject, detail FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: asNumber(row.at),
      actor: row.actor === null ? null : String(row.actor),
      action: String(row.action),
      subject: row.subject === null ? null : String(row.subject),
      detail: row.detail === null ? null : (JSON.parse(String(row.detail)) as AuditEntry["detail"]),
    }));
  }
}

function toCredential(row: Record<string, unknown>): CredentialRecord {
  let models: string[] | null = null;
  if (typeof row.models === "string") {
    const parsed = JSON.parse(row.models) as unknown;
    models = Array.isArray(parsed) ? parsed.map(String) : null;
  }
  return {
    name: String(row.name),
    provider: String(row.provider),
    addedAt: asNumber(row.added_at),
    validatedAt: asNumber(row.validated_at),
    models,
  };
}

const TENANT_DESIRED: readonly TenantDesired[] = ["none", "running", "stopped"];
const TENANT_OBSERVED: readonly TenantObserved[] = ["none", "pending", "running", "crashloop", "stopped"];

function toTenant(row: Record<string, unknown>): TenantRecord {
  const desired = String(row.desired);
  const observed = String(row.observed);
  return {
    userId: String(row.user_id),
    tid: String(row.tid),
    desired: (TENANT_DESIRED as readonly string[]).includes(desired) ? (desired as TenantDesired) : "none",
    configVersion: asNumber(row.config_version),
    observed: (TENANT_OBSERVED as readonly string[]).includes(observed) ? (observed as TenantObserved) : "none",
    observedAt: row.observed_at === null ? null : asNumber(row.observed_at),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

function toTenantOwner(row: Record<string, unknown>): TenantOwner {
  return {
    ...toTenant(row),
    githubId: asNumber(row.github_id),
    login: String(row.login),
    userState: row.user_state === "suspended" ? "suspended" : "active",
  };
}

function toInvite(row: Record<string, unknown>): InviteRecord {
  return {
    id: String(row.id),
    login: String(row.login_lower),
    createdBy: String(row.created_by),
    createdAt: asNumber(row.created_at),
    expiresAt: asNumber(row.expires_at),
  };
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
