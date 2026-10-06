import { parseCatalog, type Catalog } from "../src/catalog.js";
import { parseTenantParams, type TenantParams } from "../src/tenant-params.js";

/** Tenant parameters as the chart renders them for the atus example. */
export const TENANT_PARAMS_DOC = {
  namespace: "firstmate-tenants",
  maxTenants: 5,
  serviceAccountName: "fm-tenant",
  gatewayInternalUrl: "http://firstmate-gateway-internal.firstmate.svc:8788",
  home: "/home/firstmate",
  herdrSession: "firstmate",
  harnessCommand: `OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode --prompt "$FM_PRIMARY_SESSION_START_PROMPT"`,
  port: 8787,
  images: {
    firstmate: { image: "shimpa/firstmate-runtime:0123456789ab", pullPolicy: "IfNotPresent" },
    walkieTalkie: { image: "shimpa/walkie-talkie:ba9876543210", pullPolicy: "IfNotPresent" },
  },
  imagePullSecrets: [],
  resources: {
    firstmate: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "2Gi", "ephemeral-storage": "4Gi" } },
    walkieTalkie: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
    init: { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } },
  },
  storage: { storageClass: "beta3", size: "10Gi" },
  security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
  scheduling: { nodeSelector: {}, tolerations: [], affinity: {}, priorityClassName: "" },
};

export function tenantParams(overrides: Record<string, unknown> = {}): TenantParams {
  return parseTenantParams({ ...TENANT_PARAMS_DOC, ...overrides });
}

/** A two-provider catalog with a GitHub slot, like the launch catalog. */
export function tenantCatalog(): Catalog {
  return parseCatalog({
    harnesses: [{ name: "opencode" }],
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        keyEnv: "ANTHROPIC_API_KEY",
        validate: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key" },
        models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        keyEnv: "OPENROUTER_API_KEY",
        validate: { url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
        models: ["qwen/qwen3.8-27b", "deepseek/deepseek-chat"],
      },
    ],
    github: { keyEnv: ["GH_TOKEN", "GITHUB_TOKEN"], validate: { url: "https://api.github.com/user", auth: "bearer" } },
  });
}

/** A master secret for the tenant tokens: 44 characters, like `openssl rand -base64 32`. */
export const TENANT_MASTER = "q0b1Yk7m2d9h1Vt5sX8eL3rN6pW4zA0cF2gJ7uK9iM4=";
