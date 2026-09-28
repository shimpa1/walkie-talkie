import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PushSubscription, VapidKeys } from "./webpush.js";

/**
 * Durable push state: the VAPID key pair, the device subscriptions, and the
 * event cursor/seen-set. It lives in one gitignored JSON file so a restart
 * reuses the same keys and never re-notifies an event it already delivered.
 */

export interface PushSubscriptionRecord extends PushSubscription {
  addedAt: string;
}

export interface PushEventState {
  initialized: boolean;
  replyCursor: string;
  decisions: string[];
  workers: Record<string, string>;
  prs: string[];
}

export interface PushStoreData {
  vapid: VapidKeys | null;
  subscriptions: PushSubscriptionRecord[];
  state: PushEventState;
}

export function emptyEventState(): PushEventState {
  return { initialized: false, replyCursor: "", decisions: [], workers: {}, prs: [] };
}

export function emptyStoreData(): PushStoreData {
  return { vapid: null, subscriptions: [], state: emptyEventState() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coerceState(value: unknown): PushEventState {
  if (!isRecord(value)) return emptyEventState();
  const workers: Record<string, string> = {};
  if (isRecord(value.workers)) {
    for (const [key, state] of Object.entries(value.workers)) {
      if (typeof state === "string") workers[key] = state;
    }
  }
  return {
    initialized: value.initialized === true,
    replyCursor: typeof value.replyCursor === "string" ? value.replyCursor : "",
    decisions: Array.isArray(value.decisions) ? value.decisions.filter((id): id is string => typeof id === "string") : [],
    workers,
    prs: Array.isArray(value.prs) ? value.prs.filter((id): id is string => typeof id === "string") : [],
  };
}

function coerceSubscription(value: unknown): PushSubscriptionRecord | null {
  if (!isRecord(value)) return null;
  const keys = value.keys;
  if (typeof value.endpoint !== "string" || !isRecord(keys)) return null;
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return {
    endpoint: value.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
  };
}

function coerceVapid(value: unknown): VapidKeys | null {
  if (!isRecord(value)) return null;
  if (typeof value.publicKey !== "string" || typeof value.privateKey !== "string") return null;
  return { publicKey: value.publicKey, privateKey: value.privateKey };
}

export function parseStoreData(raw: string): PushStoreData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStoreData();
  }
  if (!isRecord(parsed)) return emptyStoreData();
  const subscriptions = Array.isArray(parsed.subscriptions)
    ? parsed.subscriptions.map(coerceSubscription).filter((record): record is PushSubscriptionRecord => record !== null)
    : [];
  return {
    vapid: coerceVapid(parsed.vapid),
    subscriptions,
    state: coerceState(parsed.state),
  };
}

export class PushStore {
  private readonly path: string;
  private data: PushStoreData;

  constructor(path: string) {
    this.path = path;
    this.data = emptyStoreData();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.data = emptyStoreData();
      return;
    }
    try {
      this.data = parseStoreData(readFileSync(this.path, "utf8"));
    } catch {
      this.data = emptyStoreData();
    }
  }

  private persist(): void {
    const directory = dirname(this.path);
    if (directory.length > 0) mkdirSync(directory, { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort only; the atomic write already created the file 0600 where supported.
    }
  }

  getVapid(): VapidKeys | null {
    return this.data.vapid;
  }

  setVapid(keys: VapidKeys): void {
    this.data.vapid = keys;
    this.persist();
  }

  listSubscriptions(): PushSubscriptionRecord[] {
    return this.data.subscriptions.map((record) => ({ ...record, keys: { ...record.keys } }));
  }

  subscriptionCount(): number {
    return this.data.subscriptions.length;
  }

  /** Add or replace a subscription, keyed by endpoint. */
  addSubscription(subscription: PushSubscription, now: Date = new Date()): PushSubscriptionRecord {
    const record: PushSubscriptionRecord = {
      endpoint: subscription.endpoint,
      keys: { ...subscription.keys },
      addedAt: now.toISOString(),
    };
    const existing = this.data.subscriptions.findIndex((entry) => entry.endpoint === subscription.endpoint);
    if (existing >= 0) this.data.subscriptions[existing] = record;
    else this.data.subscriptions.push(record);
    this.persist();
    return record;
  }

  removeSubscription(endpoint: string): boolean {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((entry) => entry.endpoint !== endpoint);
    const removed = this.data.subscriptions.length !== before;
    if (removed) this.persist();
    return removed;
  }

  getState(): PushEventState {
    return {
      initialized: this.data.state.initialized,
      replyCursor: this.data.state.replyCursor,
      decisions: [...this.data.state.decisions],
      workers: { ...this.data.state.workers },
      prs: [...this.data.state.prs],
    };
  }

  setState(state: PushEventState): void {
    this.data.state = {
      initialized: state.initialized,
      replyCursor: state.replyCursor,
      decisions: [...state.decisions],
      workers: { ...state.workers },
      prs: [...state.prs],
    };
    this.persist();
  }
}
