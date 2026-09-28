import { FM_SCRIPTS, parseJsonOutput, type FirstmateClient } from "./firstmate.js";
import {
  diffEvents,
  type EventSnapshot,
  type PushEvent,
  type ReceiptReplyEvent,
  type WorkerState,
} from "./push-events.js";
import type { PushStore } from "./push-store.js";
import type { PushMessage, PushSender, PushSubscription } from "./webpush.js";

export interface PushReceiptsSnapshot {
  replies: ReceiptReplyEvent[];
  cursor: string;
}

export interface PushBearingsSnapshot {
  decisions: string[];
  recordedPrs: string[];
  workers: WorkerState[];
}

export interface PushEventSource {
  receipts(after: string): Promise<PushReceiptsSnapshot>;
  bearings(): Promise<PushBearingsSnapshot>;
}

export interface PushSendSummary {
  sent: number;
  failed: number;
  removed: number;
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    if (entry === null || typeof entry !== "object") return [];
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" ? [id] : [];
  });
}

function workerStates(value: unknown): WorkerState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WorkerState[] => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.state !== "string") return [];
    return [{ id: record.id, state: record.state }];
  });
}

/**
 * The real event source. It reads firstmate through the same script client as
 * the rest of the service and only ever consumes fields the documented JSON
 * schema exposes.
 */
export class FirstmateEventSource implements PushEventSource {
  private readonly firstmate: FirstmateClient;

  constructor(firstmate: FirstmateClient) {
    this.firstmate = firstmate;
  }

  async receipts(after: string): Promise<PushReceiptsSnapshot> {
    const args = after === "" ? ["receipts"] : ["receipts", "--after", after];
    const result = await this.firstmate.run(FM_SCRIPTS.inbox, args);
    const parsed = parseJsonOutput(result.stdout);
    if (result.code !== 0 || parsed === null) {
      throw new Error(result.stderr.trim() || "firstmate receipts failed");
    }
    const json = JSON.parse(parsed) as Record<string, unknown>;
    const replies = Array.isArray(json.replies)
      ? json.replies.flatMap((entry): ReceiptReplyEvent[] => {
          if (entry === null || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.id !== "string" || typeof record.cursor !== "string") return [];
          return [{ id: record.id, cursor: record.cursor }];
        })
      : [];
    const cursor = typeof json.reply_cursor === "string" ? json.reply_cursor : after;
    return { replies, cursor };
  }

  async bearings(): Promise<PushBearingsSnapshot> {
    const result = await this.firstmate.run(FM_SCRIPTS.bearings, ["--json"]);
    const parsed = parseJsonOutput(result.stdout);
    if (result.code !== 0 || parsed === null) {
      throw new Error(result.stderr.trim() || "firstmate bearings failed");
    }
    const json = JSON.parse(parsed) as Record<string, unknown>;
    return {
      decisions: stringIds(json.decisions_open),
      recordedPrs: stringIds(json.recorded_prs),
      workers: workerStates(json.in_flight),
    };
  }
}

/**
 * Map an event to a notification. The bodies are fixed strings: no note body
 * or record free text is ever placed into a notification.
 */
export function notificationFor(event: PushEvent): PushMessage {
  switch (event.kind) {
    case "reply":
      return {
        title: "firstmate replied",
        body: "A reply to your queued instruction is ready.",
        url: "/?view=receipts",
        tag: "reply",
      };
    case "decision":
      return {
        title: "Decision waiting",
        body: "firstmate is waiting on a captain decision.",
        url: "/?view=status",
        tag: "decision",
      };
    case "pr":
      return {
        title: "PR ready for review",
        body: "A pull request is ready for review.",
        url: "/?view=status",
        tag: "pr",
      };
    case "blocked":
      return {
        title: "Worker blocked",
        body: "A worker is blocked and needs attention.",
        url: "/?view=status",
        tag: "blocked",
      };
  }
}

export interface PushApi {
  publicKey(): string;
  addSubscription(subscription: PushSubscription): { ok: true; replaced: boolean };
  removeSubscription(endpoint: string): boolean;
  sendTest(): Promise<PushSendSummary>;
}

export interface PushServiceOptions {
  store: PushStore;
  sender: PushSender;
  source: PushEventSource;
  pollSeconds: number;
  log?: (line: string) => void;
}

export class PushService implements PushApi {
  private readonly store: PushStore;
  private readonly sender: PushSender;
  private readonly source: PushEventSource;
  private readonly pollSeconds: number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(options: PushServiceOptions) {
    this.store = options.store;
    this.sender = options.sender;
    this.source = options.source;
    this.pollSeconds = options.pollSeconds;
    this.log = options.log ?? (() => {});
  }

  publicKey(): string {
    const keys = this.store.getVapid();
    if (keys === null) throw new Error("VAPID keys are not configured");
    return keys.publicKey;
  }

  addSubscription(subscription: PushSubscription): { ok: true; replaced: boolean } {
    const replaced = this.store.listSubscriptions().some((entry) => entry.endpoint === subscription.endpoint);
    this.store.addSubscription(subscription);
    return { ok: true, replaced };
  }

  removeSubscription(endpoint: string): boolean {
    return this.store.removeSubscription(endpoint);
  }

  async sendTest(): Promise<PushSendSummary> {
    return this.broadcast({
      title: "Reach test",
      body: "Push notifications are working on this device.",
      url: "/?view=settings",
      tag: "test",
    });
  }

  private async broadcast(message: PushMessage): Promise<PushSendSummary> {
    const summary: PushSendSummary = { sent: 0, failed: 0, removed: 0 };
    for (const subscription of this.store.listSubscriptions()) {
      try {
        const result = await this.sender.send(subscription, message);
        if (result.gone) {
          this.store.removeSubscription(subscription.endpoint);
          summary.removed += 1;
        } else if (result.status >= 200 && result.status < 300) {
          summary.sent += 1;
        } else {
          summary.failed += 1;
        }
      } catch (error) {
        summary.failed += 1;
        this.log(`push send failed for ${subscription.endpoint}: ${String(error)}`);
      }
    }
    return summary;
  }

  /** Poll firstmate once, notify for each new event, and persist progress. */
  async pollOnce(): Promise<{ events: PushEvent[]; sent: number }> {
    if (this.polling) return { events: [], sent: 0 };
    this.polling = true;
    try {
      const state = this.store.getState();
      const receipts = await this.source.receipts(state.replyCursor);
      const bearings = await this.source.bearings();
      const snapshot: EventSnapshot = {
        replies: receipts.replies,
        replyCursor: receipts.cursor,
        decisions: bearings.decisions,
        recordedPrs: bearings.recordedPrs,
        workers: bearings.workers,
      };
      const { events, next } = diffEvents(state, snapshot);
      let sent = 0;
      for (const event of events) {
        const summary = await this.broadcast(notificationFor(event));
        sent += summary.sent;
      }
      this.store.setState(next);
      return { events, sent };
    } finally {
      this.polling = false;
    }
  }

  /** Start polling immediately, then on the configured interval. */
  start(): void {
    if (this.timer !== null) return;
    const run = (): void => {
      void this.pollOnce().catch((error: unknown) => {
        this.log(`push poll failed: ${String(error)}`);
      });
    };
    run();
    this.timer = setInterval(run, this.pollSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
