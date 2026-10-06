import { createServer, type IncomingMessage, type Server } from "node:http";

import type { KubeObject } from "../src/tenant-objects.js";

/**
 * A stand-in for the Kubernetes API server, enough for the tenant reconciler:
 * namespaced get, list (equality label selectors), server-side apply and
 * delete, for any resource. It records every request, so a test can assert
 * which verbs and paths the gateway ever used, and it can be edited behind the
 * reconciler's back (drift) or seeded with pods carrying a status.
 */

export interface KubeCall {
  method: string;
  /** The path without its query string. */
  path: string;
  query: URLSearchParams;
  contentType: string | null;
  authorization: string | null;
  /** The resource plural, e.g. statefulsets; "" when the path did not parse. */
  resource: string;
  /** The object name, or null for a collection. */
  name: string | null;
  namespace: string | null;
}

export interface FakeKube {
  url: string;
  token: string;
  calls: KubeCall[];
  /** Stored objects by `<resource>/<name>`. */
  objects: Map<string, KubeObject>;
  /** How many applies changed a stored object (or created one). */
  changes: () => number;
  seed: (resource: string, object: KubeObject) => void;
  get: (resource: string, name: string) => KubeObject | undefined;
  /** Make every request to this resource fail with this status (null clears). */
  fail: (resource: string, status: number | null) => void;
  close: () => Promise<void>;
}

const PATH = /^\/(?:api\/v1|apis\/[a-z0-9.-]+\/v1)\/namespaces\/([a-z0-9-]+)\/([a-z]+)(?:\/([a-z0-9.-]+))?$/;

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function labelsOf(object: KubeObject): Record<string, string> {
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  return (metadata.labels ?? {}) as Record<string, string>;
}

function matches(object: KubeObject, selector: string): boolean {
  if (selector === "") return true;
  const labels = labelsOf(object);
  return selector.split(",").every((term) => {
    const [key, value] = term.split("=");
    return key !== undefined && labels[key] === value;
  });
}

/** An applied object as stored: the body plus what the server owns. */
function stored(body: KubeObject, previous: KubeObject | undefined): KubeObject {
  const metadata = { ...((body.metadata ?? {}) as Record<string, unknown>) };
  const before = (previous?.metadata ?? {}) as Record<string, unknown>;
  metadata.uid = before.uid ?? `uid-${Math.random().toString(16).slice(2)}`;
  return { ...body, metadata, ...(previous?.status !== undefined ? { status: previous.status } : {}) };
}

function comparable(object: KubeObject | undefined): string {
  if (object === undefined) return "";
  const { status: _status, ...rest } = object;
  const metadata = { ...((rest.metadata ?? {}) as Record<string, unknown>) };
  delete metadata.uid;
  return JSON.stringify({ ...rest, metadata });
}

export async function startFakeKube(namespace: string, token = "fake-sa-token"): Promise<FakeKube> {
  const calls: KubeCall[] = [];
  const objects = new Map<string, KubeObject>();
  const failures = new Map<string, number>();
  let changes = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://kube.invalid");
      const match = PATH.exec(url.pathname);
      const call: KubeCall = {
        method: req.method ?? "",
        path: url.pathname,
        query: url.searchParams,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
        resource: match?.[2] ?? "",
        name: match?.[3] ?? null,
        namespace: match?.[1] ?? null,
      };
      calls.push(call);
      const body = await readAll(req);
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      if (call.authorization !== `Bearer ${token}`) return send(401, { kind: "Status", reason: "Unauthorized" });
      if (match === null || call.namespace !== namespace) return send(403, { kind: "Status", reason: "Forbidden" });
      const failure = failures.get(call.resource);
      if (failure !== undefined) return send(failure, { kind: "Status", reason: "InternalError", message: "planted" });
      const key = `${call.resource}/${call.name ?? ""}`;

      if (call.method === "GET" && call.name === null) {
        const selector = url.searchParams.get("labelSelector") ?? "";
        const items = [...objects.entries()]
          .filter(([stored]) => stored.startsWith(`${call.resource}/`))
          .map(([, object]) => object)
          .filter((object) => matches(object, selector));
        return send(200, { kind: "List", items });
      }
      if (call.method === "GET") {
        const object = objects.get(key);
        return object === undefined ? send(404, { kind: "Status", reason: "NotFound" }) : send(200, object);
      }
      if (call.method === "PATCH") {
        if (call.contentType !== "application/apply-patch+yaml") return send(415, { kind: "Status", reason: "UnsupportedMediaType" });
        const applied = JSON.parse(body) as KubeObject;
        const metadata = (applied.metadata ?? {}) as Record<string, unknown>;
        if (metadata.name !== call.name) return send(400, { kind: "Status", reason: "BadRequest" });
        const previous = objects.get(key);
        const next = stored(applied, previous);
        if (comparable(previous) !== comparable(next)) changes += 1;
        objects.set(key, next);
        return send(previous === undefined ? 201 : 200, next);
      }
      if (call.method === "DELETE") {
        if (!objects.has(key)) return send(404, { kind: "Status", reason: "NotFound" });
        objects.delete(key);
        return send(200, { kind: "Status", status: "Success" });
      }
      return send(405, { kind: "Status", reason: "MethodNotAllowed" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    calls,
    objects,
    changes: () => changes,
    seed: (resource, object) => {
      const name = String((object.metadata as Record<string, unknown>).name);
      objects.set(`${resource}/${name}`, object);
    },
    get: (resource, name) => objects.get(`${resource}/${name}`),
    fail: (resource, status) => {
      if (status === null) failures.delete(resource);
      else failures.set(resource, status);
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The gateway's Role in the tenant namespace, as the design (§6.3) grants it:
 * resource -> verbs. A call outside it would be refused by the cluster.
 */
export const GATEWAY_ROLE: Record<string, readonly string[]> = {
  statefulsets: ["get", "list", "watch", "create", "patch", "update", "delete"],
  services: ["get", "list", "watch", "create", "patch", "update", "delete"],
  configmaps: ["get", "list", "watch", "create", "patch", "update", "delete"],
  secrets: ["get", "list", "watch", "create", "patch", "update", "delete"],
  persistentvolumeclaims: ["get", "list", "watch", "delete"],
  pods: ["get", "list", "watch"],
};

/** The RBAC verb a recorded call needs. */
export function verbOf(call: KubeCall): string {
  if (call.method === "GET") return call.name === null ? (call.query.get("watch") === "true" ? "watch" : "list") : "get";
  if (call.method === "PATCH") return "patch";
  if (call.method === "DELETE") return "delete";
  if (call.method === "POST") return "create";
  if (call.method === "PUT") return "update";
  return call.method.toLowerCase();
}
