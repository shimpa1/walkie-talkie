import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { KubeObject } from "./tenant-objects.js";

/**
 * A minimal Kubernetes API client for the gateway's tenant reconciler, over
 * `node:https` with the pod's ServiceAccount token and CA. No dependency.
 *
 * It is bound to one namespace at construction and offers exactly four
 * operations: get, list (by label selector), server-side apply, and delete.
 * There is no way to name another namespace, a cluster-scoped resource, or a
 * subresource such as pods/exec, so the client cannot reach further than the
 * Role the chart grants (which is narrower still). Request and response bodies
 * are never logged or put into an error: an applied Secret carries tenant
 * tokens, and API errors can echo field values.
 */

export interface KubeKind {
  kind: string;
  /** "/api/v1" for the core group, "/apis/<group>/<version>" otherwise. */
  apiPath: string;
  plural: string;
}

export const KINDS = {
  secret: { kind: "Secret", apiPath: "/api/v1", plural: "secrets" },
  configMap: { kind: "ConfigMap", apiPath: "/api/v1", plural: "configmaps" },
  service: { kind: "Service", apiPath: "/api/v1", plural: "services" },
  statefulSet: { kind: "StatefulSet", apiPath: "/apis/apps/v1", plural: "statefulsets" },
  pod: { kind: "Pod", apiPath: "/api/v1", plural: "pods" },
  persistentVolumeClaim: { kind: "PersistentVolumeClaim", apiPath: "/api/v1", plural: "persistentvolumeclaims" },
} as const satisfies Record<string, KubeKind>;

/** The field manager every apply uses; a hand edit to a managed field is reverted. */
export const FIELD_MANAGER = "walkie-talkie-gateway";

export class KubeError extends Error {
  override name = "KubeError";
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The client the reconciler needs; tests substitute a fake API server. */
export interface Kube {
  get(kind: KubeKind, name: string): Promise<KubeObject | null>;
  list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]>;
  apply(kind: KubeKind, object: KubeObject): Promise<void>;
  delete(kind: KubeKind, name: string): Promise<boolean>;
}

export interface KubeClientOptions {
  /** The API server origin, e.g. https://10.96.0.1:443. */
  server: string;
  namespace: string;
  /** Read on demand: a projected ServiceAccount token is rotated on disk. */
  token: () => string;
  /** The cluster CA (PEM) for an https server. */
  ca?: Buffer;
  timeoutMs?: number;
}

const NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TOKEN_CACHE_MS = 60_000;

function objectName(object: KubeObject): string {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const name = metadata?.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new KubeError("an object to apply has no valid name", 0);
  return name;
}

export class KubeClient implements Kube {
  private readonly server: URL;
  private readonly namespace: string;
  private readonly token: () => string;
  private readonly ca: Buffer | undefined;
  private readonly timeoutMs: number;

  constructor(options: KubeClientOptions) {
    this.server = new URL(options.server);
    if (!NAME.test(options.namespace)) throw new KubeError("the tenant namespace is not a valid name", 0);
    this.namespace = options.namespace;
    this.token = options.token;
    this.ca = options.ca;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private path(kind: KubeKind, name?: string): string {
    const base = `${kind.apiPath}/namespaces/${this.namespace}/${kind.plural}`;
    if (name === undefined) return base;
    if (!NAME.test(name)) throw new KubeError(`not a valid ${kind.kind} name`, 0);
    return `${base}/${name}`;
  }

  private send(
    method: "GET" | "PATCH" | "DELETE",
    path: string,
    body: string | null,
    contentType: string | null,
  ): Promise<{ status: number; text: string }> {
    const url = new URL(path, this.server);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token()}`,
      accept: "application/json",
    };
    if (body !== null) {
      headers["content-type"] = contentType ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const request = send(
        url,
        { method, headers, timeout: this.timeoutMs, ...(this.ca !== undefined ? { ca: this.ca } : {}) },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy();
              reject(new KubeError(`${method} ${path}: response too large`, 0));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          response.on("error", () => reject(new KubeError(`${method} ${path}: response failed`, 0)));
        },
      );
      request.on("timeout", () => {
        request.destroy();
        reject(new KubeError(`${method} ${path}: timed out`, 0));
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        reject(new KubeError(`${method} ${path}: ${error.code ?? "request failed"}`, 0));
      });
      request.end(body ?? undefined);
    });
  }

  /** A failure names the call and the API's reason (a fixed word), never a body. */
  private failure(method: string, path: string, status: number, text: string): KubeError {
    let reason = "";
    try {
      const parsed = JSON.parse(text) as { reason?: unknown };
      if (typeof parsed.reason === "string" && /^[A-Za-z]{1,64}$/.test(parsed.reason)) reason = ` ${parsed.reason}`;
    } catch {
      // A non-JSON error body says nothing usable.
    }
    return new KubeError(`${method} ${path}: HTTP ${status}${reason}`, status);
  }

  async get(kind: KubeKind, name: string): Promise<KubeObject | null> {
    const path = this.path(kind, name);
    const { status, text } = await this.send("GET", path, null, null);
    if (status === 404) return null;
    if (status < 200 || status > 299) throw this.failure("GET", path, status, text);
    return JSON.parse(text) as KubeObject;
  }

  async list(kind: KubeKind, labelSelector: string): Promise<KubeObject[]> {
    const path = `${this.path(kind)}?labelSelector=${encodeURIComponent(labelSelector)}`;
    const { status, text } = await this.send("GET", path, null, null);
    if (status < 200 || status > 299) throw this.failure("GET", this.path(kind), status, text);
    const parsed = JSON.parse(text) as { items?: unknown };
    return Array.isArray(parsed.items) ? (parsed.items as KubeObject[]) : [];
  }

  /**
   * Server-side apply: idempotent, creates the object when missing, and takes
   * ownership of every field it sets (`force`), so drift is reverted.
   */
  async apply(kind: KubeKind, object: KubeObject): Promise<void> {
    const name = objectName(object);
    const path = `${this.path(kind, name)}?fieldManager=${FIELD_MANAGER}&force=true`;
    const { status, text } = await this.send("PATCH", path, JSON.stringify(object), "application/apply-patch+yaml");
    if (status < 200 || status > 299) throw this.failure("PATCH", this.path(kind, name), status, text);
  }

  async delete(kind: KubeKind, name: string): Promise<boolean> {
    const path = this.path(kind, name);
    const { status, text } = await this.send("DELETE", path, null, null);
    if (status === 404) return false;
    if (status < 200 || status > 299) throw this.failure("DELETE", path, status, text);
    return true;
  }
}

/**
 * The client a gateway pod uses: the API server from the environment
 * Kubernetes sets, and the mounted ServiceAccount token and CA. Null outside a
 * cluster.
 */
export function inClusterKube(namespace: string, env: NodeJS.ProcessEnv = process.env): KubeClient | null {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim() || "443";
  if (!host) return null;
  let ca: Buffer;
  try {
    ca = readFileSync(`${SERVICE_ACCOUNT_DIR}/ca.crt`);
  } catch {
    return null;
  }
  let cached = "";
  let readAt = 0;
  const token = (): string => {
    const now = Date.now();
    if (cached === "" || now - readAt > TOKEN_CACHE_MS) {
      cached = readFileSync(`${SERVICE_ACCOUNT_DIR}/token`, "utf8").trim();
      readAt = now;
    }
    return cached;
  };
  const server = host.includes(":") ? `https://[${host}]:${port}` : `https://${host}:${port}`;
  return new KubeClient({ server, namespace, token, ca });
}
