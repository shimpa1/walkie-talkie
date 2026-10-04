import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

import { readBody, sendError } from "./http-util.js";
import { MAX_INSTRUCTION_BYTES } from "./validate.js";

/**
 * Forward a signed-in user's API call to that user's own firstmate.
 *
 * The gateway passes through only the firstmate API the standalone service
 * already serves, with the same methods and body limits. The upstream is chosen
 * by the caller (from the authenticated session), never from the request: no
 * header, path segment or query parameter can name or influence it.
 *
 * Request hygiene: only `accept` and `content-type` are copied; the caller's
 * Cookie, Authorization, forwarding and hop-by-hop headers are dropped, and the
 * tenant's own bearer token is added. Response hygiene: only `content-type`
 * and `content-length` are copied, so an upstream can never set a cookie on
 * the gateway's origin. Bodies are streamed and never logged.
 */

export interface ProxyRoute {
  pattern: RegExp;
  methods: readonly string[];
  /** Largest request body accepted; 0 for routes that take none. */
  bodyLimit: number;
}

export interface ProxyTarget {
  /** Origin of the tenant's walkie-talkie service. */
  upstream: string;
  /** Bearer token the tenant accepts. */
  token: string;
}

const READ = ["GET", "HEAD"] as const;
const PUSH_BODY_LIMIT = 8 * 1024;

/** The firstmate API, exactly as the standalone service exposes it. */
export const PROXY_ROUTES: readonly ProxyRoute[] = [
  { pattern: /^\/api\/health$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/status$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/firstmate$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/receipts$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/sessions$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/sessions\/[^/]+$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/push\/config$/, methods: READ, bodyLimit: 0 },
  { pattern: /^\/api\/note$/, methods: ["POST"], bodyLimit: MAX_INSTRUCTION_BYTES + 4096 },
  { pattern: /^\/api\/push\/subscribe$/, methods: ["POST"], bodyLimit: PUSH_BODY_LIMIT },
  { pattern: /^\/api\/push\/unsubscribe$/, methods: ["POST"], bodyLimit: PUSH_BODY_LIMIT },
  { pattern: /^\/api\/push\/test$/, methods: ["POST"], bodyLimit: PUSH_BODY_LIMIT },
];

export function matchProxyRoute(pathname: string): ProxyRoute | null {
  return PROXY_ROUTES.find((route) => route.pattern.test(pathname)) ?? null;
}

/** Longer than firstmate's own 60 s script timeout, so its errors surface first. */
export const DEFAULT_PROXY_TIMEOUT_MS = 70_000;
const MAX_QUERY_LENGTH = 2048;
const MAX_CONTENT_TYPE_LENGTH = 200;

export interface ProxyOptions {
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Identifies the tenant in a log line; never a secret. */
  label?: string;
}

function headerString(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : null;
}

/**
 * Forward `req` to `target` at `path` (an already-normalized pathname plus
 * query string). The caller has matched `route` and checked the method.
 */
export async function proxyToTenant(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  path: { pathname: string; search: string },
  route: ProxyRoute,
  options: ProxyOptions = {},
): Promise<void> {
  if (path.search.length > MAX_QUERY_LENGTH) {
    sendError(res, 414, "query string too long");
    return;
  }

  let body: Buffer | null = null;
  if (route.bodyLimit > 0) {
    try {
      body = Buffer.from(await readBody(req, route.bodyLimit), "utf8");
    } catch {
      sendError(res, 413, "request body too large");
      return;
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${target.token}`,
    accept: headerString(req.headers.accept)?.slice(0, 200) ?? "*/*",
  };
  const contentType = headerString(req.headers["content-type"]);
  if (body !== null) {
    if (contentType !== null && contentType.length <= MAX_CONTENT_TYPE_LENGTH) {
      headers["content-type"] = contentType;
    }
    headers["content-length"] = String(body.length);
  }

  const url = new URL(path.pathname + path.search, target.upstream);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (status: number, message: string): void => {
      if (!res.headersSent) sendError(res, status, message);
      else res.destroy();
      finish();
    };

    const upstream = send(url, { method: req.method, headers, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 502;
      if (status === 401) {
        // The tenant refused the gateway's own token: a deployment fault, not
        // the user being signed out, so it must not read as a 401 to the app.
        response.resume();
        options.log?.(`tenant ${options.label ?? "?"} refused the gateway token`);
        fail(502, "the gateway could not authenticate to your firstmate");
        return;
      }
      const out: Record<string, string> = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      const type = headerString(response.headers["content-type"]);
      if (type !== null && type.length <= MAX_CONTENT_TYPE_LENGTH) out["content-type"] = type;
      const length = headerString(response.headers["content-length"]);
      if (length !== null && /^\d{1,12}$/.test(length)) out["content-length"] = length;
      res.writeHead(status, out);
      response.pipe(res);
      response.on("end", finish);
      response.on("error", () => {
        res.destroy();
        finish();
      });
    });
    upstream.on("timeout", () => {
      upstream.destroy();
      fail(504, "your firstmate did not answer in time");
    });
    upstream.on("error", () => {
      fail(502, "your firstmate is not reachable");
    });
    res.on("close", () => {
      if (!settled) upstream.destroy();
      finish();
    });
    upstream.end(body ?? undefined);
  });
}
