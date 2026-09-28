import { execFile } from "node:child_process";
import { join } from "node:path";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface FirstmateClient {
  run(script: string, args: readonly string[], stdin?: string): Promise<RunResult>;
}

export class FirstmateError extends Error {
  override name = "FirstmateError";
}

export interface FirstmateOptions {
  binDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Invoke firstmate only through its own scripts.
 *
 * Every call goes through `child_process.execFile` with an argument array and
 * `shell: false`, so request input is always passed as a single literal
 * argument (or on stdin) and can never be interpreted by a shell.
 */
export class Firstmate implements FirstmateClient {
  private readonly binDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: FirstmateOptions) {
    this.binDir = options.binDir;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  }

  run(script: string, args: readonly string[], stdin?: string): Promise<RunResult> {
    if (!/^[A-Za-z0-9._-]+\.sh$/.test(script)) {
      return Promise.reject(new FirstmateError(`refusing to run unexpected script name: ${script}`));
    }
    for (const arg of args) {
      if (typeof arg !== "string") {
        return Promise.reject(new FirstmateError("all firstmate arguments must be strings"));
      }
    }

    const file = join(this.binDir, script);
    return new Promise<RunResult>((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
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
            reject(new FirstmateError(`failed to run ${file}: ${String(error.message ?? error)}`));
            return;
          }
          resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
        },
      );
      if (child.stdin) {
        child.stdin.on("error", () => {
          // The child may exit before stdin is flushed (EPIPE). Its exit code,
          // delivered through the execFile callback, is the authoritative result.
        });
        child.stdin.end(stdin ?? "");
      }
    });
  }
}

/**
 * Return the trimmed stdout when it is a single JSON value, else null. Used to
 * pass firstmate's own JSON through unchanged without trusting malformed output.
 */
export function parseJsonOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/** The documented firstmate read/queue surfaces this service is allowed to touch. */
export const FM_SCRIPTS = {
  inbox: "fm-inbox.sh",
  bearings: "fm-bearings-snapshot.sh",
} as const;
