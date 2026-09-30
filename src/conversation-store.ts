/**
 * Read-only access to the coding agent's own session store.
 *
 * The terminal front end only keeps the visible screen (herdr's `pane read`
 * returns roughly one viewport even with a large `--lines`), so a session's
 * real conversation has to come from the agent that recorded it. opencode keeps
 * it in a SQLite database under the firstmate home; this module reads a bounded
 * page of `message`/`part` rows from it.
 *
 * The connection is opened read-only and additionally pinned with
 * `PRAGMA query_only`, so the store is never written to, even if the Node
 * runtime ignored the read-only flag. Every failure - a missing module, a
 * missing database, a locked file, an unexpected schema - degrades to `null`,
 * letting the caller fall back to the terminal read.
 */

/** A single rendered conversation turn: one message's text. */
export interface StoredConversationMessage {
  id: string;
  role: string;
  /** Unix milliseconds the message was created. */
  time: number;
  text: string;
}

/** One page of a session's history, ordered oldest-to-newest. */
export interface StoredConversationPage {
  messages: StoredConversationMessage[];
  has_older: boolean;
  has_newer: boolean;
  oldest_cursor: string | null;
  newest_cursor: string | null;
}

export interface HistoryQuery {
  limit: number;
  /** Load messages older than this cursor. */
  before?: string | null;
  /** Load messages newer than this cursor. */
  after?: string | null;
}

export interface ConversationStore {
  /**
   * Read a bounded, cursor-paginated page of a session's message history.
   * Returns `null` when the store is unavailable or the session is unknown, so
   * the caller can fall back to the terminal view.
   */
  readHistory(sessionId: string, query: HistoryQuery): Promise<StoredConversationPage | null>;
}

export const DEFAULT_HISTORY_LIMIT = 200;
export const MAX_HISTORY_LIMIT = 1000;
const MIN_HISTORY_LIMIT = 1;

/** Clamp a user-supplied page size to a bounded, cheap read. */
export function clampHistoryLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_HISTORY_LIMIT;
  if (parsed < MIN_HISTORY_LIMIT) return MIN_HISTORY_LIMIT;
  if (parsed > MAX_HISTORY_LIMIT) return MAX_HISTORY_LIMIT;
  return parsed;
}

// opencode session ids look like `ses_<base62>`; message ids like `msg_<base62>`.
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CURSOR_LENGTH = 200;

/** Bound a single message's rendered text so one huge paste cannot bloat a page. */
const MAX_MESSAGE_CHARS = 100_000;
const TRUNCATED_SUFFIX = "\n… (truncated)";

interface HistoryCursor {
  time: number;
  id: string;
}

function encodeCursor(time: number, id: string): string {
  return `${time}:${id}`;
}

function decodeCursor(value: string | null | undefined): HistoryCursor | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const time = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isSafeInteger(time) || time < 0) return null;
  if (!MESSAGE_ID_PATTERN.test(id)) return null;
  return { time, id };
}

/** Whether a caller-supplied cursor is well-formed; the route rejects a bad one. */
export function isValidHistoryCursor(value: string): boolean {
  return decodeCursor(value) !== null;
}

function extractText(data: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const text = (parsed as Record<string, unknown>).text;
  if (typeof text !== "string" || text.length === 0) return "";
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS) + TRUNCATED_SUFFIX;
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;

export interface OpencodeStoreOptions {
  /** Absolute path to opencode's SQLite database. */
  dbPath: string;
  /** Optional diagnostics sink. The store never throws for a missing store. */
  log?: (line: string) => void;
}

interface MessageRow {
  id: string;
  time: number;
  role: string | null;
}

interface PartRow {
  message_id: string;
  data: string;
}

const PART_CHUNK = 500;

/**
 * A read-only reader over opencode's SQLite session store. The connection is
 * opened lazily so a service with no agent store still starts; every read that
 * cannot be served returns `null` rather than throwing.
 */
