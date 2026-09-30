import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface HerdrPane {
  paneId: string;
  workspaceId: string | null;
  tabId: string | null;
  agent: string | null;
  status: string | null;
  title: string | null;
  cwd: string | null;
}

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
}

export interface HerdrTab {
  tabId: string;
  workspaceId: string | null;
  label: string;
}

export interface HerdrClient {
  listPanes(): Promise<HerdrPane[]>;
  listWorkspaces(): Promise<HerdrWorkspace[]>;
  listTabs(): Promise<HerdrTab[]>;
  readPane(paneId: string, lines: number): Promise<string>;
}

export class HerdrError extends Error {
  override name = "HerdrError";
  /** herdr's machine-readable error code, when it supplied one. */
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

export interface HerdrOptions {
  /** CLI name on PATH or an absolute path. Defaults to `herdr`. */
  binPath?: string;
  /** Named session every read is scoped to with `--session`. */
  session: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_PANE_ID_LENGTH = 128;
const PANE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/**
 * The exact read-only herdr control calls this service is allowed to make.
 * Anything else is refused before a process is spawned, so the Conversations
 * view can never steer a session, only read it. The safety boundary is the
 * whitelist: no `pane send-text`, `pane run`, `pane close`, or `agent prompt`.
 */
const ALLOWED_READS = new Set(["pane list", "pane read", "workspace list", "tab list"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function herdrError(value: unknown): HerdrError {
  if (isRecord(value)) {
    const message = asString(value.message) ?? asString(value.code) ?? "herdr reported an error";
    return new HerdrError(message, asString(value.code));
  }
  return new HerdrError("herdr reported an error");
}

function tryParseRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** Recover a structured herdr error from either stream, if one is present. */
function jsonErrorFrom(text: string): HerdrError | null {
  const parsed = tryParseRecord(text);
  if (parsed !== null && parsed.error !== undefined) return herdrError(parsed.error);
  return null;
}

function failureMessage(result: RunResult): string {
  const message = result.stderr.trim() || result.stdout.trim();
  return message.length > 0 ? truncate(message) : "herdr command failed";
}

/**
 * Parse a herdr JSON command reply. herdr writes a server/pane error as a JSON
 * object on stderr with a non-zero exit, so both streams are inspected before
 * the (successful) `result` is unwrapped.
 */
function parseCommandResult(result: RunResult): unknown {
  const parsedOut = tryParseRecord(result.stdout);
  if (parsedOut !== null && parsedOut.error !== undefined) throw herdrError(parsedOut.error);
  if (result.code === 0) {
    if (parsedOut !== null) return parsedOut.result;
    if (result.stdout.trim().length === 0) throw new HerdrError("herdr returned no output");
    throw new HerdrError(`herdr returned invalid JSON: ${truncate(result.stdout)}`);
  }
  throw jsonErrorFrom(result.stderr) ?? jsonErrorFrom(result.stdout) ?? new HerdrError(failureMessage(result));
}

function parsePanes(result: unknown): HerdrPane[] {
  if (!isRecord(result) || !Array.isArray(result.panes)) {
    throw new HerdrError("herdr pane list did not return a pane array");
  }
  const panes: HerdrPane[] = [];
  for (const raw of result.panes) {
    if (!isRecord(raw)) continue;
    const paneId = asString(raw.pane_id);
    if (paneId === null) continue;
    panes.push({
      paneId,
      workspaceId: asString(raw.workspace_id),
      tabId: asString(raw.tab_id),
      agent: asString(raw.agent),
      status: asString(raw.agent_status),
      title: asString(raw.terminal_title_stripped) ?? asString(raw.terminal_title),
      cwd: asString(raw.cwd),
    });
  }
  return panes;
}

function parseWorkspaces(result: unknown): HerdrWorkspace[] {
  if (!isRecord(result) || !Array.isArray(result.workspaces)) {
    throw new HerdrError("herdr workspace list did not return a workspace array");
  }
  const workspaces: HerdrWorkspace[] = [];
  for (const raw of result.workspaces) {
    if (!isRecord(raw)) continue;
    const workspaceId = asString(raw.workspace_id);
    if (workspaceId === null) continue;
    workspaces.push({ workspaceId, label: asString(raw.label) ?? workspaceId });
  }
  return workspaces;
}

function parseTabs(result: unknown): HerdrTab[] {
  if (!isRecord(result) || !Array.isArray(result.tabs)) {
    throw new HerdrError("herdr tab list did not return a tab array");
  }
  const tabs: HerdrTab[] = [];
  for (const raw of result.tabs) {
    if (!isRecord(raw)) continue;
    const tabId = asString(raw.tab_id);
    if (tabId === null) continue;
    tabs.push({
      tabId,
      workspaceId: asString(raw.workspace_id),
      label: asString(raw.label) ?? "",
    });
  }
  return tabs;
}

export function isValidPaneId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PANE_ID_LENGTH && PANE_ID_PATTERN.test(value);
}

/**
 * A read-only herdr client. Every invocation goes through `child_process.execFile`
 * with an argument array and `shell: false`, scoped to one named session with a
 * trailing `--session <name>` flag (firstmate verified the env var alone is not
 * reliably honored when another herdr server is bound on the host).
 */
export class Herdr implements HerdrClient {
  private readonly binPath: string;
  private readonly session: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: HerdrOptions) {
    this.binPath = options.binPath ?? "herdr";
    this.session = options.session;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  private runRead(args: readonly string[]): Promise<RunResult> {
    const key = `${args[0] ?? ""} ${args[1] ?? ""}`;
    if (!ALLOWED_READS.has(key)) {
      return Promise.reject(new HerdrError(`refusing to run non-read herdr command: ${truncate(key)}`));
    }
    for (const arg of args) {
      if (typeof arg !== "string") {
        return Promise.reject(new HerdrError("all herdr arguments must be strings"));
      }
    }
    const argv = [...args, "--session", this.session];
    return new Promise<RunResult>((resolve, reject) => {
      execFile(
        this.binPath,
        argv,
        {
          shell: false,
          env: this.env,
          timeout: this.timeoutMs,
          maxBuffer: this.maxBuffer,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(
              new HerdrError(`failed to run herdr ${truncate(key)}: ${truncate(error.message ?? String(error))}`),
            );
            return;
          }
          resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
        },
      );
    });
  }

  async listPanes(): Promise<HerdrPane[]> {
    const result = await this.runRead(["pane", "list"]);
    return parsePanes(parseCommandResult(result));
  }

  async listWorkspaces(): Promise<HerdrWorkspace[]> {
    const result = await this.runRead(["workspace", "list"]);
    return parseWorkspaces(parseCommandResult(result));
  }

  async listTabs(): Promise<HerdrTab[]> {
    const result = await this.runRead(["tab", "list"]);
    return parseTabs(parseCommandResult(result));
  }

  async readPane(paneId: string, lines: number): Promise<string> {
    if (!isValidPaneId(paneId)) throw new HerdrError(`invalid pane id: ${truncate(paneId)}`);
    const result = await this.runRead([
      "pane",
      "read",
      paneId,
      "--lines",
      String(lines),
      "--source",
      "recent",
      "--format",
      "text",
    ]);
    // `pane read --format text` prints plain terminal text on success, but an
    // unknown pane is a JSON error object on stderr with a non-zero exit, so
    // that is surfaced as a HerdrError and any other output is the pane's text.
    if (result.code !== 0) {
      throw jsonErrorFrom(result.stderr) ?? jsonErrorFrom(result.stdout) ?? new HerdrError(failureMessage(result));
    }
    const parsed = tryParseRecord(result.stdout);
    if (parsed !== null && parsed.error !== undefined) throw herdrError(parsed.error);
    return result.stdout;
  }
}
