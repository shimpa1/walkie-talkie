import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { AppConfig } from "./config.js";
import { bindRefusal, isLoopbackHost } from "./config.js";
import { isAuthorized } from "./auth.js";
import { clampLines, type Conversations } from "./conversations.js";
import { clampHistoryLimit, isValidHistoryCursor } from "./conversation-store.js";
import { FM_SCRIPTS, parseJsonOutput, type FirstmateClient } from "./firstmate.js";
import { HerdrError, isValidPaneId } from "./herdr.js";
import type { PushApi } from "./push-service.js";
import {
  isValidPushEndpoint,
  isValidPushSubscription,
  isValidRequestId,
  MAX_INSTRUCTION_BYTES,
  newRequestId,
} from "./validate.js";

export interface AppDeps {
  config: AppConfig;
  firstmate: FirstmateClient;
  /** Present when push is configured; push routes answer 503 without it. */
  push?: PushApi;
  /** Read-only Conversations view; routes answer 503 without it. */
  conversations?: Conversations;
  log?: (line: string) => void;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, JSON.stringify({ error: message }));
}

/**
 * Map a herdr read failure to an HTTP status: an unknown pane is 404, an
 * unreachable herdr server is 503, and any other read failure is 502. A
 * non-herdr error is rethrown for the outer handler to report as a 500.
 */
function sendHerdrError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof HerdrError)) throw error;
  const status = error.code === "pane_not_found" ? 404 : error.code === "server_not_running" ? 503 : 502;
  sendError(res, status, error.message);
}

const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export const MAX_PUSH_BODY_BYTES = 8 * 1024;

interface NoteBody {
  text: string;
  requestId: string;
}

/**
 * Read a JSON object request body, responding with the proper error otherwise.
 * Returns null when it has already answered the request.
 */