export class OpencodeStore implements ConversationStore {
  private readonly dbPath: string;
  private readonly log: (line: string) => void;
  private db: SqliteDatabase | null = null;
  private opened = false;

  constructor(options: OpencodeStoreOptions) {
    this.dbPath = options.dbPath;
    this.log = options.log ?? ((): void => {});
  }

  private async open(): Promise<SqliteDatabase | null> {
    if (this.opened) return this.db;
    this.opened = true;
    try {
      // Dynamic import so a runtime without node:sqlite degrades instead of
      // crashing the whole service at startup.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 5000 });
      // Belt and braces against an older runtime that ignores `readOnly`:
      // query_only makes the connection refuse every write.
      db.exec("PRAGMA query_only = ON");
      db.exec("PRAGMA busy_timeout = 5000");
      this.db = db;
    } catch (error) {
      this.db = null;
      this.log(`conversation history disabled: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.db;
  }

  private sessionExists(db: SqliteDatabase, sessionId: string): boolean {
    const row = db.prepare("SELECT 1 AS present FROM session WHERE id = ? LIMIT 1").get(sessionId);
    return row !== undefined;
  }

  private textByMessage(db: SqliteDatabase, ids: readonly string[]): Map<string, string> {
    const texts = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += PART_CHUNK) {
      const chunk = ids.slice(offset, offset + PART_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT message_id, data FROM part WHERE message_id IN (${placeholders}) ` +
            "AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') END = 'text' " +
            "ORDER BY time_created, id",
        )
        .all(...chunk) as unknown as PartRow[];
      for (const row of rows) {
        const text = extractText(row.data);
        if (text.length === 0) continue;
        const existing = texts.get(row.message_id);
        texts.set(row.message_id, existing === undefined ? text : `${existing}\n${text}`);
      }
    }
    return texts;
  }

  async readHistory(sessionId: string, query: HistoryQuery): Promise<StoredConversationPage | null> {
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    const db = await this.open();
    if (db === null) return null;
    const limit = clampHistoryLimit(query.limit);
    try {
      if (!this.sessionExists(db, sessionId)) return null;

      const before = decodeCursor(query.before ?? null);
      const after = decodeCursor(query.after ?? null);
      const descending = after === null;
      const cursor = after ?? before;

      const conditions = ["session_id = ?"];
      const params: Array<string | number> = [sessionId];
      if (cursor !== null) {
        const operator = descending ? "<" : ">";
        conditions.push(`(time_created ${operator} ? OR (time_created = ? AND id ${operator} ?))`);
        params.push(cursor.time, cursor.time, cursor.id);
      }
      const order = descending ? "DESC" : "ASC";
      params.push(limit + 1);

      let rows = db
        .prepare(
          "SELECT id, time_created AS time, " +
            "CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END AS role FROM message " +
            `WHERE ${conditions.join(" AND ")} ORDER BY time_created ${order}, id ${order} LIMIT ?`,
        )
        .all(...params) as unknown as MessageRow[];
      const hasExtra = rows.length > limit;
      rows = rows.slice(0, limit);
      if (descending) rows.reverse();

      const oldest = rows[0] ?? null;
      const newest = rows[rows.length - 1] ?? null;
      const texts = this.textByMessage(
        db,
        rows.map((row) => row.id),
      );

      const messages: StoredConversationMessage[] = [];
      for (const row of rows) {
        const text = texts.get(row.id);
        if (text === undefined || text.length === 0) continue;
        messages.push({ id: row.id, role: row.role ?? "assistant", time: row.time, text });
      }

      return {
        messages,
        has_older: descending ? hasExtra : true,
        has_newer: descending ? before !== null : hasExtra,
        oldest_cursor: oldest === null ? null : encodeCursor(oldest.time, oldest.id),
        newest_cursor: newest === null ? null : encodeCursor(newest.time, newest.id),
      };
    } catch (error) {
      this.log(
        `conversation history read failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
