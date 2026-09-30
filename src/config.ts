import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  fmHome: string;
  fmBin: string;
  host: string;
  port: number;
  token: string;
  publicDir: string;
  allowPublicBind: boolean;
  configFile: string | null;
  /** VAPID contact for the push token; a mailto: URL is conventional. */
  vapidSubject: string;
  /** Explicit VAPID keys, or null to generate and persist them on first run. */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  /** How often the service polls firstmate for new events, in seconds. */
  pushPollSeconds: number;
  /** Gitignored file holding the VAPID keys, subscriptions, and event cursor. */
  pushStorePath: string;
  /** Named herdr session whose panes the read-only Conversations view enumerates. */
  herdrSession: string;
  /** herdr CLI executable: a name resolved on PATH or an absolute path. */
  herdrBin: string;
  /**
   * opencode's session store (SQLite), read read-only for the Conversations
   * history view. Defaults to `<fmHome>/.local/share/opencode/opencode.db`.
   */
  opencodeDbPath: string;
}

interface FileConfig {
  fmHome?: unknown;
  fmBin?: unknown;
  host?: unknown;
  port?: unknown;
  token?: unknown;
  publicDir?: unknown;
  allowPublicBind?: unknown;
  vapidSubject?: unknown;
  vapidPublicKey?: unknown;
  vapidPrivateKey?: unknown;
  pushPollSeconds?: unknown;
  pushStore?: unknown;
  herdrSession?: unknown;
  herdrBin?: unknown;
  opencodeDbPath?: unknown;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_CONFIG_FILE = "walkie-talkie.config.json";
export const DEFAULT_VAPID_SUBJECT = "mailto:admin@localhost";
export const DEFAULT_PUSH_POLL_SECONDS = 20;
export const DEFAULT_PUSH_STORE = "walkie-talkie.push.json";
export const MIN_PUSH_POLL_SECONDS = 5;
export const MAX_PUSH_POLL_SECONDS = 24 * 60 * 60;
export const DEFAULT_HERDR_SESSION = "default";
export const DEFAULT_HERDR_BIN = "herdr";

/** The opencode session store that lives under a firstmate home. */
export function defaultOpencodeDbPath(fmHome: string): string {
  return join(fmHome, ".local", "share", "opencode", "opencode.db");
}

export function defaultPublicDir(from: string): string {
  return resolve(from, "public");
}

function asString(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`config key ${key} must be a string`);
  }
  return value;
}

function asBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new ConfigError(`config key ${key} must be a boolean`);
}

