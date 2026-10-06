import { readFileSync } from "node:fs";

/**
 * How a per-user firstmate (a managed tenant) runs: the chart-provided half of
 * the tenant objects. The other half is the user's recorded choice.
 *
 * The chart renders these from `tenants.*` into `tenants.json` in the
 * tenant-params ConfigMap the gateway mounts. Nothing here is secret and
 * nothing here is chosen by a user: images, resources, storage, scheduling,
 * the harness command and the gateway's internal delivery URL are all declared
 * in the repo. The security contexts are not parameters at all: the builder
 * writes the Pod Security "restricted" posture itself, and only the uid, gid
 * and fsGroup come from here.
 */

export type PullPolicy = "Always" | "IfNotPresent" | "Never";

export interface ImageRef {
  /** An immutable reference: `repo:tag` (never `latest`) or `repo@sha256:...`. */
  image: string;
  pullPolicy: PullPolicy;
}

/** A container's requests and limits, as Kubernetes quantity strings. */
export interface ContainerResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

export interface TenantParams {
  /** The namespace every tenant lives in; the gateway's Role covers only it. */
  namespace: string;
  /** Hard cap on managed tenants (admission); the namespace quota is the backstop. */
  maxTenants: number;
  /** The shared tenant ServiceAccount: no token mounted, no RBAC. */
  serviceAccountName: string;
  /** The gateway's internal origin tenants fetch their credentials from. */
  gatewayInternalUrl: string;
  /** The firstmate home inside the tenant pod (its PVC mount). */
  home: string;
  herdrSession: string;
  /** Starts firstmate's primary harness; empty runs the herdr server only. */
  harnessCommand: string;
  /** The tenant sidecar's port: its Service and the gateway's proxy target. */
  port: number;
  images: { firstmate: ImageRef; walkieTalkie: ImageRef };
  imagePullSecrets: string[];
  resources: { firstmate: ContainerResources; walkieTalkie: ContainerResources; init: ContainerResources };
  storage: { storageClass: string | null; size: string };
  security: { runAsUser: number; runAsGroup: number; fsGroup: number };
  scheduling: {
    nodeSelector: Record<string, string>;
    tolerations: unknown[];
    affinity: Record<string, unknown> | null;
    priorityClassName: string | null;
  };
  /** Days a removed user's home volume is kept for recovery before it is deleted. */
  purgeAfterDays: number;
}

export class TenantParamsError extends Error {
  override name = "TenantParamsError";
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
/** A registry path plus a tag or digest; the tag `latest` is refused below. */
const IMAGE = /^[a-z0-9][a-z0-9._\-/:]*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;
const RESOURCE_NAMES = new Set(["cpu", "memory", "ephemeral-storage"]);
const PULL_POLICIES: readonly PullPolicy[] = ["Always", "IfNotPresent", "Never"];
const MAX_TENANTS_CAP = 100;
export const DEFAULT_PURGE_AFTER_DAYS = 30;
const MAX_PURGE_AFTER_DAYS = 3650;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TenantParamsError(`${what} must be a string`);
  return value;
}

function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TenantParamsError(`${what} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** An image reference pinned to something immutable. */
export function parseImageRef(value: unknown, what: string): ImageRef {
  if (!isRecord(value)) throw new TenantParamsError(`${what} must be an object with image and pullPolicy`);
  const image = str(value.image, `${what}.image`);
  if (!IMAGE.test(image)) throw new TenantParamsError(`${what}.image must be repo:tag or repo@sha256:<digest>, got ${image}`);
  if (/:latest$/.test(image)) throw new TenantParamsError(`${what}.image must pin an immutable tag, not latest`);
  const pullPolicy = value.pullPolicy ?? "IfNotPresent";
  if (typeof pullPolicy !== "string" || !(PULL_POLICIES as readonly string[]).includes(pullPolicy)) {
    throw new TenantParamsError(`${what}.pullPolicy must be one of ${PULL_POLICIES.join(", ")}`);
  }
  return { image, pullPolicy: pullPolicy as PullPolicy };
}

function parseQuantities(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new TenantParamsError(`${what} must be a map of resource quantities`);
  const out: Record<string, string> = {};
  for (const [name, quantity] of Object.entries(value)) {
    if (!RESOURCE_NAMES.has(name)) throw new TenantParamsError(`${what}.${name} is not a supported resource`);
    const text = typeof quantity === "number" ? String(quantity) : quantity;
    if (typeof text !== "string" || !QUANTITY.test(text)) {
      throw new TenantParamsError(`${what}.${name} must be a Kubernetes quantity`);
    }
    out[name] = text;
  }
  return out;
}

function parseResources(value: unknown, what: string): ContainerResources {
  if (!isRecord(value)) throw new TenantParamsError(`${what} must be an object with requests and limits`);
  const resources = {
    requests: parseQuantities(value.requests, `${what}.requests`),
    limits: parseQuantities(value.limits, `${what}.limits`),
  };
  // The namespace quota caps limits.memory, so a pod without one is refused.
  if (resources.limits.memory === undefined) throw new TenantParamsError(`${what}.limits.memory is required`);
  return resources;
}

/** An http(s) origin with no path, query or credentials. */
function parseOrigin(value: unknown, what: string): string {
  const raw = str(value, what);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TenantParamsError(`${what} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TenantParamsError(`${what} must be http or https`);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new TenantParamsError(`${what} must be a bare origin`);
  }
  return url.origin;
}

function parseStringMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new TenantParamsError(`${what} must be a map`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = str(entry, `${what}.${key}`);
  return out;
}

