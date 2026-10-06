import { providerById, type Catalog } from "./catalog.js";
import type { GatewayStore, ModelChoice, TenantObserved, TenantOwner, TenantRecord } from "./gateway-store.js";
import { KINDS, type Kube, type KubeKind } from "./kube.js";
import {
  buildTenantObjects,
  MANAGED_BY,
  MANAGED_BY_LABEL,
  TENANT_LABEL,
  type KubeObject,
  type TenantChoice,
  type TenantSpec,
} from "./tenant-objects.js";
import type { TenantParams } from "./tenant-params.js";
import type { TenantTokens } from "./tenant-tokens.js";

/**
 * The tenant reconciler: makes the cluster match the gateway store.
 *
 * Desired state lives in the store (each user's tenant: none, running or
 * stopped, plus their model choice); the cluster objects are derived from it by
 * `buildTenantObjects` and applied with server-side apply, so re-applying is
 * idempotent and a hand edit to a managed field is reverted on the next sweep.
 * Objects labelled as managed by the gateway whose tenant is no longer desired
 * are deleted, except volume claims, which hold a user's home and are never
 * deleted here. Pod status is read back as each tenant's observed state.
 *
 * It runs on every desired-state change (`kick`) and as a drift sweep: every
 * minute, or every few seconds while a tenant is still starting or stopping.
 * It uses only get, list, apply (patch) and delete in the tenant namespace.
 */

export interface ReconcilerDeps {
  store: GatewayStore;
  kube: Kube;
  params: TenantParams;
  catalog: Catalog;
  tokens: TenantTokens;
  now: () => number;
  log: (line: string) => void;
  /** The drift sweep period. */
  intervalMs?: number;
  /** The sweep period while a tenant is in transition. */
  transitionIntervalMs?: number;
}

export interface ReconcileResult {
  applied: number;
  pruned: number;
  errors: number;
  observed: Record<string, TenantObserved>;
}