function readConfigFile(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ConfigError(`cannot read config file ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`config file ${path} must contain a JSON object`);
  }
  return parsed as FileConfig;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`FM_WT_PORT must be an integer between 0 and 65535, got ${value}`);
  }
  return port;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  publicDirFallback?: string;
}

/**
 * Resolve configuration from a gitignored JSON file plus environment variables.
 * Environment always wins over the file so a secret never has to be written down.
 */
export function resolveConfig(options: ResolveOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const configFileSetting = env.FM_WT_CONFIG?.trim();
  const configFile = configFileSetting
    ? resolve(cwd, configFileSetting)
    : resolve(cwd, DEFAULT_CONFIG_FILE);
  const file = readConfigFile(configFile);

  const fmHomeRaw =
    env.FM_HOME?.trim() || asString(file.fmHome, "fmHome") || join(homedir(), "firstmate");
  if (fmHomeRaw.length === 0) throw new ConfigError("FM_HOME must not be empty");
  const fmHome = isAbsolute(fmHomeRaw) ? fmHomeRaw : resolve(cwd, fmHomeRaw);

  const fmBinRaw = env.FM_BIN?.trim() || asString(file.fmBin, "fmBin") || join(fmHome, "bin");
  const fmBin = isAbsolute(fmBinRaw) ? fmBinRaw : resolve(cwd, fmBinRaw);

  const host = env.FM_WT_HOST?.trim() || asString(file.host, "host") || DEFAULT_HOST;

  const port = parsePort(env.FM_WT_PORT) ?? (file.port === undefined
    ? DEFAULT_PORT
    : parsePortFile(file.port));

  const token = env.FM_WT_TOKEN ?? asString(file.token, "token") ?? "";
  if (token.trim().length === 0) {
    throw new ConfigError(
      "FM_WT_TOKEN is required: set it in the environment or in the gitignored config file",
    );
  }

  const publicDirRaw =
    env.FM_WT_PUBLIC_DIR?.trim() ||
    asString(file.publicDir, "publicDir") ||
    options.publicDirFallback ||
    defaultPublicDir(cwd);
  const publicDir = isAbsolute(publicDirRaw) ? publicDirRaw : resolve(cwd, publicDirRaw);

  const allowPublicBind =
    parseFlag(env.FM_WT_ALLOW_PUBLIC_BIND) ??
    asBoolean(file.allowPublicBind, "allowPublicBind") ??
    false;

  const vapidSubject =
    env.FM_WT_VAPID_SUBJECT?.trim() ||
    asString(file.vapidSubject, "vapidSubject") ||
    DEFAULT_VAPID_SUBJECT;

  const vapidPublicKey =
    env.FM_WT_VAPID_PUBLIC_KEY?.trim() || asString(file.vapidPublicKey, "vapidPublicKey") || null;
  const vapidPrivateKey =
    env.FM_WT_VAPID_PRIVATE_KEY?.trim() || asString(file.vapidPrivateKey, "vapidPrivateKey") || null;
  if ((vapidPublicKey === null) !== (vapidPrivateKey === null)) {
    throw new ConfigError(
      "vapidPublicKey and vapidPrivateKey must be set together (or both left unset to generate them)",
    );
  }

  const pushPollSeconds =
    parsePollSeconds(env.FM_WT_PUSH_POLL_SECONDS) ??
    (file.pushPollSeconds === undefined
      ? DEFAULT_PUSH_POLL_SECONDS
      : parsePollSecondsFile(file.pushPollSeconds));

  const pushStoreRaw =
    env.FM_WT_PUSH_STORE?.trim() || asString(file.pushStore, "pushStore") || DEFAULT_PUSH_STORE;
  const pushStorePath = isAbsolute(pushStoreRaw) ? pushStoreRaw : resolve(cwd, pushStoreRaw);

  // The Conversations view reads the pod's own herdr session. In the co-deployed
  // pod HERDR_SESSION is already exported to both containers, so it is the
  // ambient default; FM_WT_HERDR_SESSION (or the config file) overrides it.
  const herdrSession =
    env.FM_WT_HERDR_SESSION?.trim() ||
    asString(file.herdrSession, "herdrSession") ||
    env.HERDR_SESSION?.trim() ||
    DEFAULT_HERDR_SESSION;
  const herdrBin =
    env.FM_WT_HERDR_BIN?.trim() || asString(file.herdrBin, "herdrBin") || DEFAULT_HERDR_BIN;

  // The agent's own session store (opencode SQLite) is read read-only to show a
  // session's full conversation instead of the terminal's visible screen. It
  // lives under the firstmate home in the co-deployed pod.
  const opencodeDbRaw =
    env.FM_WT_OPENCODE_DB?.trim() ||
    asString(file.opencodeDbPath, "opencodeDbPath") ||
    defaultOpencodeDbPath(fmHome);
  const opencodeDbPath = isAbsolute(opencodeDbRaw) ? opencodeDbRaw : resolve(cwd, opencodeDbRaw);

  return {
    fmHome,
    fmBin,
    host,
    port,
    token,
    publicDir,
    allowPublicBind,
    configFile,
    vapidSubject,
    vapidPublicKey,
    vapidPrivateKey,
    pushPollSeconds,
    pushStorePath,
    herdrSession,
    herdrBin,
    opencodeDbPath,
  };
}

function parsePollSeconds(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_PUSH_POLL_SECONDS || seconds > MAX_PUSH_POLL_SECONDS) {
    throw new ConfigError(
      `FM_WT_PUSH_POLL_SECONDS must be an integer between ${MIN_PUSH_POLL_SECONDS} and ${MAX_PUSH_POLL_SECONDS}, got ${value}`,
    );
  }
  return seconds;
}

function parsePollSecondsFile(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= MIN_PUSH_POLL_SECONDS && value <= MAX_PUSH_POLL_SECONDS) {
      return value;
    }
    throw new ConfigError(
      `config key pushPollSeconds must be between ${MIN_PUSH_POLL_SECONDS} and ${MAX_PUSH_POLL_SECONDS}`,
    );
  }
  if (typeof value === "string") {
    const parsed = parsePollSeconds(value);
    if (parsed !== undefined) return parsed;
  }
  throw new ConfigError("config key pushPollSeconds must be a number");
}

function parsePortFile(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 65535) return value;
    throw new ConfigError(`config key port must be between 0 and 65535`);
  }
  if (typeof value === "string") {
    const parsed = parsePort(value);
    if (parsed !== undefined) return parsed;
  }
  throw new ConfigError("config key port must be a number");
}

function parseFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new ConfigError(`FM_WT_ALLOW_PUBLIC_BIND must be 0/1 or true/false, got ${value}`);
}

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "::ffff:127.0.0.1",
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Return a human-readable reason the bind should be refused, or null when allowed.
 * The service defaults to loopback and refuses a public interface unless the
 * operator explicitly overrides it.
 */
export function bindRefusal(config: AppConfig): string | null {
  if (isLoopbackHost(config.host) || config.allowPublicBind) return null;
  return (
    `refusing to bind ${config.host}: this would expose the service beyond the machine. ` +
    "Set FM_WT_HOST=127.0.0.1, or set FM_WT_ALLOW_PUBLIC_BIND=1 to override deliberately."
  );
}
