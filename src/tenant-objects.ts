import { createHash } from "node:crypto";

import type { CatalogProvider } from "./catalog.js";
import type { ContainerResources, TenantParams } from "./tenant-params.js";

/**
 * The cluster objects of one per-user firstmate, as a pure function of the
 * chart's tenant parameters and the user's recorded choice.
 *
 * Nothing here talks to the cluster: the reconciler applies what this returns,
 * and `walkie-talkie tenants render` prints it for review. A tenant is today's
 * firstmate pod shape (the firstmate runtime, the walkie-talkie sidecar in
 * standalone mode, and the herdr CLI init container) with four differences:
 *
 * - no provider key or GitHub token is ever written to a Secret or ConfigMap.
 *   The runtime fetches them from the gateway's internal port at start, with
 *   its own credential token, before the herdr server starts;
 * - the agents config (opencode.json, crew-dispatch.json) is generated from the
 *   user's provider and model, and references the key only by its variable
 *   name;
 * - the pod runs under the Pod Security "restricted" posture, mounts no
 *   ServiceAccount token and gets no service-link variables (which would name
 *   other tenants' Services);
 * - the sidecar keeps its push keys and subscriptions on the tenant's own
 *   volume.
 */

export type KubeObject = Record<string, unknown>;

export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "walkie-talkie-gateway";
export const TENANT_LABEL = "walkie-talkie.atus.hr/tenant";
export const NAME_LABEL = "app.kubernetes.io/name";
/** The pod name label; the chart's tenant NetworkPolicies select it. */
export const TENANT_POD_NAME = "firstmate-tenant";
export const CONFIG_VERSION_ANNOTATION = "walkie-talkie.atus.hr/config-version";
export const AGENTS_CHECKSUM_ANNOTATION = "checksum/agents";
/** The gateway's internal route a tenant fetches its credentials from. */
export const CREDENTIALS_PATH = "/internal/v1/credentials";
/** The runtime writes this once its credentials are in and the herdr server runs. */
export const READY_FILE = "/tmp/firstmate-ready";
const HERDR_DIR = "/opt/herdr";
const HERDR_IMAGE_PATH = "/usr/local/bin/herdr";
/** The routine tier's dispatch rule, worded as the captain's own deployment words it. */
export const ROUTINE_RULE = "Mechanical or routine implementation, or other work with a settled plan and a bounded path.";

/** What a user chose their firstmate to run on, resolved against the catalog. */
export interface TenantChoice {
  harness: string;
  provider: CatalogProvider;
  model: string;
  routineModel: string | null;
}

export interface TenantSpec {
  tid: string;
  /** Desired running (1 replica) or stopped (0 replicas, everything else kept). */
  running: boolean;
  /** Bumped when the user's key changes, so the pod restarts and fetches it again. */
  configVersion: number;
  choice: TenantChoice;
  /** Every name the user's GitHub token is delivered under; [] when not offered. */
  githubKeyEnv: string[];
  tokens: { api: string; credentials: string };
}

export interface TenantObjects {
  secret: KubeObject;
  configMap: KubeObject;
  service: KubeObject;
  statefulSet: KubeObject;
}

export interface TenantNames {
  workload: string;
  tokens: string;
  agents: string;
  claim: string;
}

export function tenantNames(tid: string): TenantNames {
  return { workload: `fm-${tid}`, tokens: `fm-${tid}-tokens`, agents: `fm-${tid}-agents`, claim: `home-fm-${tid}-0` };
}

/** Where the gateway reaches a tenant's sidecar: its Service, in-cluster. */
export function tenantUpstream(params: TenantParams, tid: string): string {
  return `http://${tenantNames(tid).workload}.${params.namespace}.svc:${params.port}`;
}

/** The labels a tenant's pods carry and its Service and StatefulSet select. */
export function tenantSelector(tid: string): Record<string, string> {
  return { [NAME_LABEL]: TENANT_POD_NAME, [TENANT_LABEL]: tid };
}

function tenantLabels(tid: string): Record<string, string> {
  return { ...tenantSelector(tid), "app.kubernetes.io/component": "tenant", [MANAGED_BY_LABEL]: MANAGED_BY };
}

/**
 * The generated agents config. Every model-bearing setting comes from the
 * user's one choice: the default model, opencode's small model (used for
 * titles and summaries), the providers opencode may use at all, and the
 * dispatch profiles. The key is referenced by its variable name only.
 */