export const DEFAULT_SWEEP_MS = 60_000;
export const DEFAULT_TRANSITION_SWEEP_MS = 5_000;
/** The kinds a tenant is made of, in apply order; pruned in reverse. */
const TENANT_KINDS: readonly KubeKind[] = [KINDS.secret, KINDS.configMap, KINDS.service, KINDS.statefulSet];
export const MANAGED_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY}`;
/** Waiting reasons that mean the pod will not come up on its own. */
const FAILING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

/** A managed firstmate's lifecycle as the app shows it. */
export type FirstmateState = "none" | "provisioning" | "starting" | "running" | "crashloop" | "stopping" | "stopped";

/**
 * Desired plus observed, as one word: `provisioning` before the reconciler has
 * applied anything, `starting` until the pod is Ready, then `running`.
 */
export function tenantState(tenant: TenantRecord | null): FirstmateState {
  if (tenant === null || tenant.desired === "none") return "none";
  if (tenant.desired === "stopped") return tenant.observed === "stopped" ? "stopped" : "stopping";
  switch (tenant.observed) {
    case "none":
      return "provisioning";
    case "running":
      return "running";
    case "crashloop":
      return "crashloop";
    default:
      return "starting";
  }
}

/** The user's recorded choice, resolved against the catalog; null when it no longer resolves. */
export function resolveChoice(catalog: Catalog, choice: ModelChoice | null): TenantChoice | null {
  if (choice === null) return null;
  const provider = providerById(catalog, choice.provider);
  if (provider === null || !provider.models.includes(choice.model)) return null;
  if (choice.routineModel !== null && !provider.models.includes(choice.routineModel)) return null;
  if (!catalog.harnesses.includes(choice.harness)) return null;
  return { harness: choice.harness, provider, model: choice.model, routineModel: choice.routineModel };
}

/** A tenant runs only while desired running and its owner is active (suspension stops it). */
export function tenantRuns(owner: TenantOwner): boolean {
  return owner.desired === "running" && owner.userState === "active";
}

/** The builder's input for one tenant, or null when its choice cannot be built. */
export function tenantSpec(
  owner: TenantOwner,
  choice: ModelChoice | null,
  catalog: Catalog,
  tokens: { api: string; credentials: string },
): TenantSpec | null {
  const resolved = resolveChoice(catalog, choice);
  if (resolved === null) return null;
  return {
    tid: owner.tid,
    running: tenantRuns(owner),
    configVersion: owner.configVersion,
    choice: resolved,
    githubKeyEnv: catalog.github?.keyEnv ?? [],
    tokens,
  };
}

function labelsOf(object: KubeObject): Record<string, unknown> {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const labels = metadata?.labels;
  return labels !== null && typeof labels === "object" ? (labels as Record<string, unknown>) : {};
}

function nameOf(object: KubeObject): string {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.name === "string" ? metadata.name : "";
}

function tenantOf(object: KubeObject): string | null {
  const tid = labelsOf(object)[TENANT_LABEL];
  return typeof tid === "string" && tid !== "" ? tid : null;
}

/** What one pod says about its tenant. */
export function podObserved(pod: KubeObject): TenantObserved {
  const status = (pod.status ?? {}) as Record<string, unknown>;
  const containers = [
    ...(Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : []),
    ...(Array.isArray(status.containerStatuses) ? status.containerStatuses : []),
  ] as Array<Record<string, unknown>>;
  for (const container of containers) {
    const waiting = (container.state as Record<string, unknown> | undefined)?.waiting as Record<string, unknown> | undefined;
    if (typeof waiting?.reason === "string" && FAILING_REASONS.has(waiting.reason)) return "crashloop";
  }
  const conditions = (Array.isArray(status.conditions) ? status.conditions : []) as Array<Record<string, unknown>>;
  const ready = conditions.some((condition) => condition.type === "Ready" && condition.status === "True");
  return ready ? "running" : "pending";
}

/**
 * A StatefulSet's volume claim templates are immutable: an existing tenant
 * keeps the ones it was created with, so a storage change in the parameters
 * applies only to tenants created afterwards and never blocks the apply.
 */
async function keepClaimTemplates(kube: Kube, statefulSet: KubeObject): Promise<void> {
  const existing = await kube.get(KINDS.statefulSet, nameOf(statefulSet));
  const templates = (existing?.spec as Record<string, unknown> | undefined)?.volumeClaimTemplates;
  if (!Array.isArray(templates)) return;
  (statefulSet.spec as Record<string, unknown>).volumeClaimTemplates = templates;
}

export class TenantReconciler {
  private readonly deps: ReconcilerDeps;
  private readonly intervalMs: number;
  private readonly transitionIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ReconcileResult> | null = null;
  private again = false;
  private stopped = true;
  private transitional = false;

  constructor(deps: ReconcilerDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? DEFAULT_SWEEP_MS;
    this.transitionIntervalMs = deps.transitionIntervalMs ?? DEFAULT_TRANSITION_SWEEP_MS;
  }

  /** Start sweeping: one run now, then on the drift schedule. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** A desired state changed: reconcile soon. */
  kick(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.reconcileOnce();
    } catch (error) {
      this.deps.log(`tenant reconcile failed: ${error instanceof Error ? error.message : "error"}`);
    }
    if (this.again) {
      this.again = false;
      this.schedule(0);
      return;
    }
    this.schedule(this.transitional ? this.transitionIntervalMs : this.intervalMs);
  }

  /** Bring the cluster in line with the store once. Runs are never concurrent. */
  reconcileOnce(): Promise<ReconcileResult> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    const run = this.run().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<ReconcileResult> {
    const { store, kube, params, catalog, tokens, now, log } = this.deps;
    const result: ReconcileResult = { applied: 0, pruned: 0, errors: 0, observed: {} };
    const owners = store.listTenants().filter((owner) => owner.desired !== "none");
    const keep = new Set(owners.map((owner) => owner.tid));

    // 1. Apply every desired tenant's objects.
    for (const owner of owners) {
      const spec = tenantSpec(owner, store.modelChoice(owner.userId), catalog, {
        api: tokens.apiToken(owner.tid),
        credentials: tokens.credentialToken(owner.tid),
      });
      if (spec === null) {
        // Its provider or model left the catalog: leave what runs as it is.
        log(`tenant ${owner.tid}: its model choice is not in the catalog; left unchanged`);
        continue;
      }
      const objects = buildTenantObjects(params, spec);
      const ordered: Array<[KubeKind, KubeObject]> = [
        [KINDS.secret, objects.secret],
        [KINDS.configMap, objects.configMap],
        [KINDS.service, objects.service],
        [KINDS.statefulSet, objects.statefulSet],
      ];
      for (const [kind, object] of ordered) {
        try {
          if (kind === KINDS.statefulSet) await keepClaimTemplates(kube, object);
          await kube.apply(kind, object);
          result.applied += 1;
        } catch (error) {
          result.errors += 1;
          log(`tenant ${owner.tid}: apply ${kind.kind} failed: ${error instanceof Error ? error.message : "error"}`);
        }
      }
    }

    // 2. Prune managed objects whose tenant is no longer desired. A failed
    //    listing prunes nothing of that kind. Volume claims are never pruned.
    for (const kind of [...TENANT_KINDS].reverse()) {
      let items: KubeObject[];
      try {
        items = await kube.list(kind, MANAGED_SELECTOR);
      } catch (error) {
        result.errors += 1;
        log(`tenant prune: list ${kind.plural} failed: ${error instanceof Error ? error.message : "error"}`);
        continue;
      }
      for (const item of items) {
        const tid = tenantOf(item);
        if (tid === null || keep.has(tid) || labelsOf(item)[MANAGED_BY_LABEL] !== MANAGED_BY) continue;
        try {
          if (await kube.delete(kind, nameOf(item))) {
            result.pruned += 1;
            log(`tenant ${tid}: pruned ${kind.kind} ${nameOf(item)}`);
          }
        } catch (error) {
          result.errors += 1;
          log(`tenant ${tid}: delete ${kind.kind} failed: ${error instanceof Error ? error.message : "error"}`);
        }
      }
    }

    // 3. Read pod status back as each tenant's observed state.
    let pods: KubeObject[] | null = null;
    try {
      pods = await kube.list(KINDS.pod, MANAGED_SELECTOR);
    } catch (error) {
      result.errors += 1;
      log(`tenant status: list pods failed: ${error instanceof Error ? error.message : "error"}`);
    }
    let transitional = false;
    if (pods !== null) {
      const byTenant = new Map<string, KubeObject[]>();
      for (const pod of pods) {
        const tid = tenantOf(pod);
        if (tid === null) continue;
        byTenant.set(tid, [...(byTenant.get(tid) ?? []), pod]);
      }
      const at = now();
      for (const owner of owners) {
        const tenantPods = byTenant.get(owner.tid) ?? [];
        let observed: TenantObserved;
        if (!tenantRuns(owner)) {
          observed = tenantPods.length === 0 ? "stopped" : "pending";
        } else if (tenantPods.length === 0) {
          observed = "pending";
        } else {
          const states = tenantPods.map(podObserved);
          observed = states.includes("crashloop") ? "crashloop" : states.includes("running") ? "running" : "pending";
        }
        if (observed === "pending") transitional = true;
        result.observed[owner.tid] = observed;
        store.recordTenantObserved(owner.tid, observed, at);
      }
    }
    this.transitional = transitional;
    return result;
  }
}
