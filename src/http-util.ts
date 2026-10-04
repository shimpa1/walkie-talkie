import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/** Response helpers shared by the standalone server and the gateway. */

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

export function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, JSON.stringify({ error: message }));
}

/** Past the limit, this much more is read and discarded so the client sees the 413. */
const MAX_DISCARDED_BYTES = 1024 * 1024;

/**
 * Read a request body of at most `limit` bytes. An oversized body rejects at
 * once, but the rest is drained (up to a bound) rather than the socket reset,
 * so a client still uploading receives the 413 instead of a connection error.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let discarded = -1;
    req.on("data", (chunk: Buffer) => {
      if (discarded >= 0) {
        discarded += chunk.length;
        if (discarded > MAX_DISCARDED_BYTES) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > limit) {
        discarded = 0;
        chunks.length = 0;
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (discarded < 0) resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
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

/** Serve one file from the web app directory, refusing any path outside it. */
export async function serveStatic(publicDir: string, res: ServerResponse, pathname: string): Promise<void> {
  const filePath = safeStaticPath(publicDir, pathname);
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