export function tenantAgentsConfig(choice: TenantChoice): { "opencode.json": string; "crew-dispatch.json": string } {
  const provider = choice.provider;
  const model = `${provider.id}/${choice.model}`;
  const routine = choice.routineModel === null ? null : `${provider.id}/${choice.routineModel}`;
  const opencode = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: routine ?? model,
    enabled_providers: [provider.id],
    provider: { [provider.id]: { options: { apiKey: `{env:${provider.keyEnv}}` } } },
  };
  const dispatch = {
    rules: routine === null ? [] : [{ when: ROUTINE_RULE, use: [{ harness: choice.harness, model: routine }] }],
    default: [{ harness: choice.harness, model }],
  };
  return {
    "opencode.json": `${JSON.stringify(opencode, null, 2)}\n`,
    "crew-dispatch.json": `${JSON.stringify(dispatch, null, 2)}\n`,
  };
}

function resources(spec: ContainerResources): KubeObject {
  const out: KubeObject = {};
  if (Object.keys(spec.requests).length > 0) out.requests = { ...spec.requests };
  if (Object.keys(spec.limits).length > 0) out.limits = { ...spec.limits };
  return out;
}

/** The restricted posture for every container: nothing here is a parameter. */
const CONTAINER_SECURITY = {
  runAsNonRoot: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

function env(name: string, value: string): KubeObject {
  return { name, value };
}

function secretEnv(name: string, secret: string, key: string): KubeObject {
  return { name, valueFrom: { secretKeyRef: { name: secret, key } } };
}

export function buildTenantObjects(params: TenantParams, spec: TenantSpec): TenantObjects {
  const { tid, choice } = spec;
  const names = tenantNames(tid);
  const labels = tenantLabels(tid);
  const selector = tenantSelector(tid);
  const meta = (name: string): KubeObject => ({ name, namespace: params.namespace, labels: { ...labels } });
  const home = params.home;
  const agents = tenantAgentsConfig(choice);
  const agentsChecksum = createHash("sha256").update(JSON.stringify(agents)).digest("hex");
  const credentialEnvs = [choice.provider.keyEnv, ...spec.githubKeyEnv];

  const secret: KubeObject = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta(names.tokens),
    type: "Opaque",
    data: {
      api: Buffer.from(spec.tokens.api, "utf8").toString("base64"),
      credentials: Buffer.from(spec.tokens.credentials, "utf8").toString("base64"),
    },
  };

  const configMap: KubeObject = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: meta(names.agents),
    data: agents,
  };

  const service: KubeObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: meta(names.workload),
    spec: {
      type: "ClusterIP",
      selector: { ...selector },
      ports: [{ name: "http", port: params.port, targetPort: "walkie-talkie", protocol: "TCP" }],
    },
  };

  const herdrBin = `${HERDR_DIR}/herdr`;
  const podSpec: KubeObject = {
    serviceAccountName: params.serviceAccountName,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    securityContext: {
      runAsUser: params.security.runAsUser,
      runAsGroup: params.security.runAsGroup,
      runAsNonRoot: true,
      fsGroup: params.security.fsGroup,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    },
    terminationGracePeriodSeconds: 30,
    ...(params.imagePullSecrets.length > 0 ? { imagePullSecrets: params.imagePullSecrets.map((name) => ({ name })) } : {}),
    ...(params.scheduling.priorityClassName !== null ? { priorityClassName: params.scheduling.priorityClassName } : {}),
    ...(Object.keys(params.scheduling.nodeSelector).length > 0 ? { nodeSelector: { ...params.scheduling.nodeSelector } } : {}),
    ...(params.scheduling.tolerations.length > 0 ? { tolerations: params.scheduling.tolerations } : {}),
    ...(params.scheduling.affinity !== null ? { affinity: params.scheduling.affinity } : {}),
    initContainers: [
      {
        name: "install-herdr",
        image: params.images.firstmate.image,
        imagePullPolicy: params.images.firstmate.pullPolicy,
        command: ["cp", HERDR_IMAGE_PATH, herdrBin],
        volumeMounts: [{ name: "herdr-bin", mountPath: HERDR_DIR }],
        resources: resources(params.resources.init),
        securityContext: { ...CONTAINER_SECURITY },
      },
    ],
    containers: [
      {
        name: "firstmate",
        image: params.images.firstmate.image,
        imagePullPolicy: params.images.firstmate.pullPolicy,
        env: [
          env("HOME", home),
          env("FM_HOME", home),
          env("FM_BIN", `${home}/bin`),
          env("HERDR_SESSION", params.herdrSession),
          env("FM_HARNESS_COMMAND", params.harnessCommand),
          env("FM_READY_FILE", READY_FILE),
          // The runtime fetches this tenant's keys from the gateway before the
          // herdr server starts; no key is ever in a Secret or this spec.
          env("FM_TENANT_CREDENTIALS_URL", `${params.gatewayInternalUrl}${CREDENTIALS_PATH}`),
          secretEnv("FM_TENANT_CREDENTIALS_TOKEN", names.tokens, "credentials"),
          env("FM_TENANT_CREDENTIAL_ENVS", credentialEnvs.join(" ")),
          env("FM_TENANT_REQUIRED_ENV", choice.provider.keyEnv),
        ],
        readinessProbe: {
          exec: { command: ["test", "-e", READY_FILE] },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 5,
          failureThreshold: 3,
        },
        volumeMounts: [
          { name: "home", mountPath: home },
          { name: "agents", mountPath: `${home}/config/crew-dispatch.json`, subPath: "crew-dispatch.json", readOnly: true },
          { name: "agents", mountPath: `${home}/.config/opencode/opencode.json`, subPath: "opencode.json", readOnly: true },
        ],
        resources: resources(params.resources.firstmate),
        securityContext: { ...CONTAINER_SECURITY },
      },
      {
        name: "walkie-talkie",
        image: params.images.walkieTalkie.image,
        imagePullPolicy: params.images.walkieTalkie.pullPolicy,
        ports: [{ name: "walkie-talkie", containerPort: params.port, protocol: "TCP" }],
        env: [
          env("FM_HOME", home),
          env("FM_BIN", `${home}/bin`),
          env("HERDR_SESSION", params.herdrSession),
          env("FM_WT_HOST", "0.0.0.0"),
          env("FM_WT_PORT", String(params.port)),
          env("FM_WT_ALLOW_PUBLIC_BIND", "1"),
          secretEnv("FM_WT_TOKEN", names.tokens, "api"),
          env("FM_WT_HERDR_BIN", herdrBin),
          env("XDG_CONFIG_HOME", `${home}/.config`),
          // Push keys and subscriptions live on the tenant's own volume, so
          // they survive restarts and belong to this user alone.
          env("FM_WT_PUSH_STORE", `${home}/.walkie-talkie/push.json`),
        ],
        livenessProbe: {
          tcpSocket: { port: "walkie-talkie" },
          initialDelaySeconds: 10,
          periodSeconds: 20,
          timeoutSeconds: 5,
          failureThreshold: 3,
        },
        readinessProbe: {
          httpGet: { path: "/api/health", port: "walkie-talkie" },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 5,
          failureThreshold: 3,
        },
        volumeMounts: [
          { name: "home", mountPath: home },
          { name: "herdr-bin", mountPath: HERDR_DIR, readOnly: true },
        ],
        resources: resources(params.resources.walkieTalkie),
        securityContext: { ...CONTAINER_SECURITY },
      },
    ],
    volumes: [
      { name: "agents", configMap: { name: names.agents } },
      { name: "herdr-bin", emptyDir: {} },
    ],
  };

  const statefulSet: KubeObject = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: meta(names.workload),
    spec: {
      serviceName: names.workload,
      replicas: spec.running ? 1 : 0,
      // One replica, so ordering buys nothing; Parallel lets a rolling update
      // replace a pod that is not Ready (OrderedReady would wait on it forever).
      // The field is immutable, but no tenant StatefulSet exists before this.
      podManagementPolicy: "Parallel",
      updateStrategy: { type: "RollingUpdate" },
      selector: { matchLabels: { ...selector } },
      template: {
        metadata: {
          labels: { ...labels },
          annotations: {
            [CONFIG_VERSION_ANNOTATION]: String(spec.configVersion),
            [AGENTS_CHECKSUM_ANNOTATION]: agentsChecksum,
          },
        },
        spec: podSpec,
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "home", labels: { ...labels } },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(params.storage.storageClass !== null ? { storageClassName: params.storage.storageClass } : {}),
            resources: { requests: { storage: params.storage.size } },
          },
        },
      ],
    },
  };

  return { secret, configMap, service, statefulSet };
}