async function readJsonObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
): Promise<Record<string, unknown> | null> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    sendError(res, 400, "request body must be application/json");
    return null;
  }
  let raw: string;
  try {
    raw = await readBody(req, limit);
  } catch {
    sendError(res, 413, "request body too large");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendError(res, 400, "request body is not valid JSON");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendError(res, 400, "request body must be a JSON object");
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseNoteBody(raw: string, contentType: string): NoteBody | { error: string } {
  if (!contentType.includes("application/json")) {
    return { error: "request body must be application/json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "request body must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return { error: "JSON body requires a string 'text' field" };
  }
  const text = record.text;
  let requestId: string | undefined;
  const jsonId = record.requestId;
  if (jsonId !== undefined) {
    if (typeof jsonId !== "string") return { error: "'requestId' must be a string" };
    requestId = jsonId.trim();
  }

  if (text.trim().length === 0) {
    return { error: "instruction text must not be empty" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INSTRUCTION_BYTES) {
    return { error: `instruction text exceeds ${MAX_INSTRUCTION_BYTES} bytes` };
  }

  if (requestId === undefined) {
    requestId = newRequestId();
  } else if (!isValidRequestId(requestId)) {
    return { error: "requestId must match [A-Za-z0-9._:-]{1,128} and not start with a dot" };
  }

  return { text, requestId };
}

function safeStaticPath(publicDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = normalize(join(publicDir, relative));
  const root = resolve(publicDir);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function serveStatic(deps: AppDeps, res: ServerResponse, pathname: string): Promise<void> {
  const filePath = safeStaticPath(deps.config.publicDir, pathname);
  if (filePath === null) {
    sendError(res, 404, "not found");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendError(res, 404, "not found");
      return;
    }
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": pathname === "/" ? "no-store" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    sendError(res, 404, "not found");
  }
}

export function createRequestHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { firstmate } = deps;

  return (req, res): void => {
    void handle(req, res).catch((error: unknown) => {
      deps.log?.(`unhandled request error: ${String(error)}`);
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api/health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "method not allowed");
        return;
      }
      const result = await firstmate.run(FM_SCRIPTS.inbox, ["ready"]);
      const body = parseJsonOutput(result.stdout);
      if (result.code !== 0 || body === null) {
        sendError(res, 502, result.stderr.trim() || "firstmate ready failed");
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    // The VAPID public key is not secret: the browser must fetch it before it
    // can subscribe, so this one push endpoint is deliberately open.
    if (pathname === "/api/push/config") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "method not allowed");
        return;
      }
      if (deps.push === undefined) {
        sendError(res, 503, "push is not configured");
        return;
      }
      sendJson(res, 200, JSON.stringify({ publicKey: deps.push.publicKey() }));
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!isAuthorized(req.headers.authorization, deps.config.token)) {
        res.setHeader("www-authenticate", "Bearer");
        sendError(res, 401, "unauthorized");
        return;
      }

      if (pathname === "/api/status") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendError(res, 405, "method not allowed");
          return;
        }
        const result = await firstmate.run(FM_SCRIPTS.bearings, ["--json"]);
        const body = parseJsonOutput(result.stdout);
        if (result.code !== 0 || body === null) {
          sendError(res, 502, result.stderr.trim() || "firstmate bearings failed");
          return;
        }
        sendJson(res, 200, body);
        return;
      }

      if (pathname === "/api/receipts") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendError(res, 405, "method not allowed");
          return;
        }
        const after = url.searchParams.get("after");
        const args = after === null || after === ""
          ? ["receipts"]
          : ["receipts", "--after", after];
        const result = await firstmate.run(FM_SCRIPTS.inbox, args);
        const body = parseJsonOutput(result.stdout);
        if (result.code !== 0 || body === null) {
          sendError(res, 502, result.stderr.trim() || "firstmate receipts failed");
          return;
        }
        sendJson(res, 200, body);
        return;
      }

      if (pathname === "/api/sessions") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendError(res, 405, "method not allowed");
          return;
        }
        if (deps.conversations === undefined) {
          sendError(res, 503, "conversations are not available");
          return;
        }
        try {
          const body = await deps.conversations.list();
          sendJson(res, 200, JSON.stringify(body));
        } catch (error) {
          sendHerdrError(res, error);
        }
        return;
      }

      const sessionMatch = SESSION_PATH.exec(pathname);
      if (sessionMatch) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendError(res, 405, "method not allowed");
          return;
        }
        if (deps.conversations === undefined) {
          sendError(res, 503, "conversations are not available");
          return;
        }
        const rawId = sessionMatch[1];
        let paneId: string;
        try {
          paneId = rawId === undefined ? "" : decodeURIComponent(rawId);
        } catch {
          sendError(res, 400, "invalid session id");
          return;
        }
        if (!isValidPaneId(paneId)) {
          sendError(res, 400, "invalid session id");
          return;
        }
        const before = url.searchParams.get("before");
        if (before !== null && before !== "" && !isValidHistoryCursor(before)) {
          sendError(res, 400, "invalid history cursor");
          return;
        }
        const lines = clampLines(url.searchParams.get("lines"));
        try {
          const body = await deps.conversations.history(paneId, {
            limit: clampHistoryLimit(url.searchParams.get("limit")),
            before: before === null || before === "" ? null : before,
            lines,
          });
          sendJson(res, 200, JSON.stringify(body));
        } catch (error) {
          sendHerdrError(res, error);
        }
        return;
      }

      if (pathname === "/api/note") {
        if (req.method !== "POST") {
          sendError(res, 405, "method not allowed");
          return;
        }
        let raw: string;
        try {
          raw = await readBody(req, MAX_INSTRUCTION_BYTES + 4096);
        } catch {
          sendError(res, 413, "request body too large");
          return;
        }
        const parsedResult = parseNoteBody(
          raw,
          String(req.headers["content-type"] ?? ""),
        );
        if ("error" in parsedResult) {
          sendError(res, 400, parsedResult.error);
          return;
        }
        const result = await firstmate.run(
          FM_SCRIPTS.inbox,
          ["note", "--request-id", parsedResult.requestId, "--json", "-"],
          parsedResult.text,
        );
        const body = parseJsonOutput(result.stdout);
        if (body === null || (result.code !== 0 && result.code !== 3)) {
          sendError(res, 502, result.stderr.trim() || "firstmate note failed");
          return;
        }
        sendJson(res, 200, body);
        return;
      }

      if (pathname === "/api/push/subscribe") {
        if (req.method !== "POST") {
          sendError(res, 405, "method not allowed");
          return;
        }
        if (deps.push === undefined) {
          sendError(res, 503, "push is not configured");
          return;
        }
        const body = await readJsonObjectBody(req, res, MAX_PUSH_BODY_BYTES);
        if (body === null) return;
        if (!isValidPushSubscription(body)) {
          sendError(res, 400, "invalid push subscription");
          return;
        }
        const result = deps.push.addSubscription({
          endpoint: body.endpoint,
          keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
        });
        sendJson(res, 200, JSON.stringify({ ok: true, replaced: result.replaced }));
        return;
      }

      if (pathname === "/api/push/unsubscribe") {
        if (req.method !== "POST") {
          sendError(res, 405, "method not allowed");
          return;
        }
        if (deps.push === undefined) {
          sendError(res, 503, "push is not configured");
          return;
        }
        const body = await readJsonObjectBody(req, res, MAX_PUSH_BODY_BYTES);
        if (body === null) return;
        const endpoint = body.endpoint;
        if (typeof endpoint !== "string" || !isValidPushEndpoint(endpoint)) {
          sendError(res, 400, "invalid push endpoint");
          return;
        }
        const removed = deps.push.removeSubscription(endpoint);
        sendJson(res, 200, JSON.stringify({ removed }));
        return;
      }

      if (pathname === "/api/push/test") {
        if (req.method !== "POST") {
          sendError(res, 405, "method not allowed");
          return;
        }
        if (deps.push === undefined) {
          sendError(res, 503, "push is not configured");
          return;
        }
        const summary = await deps.push.sendTest();
        sendJson(res, 200, JSON.stringify(summary));
        return;
      }

      sendError(res, 404, "not found");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "method not allowed");
      return;
    }
    await serveStatic(deps, res, pathname);
  }
}

export interface StartOptions extends AppDeps {
  onListen?: (port: number) => void;
}

/** Create the HTTP server without binding, so tests and callers can control listen(). */
export function createAppServer(deps: AppDeps): Server {
  return createServer(createRequestHandler(deps));
}

export function startServer(options: StartOptions): Server {
  const refusal = bindRefusal(options.config);
  if (refusal !== null) throw new Error(refusal);

  const server = createAppServer(options);
  server.listen(options.config.port, options.config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.config.port;
    options.onListen?.(port);
  });
  return server;
}

export function describeBind(config: AppConfig, port: number = config.port): string {
  const scope = isLoopbackHost(config.host) ? "loopback only" : "non-loopback";
  return `${config.host}:${port} (${scope})`;
}