/** Validate the tenant parameters the chart rendered. */
export function parseTenantParams(value: unknown): TenantParams {
  if (!isRecord(value)) throw new TenantParamsError("the tenant parameters must be an object");

  const namespace = str(value.namespace, "namespace");
  if (!DNS_LABEL.test(namespace)) throw new TenantParamsError("namespace must be a DNS label");
  const serviceAccountName = str(value.serviceAccountName, "serviceAccountName");
  if (!DNS_SUBDOMAIN.test(serviceAccountName)) throw new TenantParamsError("serviceAccountName must be a DNS name");

  const home = str(value.home, "home");
  if (!home.startsWith("/") || home.includes("..") || /\s/.test(home) || home.length > 256) {
    throw new TenantParamsError("home must be an absolute path");
  }
  const herdrSession = str(value.herdrSession, "herdrSession");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(herdrSession)) throw new TenantParamsError("herdrSession must be a session name");
  const harnessCommand = str(value.harnessCommand ?? "", "harnessCommand");
  if (harnessCommand.length > 4096 || /[\x00\r\n]/.test(harnessCommand)) {
    throw new TenantParamsError("harnessCommand must be one line");
  }

  const images = value.images;
  if (!isRecord(images)) throw new TenantParamsError("images must name the firstmate and walkieTalkie images");
  const pullSecrets = value.imagePullSecrets ?? [];
  if (!Array.isArray(pullSecrets)) throw new TenantParamsError("imagePullSecrets must be a list of Secret names");
  const imagePullSecrets = pullSecrets.map((entry, index) => {
    const name = isRecord(entry) ? entry.name : entry;
    const text = str(name, `imagePullSecrets[${index}]`);
    if (!DNS_SUBDOMAIN.test(text)) throw new TenantParamsError(`imagePullSecrets[${index}] must be a Secret name`);
    return text;
  });

  const resources = value.resources;
  if (!isRecord(resources)) throw new TenantParamsError("resources must hold firstmate, walkieTalkie and init");

  const storage = value.storage;
  if (!isRecord(storage)) throw new TenantParamsError("storage must hold size and storageClass");
  const size = str(storage.size, "storage.size");
  if (!QUANTITY.test(size)) throw new TenantParamsError("storage.size must be a Kubernetes quantity");
  const storageClassRaw = storage.storageClass ?? "";
  const storageClass = str(storageClassRaw, "storage.storageClass");
  if (storageClass !== "" && !DNS_SUBDOMAIN.test(storageClass)) {
    throw new TenantParamsError("storage.storageClass must be a StorageClass name");
  }

  const security = value.security;
  if (!isRecord(security)) throw new TenantParamsError("security must hold runAsUser, runAsGroup and fsGroup");

  const scheduling = isRecord(value.scheduling) ? value.scheduling : {};
  const tolerations = scheduling.tolerations ?? [];
  if (!Array.isArray(tolerations)) throw new TenantParamsError("scheduling.tolerations must be a list");
  const affinity = scheduling.affinity;
  if (affinity !== undefined && affinity !== null && !isRecord(affinity)) {
    throw new TenantParamsError("scheduling.affinity must be an object");
  }
  const priorityClassName = str(scheduling.priorityClassName ?? "", "scheduling.priorityClassName");

  return {
    namespace,
    maxTenants: int(value.maxTenants, "maxTenants", 1, MAX_TENANTS_CAP),
    serviceAccountName,
    gatewayInternalUrl: parseOrigin(value.gatewayInternalUrl, "gatewayInternalUrl"),
    home: home.replace(/\/+$/, ""),
    herdrSession,
    harnessCommand,
    port: int(value.port, "port", 1, 65535),
    images: {
      firstmate: parseImageRef(images.firstmate, "images.firstmate"),
      walkieTalkie: parseImageRef(images.walkieTalkie, "images.walkieTalkie"),
    },
    imagePullSecrets,
    resources: {
      firstmate: parseResources(resources.firstmate, "resources.firstmate"),
      walkieTalkie: parseResources(resources.walkieTalkie, "resources.walkieTalkie"),
      init: parseResources(resources.init, "resources.init"),
    },
    storage: { storageClass: storageClass === "" ? null : storageClass, size },
    security: {
      // uid 0 is refused: the namespace enforces runAsNonRoot.
      runAsUser: int(security.runAsUser, "security.runAsUser", 1, 2_147_483_647),
      runAsGroup: int(security.runAsGroup, "security.runAsGroup", 1, 2_147_483_647),
      fsGroup: int(security.fsGroup, "security.fsGroup", 1, 2_147_483_647),
    },
    scheduling: {
      nodeSelector: parseStringMap(scheduling.nodeSelector, "scheduling.nodeSelector"),
      tolerations,
      affinity: isRecord(affinity) && Object.keys(affinity).length > 0 ? affinity : null,
      priorityClassName: priorityClassName === "" ? null : priorityClassName,
    },
    purgeAfterDays:
      value.purgeAfterDays === undefined
        ? DEFAULT_PURGE_AFTER_DAYS
        : int(value.purgeAfterDays, "purgeAfterDays", 0, MAX_PURGE_AFTER_DAYS),
  };
}

/** Read and validate the parameters file the chart mounts. */
export function loadTenantParams(path: string): TenantParams {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new TenantParamsError(`cannot read the tenant parameters ${path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TenantParamsError(`the tenant parameters ${path} are not valid JSON`);
  }
  return parseTenantParams(parsed);
}
