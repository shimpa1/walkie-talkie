import type { HerdrClient, HerdrPane, HerdrTab, HerdrWorkspace } from "./herdr.js";
import {
  DEFAULT_HISTORY_LIMIT,
  type ConversationStore,
  type StoredConversationMessage,
} from "./conversation-store.js";
import type { FleetState, FleetStateProvider } from "./fleet-state.js";

export type ConversationKind = "primary" | "secondmate" | "worker";

/**
 * The state shown to the captain for a conversation. It is derived from
 * firstmate's own fleet state, never from a pane's `agent_status`: a pane can
 * read `blocked` while nothing is actually in flight, so the raw status is kept
 * separately as `status` and only `state` drives the badge.
 */
export type ConversationState = "needs_you" | "working" | "idle" | "unknown";

export interface ConversationSession {
  /** Stable id for the detail route; the herdr pane id. */
  id: string;
  name: string;
  kind: ConversationKind;
  /** The raw herdr pane status, kept for diagnostics only. */
  status: string;
  /** The firstmate-derived state the badge shows. */
  state: ConversationState;
  agent: string | null;
  /** The agent session the pane reported (opencode's `ses_...`), when known. */
  agent_session: string | null;
  title: string | null;
  cwd: string | null;
  workspace_id: string | null;
  tab_id: string | null;
}

export interface ConversationList {
  sessions: ConversationSession[];
}

/** A session's full conversation, read from the agent's own session store. */
export interface ConversationHistory {
  id: string;
  agent_session: string | null;
  source: "history";
  messages: StoredConversationMessage[];
  has_older: boolean;
  oldest_cursor: string | null;
}

/** Fallback for a session with no agent store: the terminal's visible screen. */
export interface ConversationTerminal {
  id: string;
  agent_session: string | null;
  source: "terminal";
  lines: number;
  output: string;
}

export type ConversationDetail = ConversationHistory | ConversationTerminal;

export interface HistoryOptions {
  /** Message rows to read per page (the store's own bound). */
  limit?: number;
  /** Read messages older than this opaque cursor. */
  before?: string | null;
  /** Lines to request from the terminal when history is unavailable. */
  lines?: number;
}

export const DEFAULT_CONVERSATION_LINES = 200;
export const MAX_CONVERSATION_LINES = 1000;
const MIN_CONVERSATION_LINES = 1;

/** Presentation workspaces are labelled "└ <task> · p:<token>". */
const PRESENTATION_PREFIX = "└ ";
const PRESENTATION_TOKEN = / · p:[A-Za-z0-9_-]+$/;

function cleanWorkspaceLabel(label: string): string {
  let text = label;
  if (text.startsWith(PRESENTATION_PREFIX)) text = text.slice(PRESENTATION_PREFIX.length);
  text = text.replace(PRESENTATION_TOKEN, "");
  return text.trim();
}

/** firstmate labels task tabs `fm-<task>`; the concise name is the task. */
function cleanTabLabel(label: string): string {
  return label.startsWith("fm-") ? label.slice(3) : label;
}

function classify(workspaceLabel: string | null, tabLabel: string | null): ConversationKind {
  if (workspaceLabel !== null && workspaceLabel.startsWith("2ndmate-")) return "secondmate";
  // The primary home workspace is labelled exactly "firstmate"; a task tab
  // (`fm-…`) inside it is a crewmate running in the flat (non-projected) layout.
  if (workspaceLabel === "firstmate" && (tabLabel === null || !tabLabel.startsWith("fm-"))) {
    return "primary";
  }
  return "worker";
}

function conversationName(
  kind: ConversationKind,
  workspaceLabel: string | null,
  tabLabel: string | null,
  paneId: string,
): string {
  if (kind === "primary") return "firstmate";
  if (kind === "secondmate" && workspaceLabel !== null) return workspaceLabel;
  if (tabLabel !== null && tabLabel.startsWith("fm-")) return cleanTabLabel(tabLabel);
  if (workspaceLabel !== null) {
    const cleaned = cleanWorkspaceLabel(workspaceLabel);
    if (cleaned.length > 0) return cleaned;
  }
  if (tabLabel !== null) return tabLabel;
  return paneId;
}

const KIND_RANK: Record<ConversationKind, number> = { primary: 0, secondmate: 1, worker: 2 };

/** firstmate labels task tabs `fm-<task>` and secondmate workspaces `2ndmate-<id>`. */
const NAME_PREFIXES = ["2ndmate-", "fm-"];

function matchKey(value: string | null): string {
  if (value === null) return "";
  let text = value.toLowerCase();
  for (const prefix of NAME_PREFIXES) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }
  return text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve a session name to the one fleet row it owns. Matching is a strict
 * normalized-key identity (case, separators, and the `fm-` / `2ndmate-` label
 * prefixes are ignored); there is no prefix/containment fallback, so a session
 * whose own row is absent from the projection resolves to no row instead of a
 * sibling (`reach-slice-2` never binds to `reach-slice`, `2ndmate-infra-2`
 * never binds to `infra`).
 */
function findRow<T>(
  name: string,
  rows: readonly T[],
  keys: (row: T) => readonly (string | null)[],
): T | undefined {
  const target = matchKey(name);
  if (target.length === 0) return undefined;
  return rows.find((row) => keys(row).some((key) => matchKey(key) === target));
}

/**
 * Derive the badge state for one conversation from firstmate's real fleet.
 *
 * The default is idle. The primary conversation reflects the whole fleet: it
 * needs the captain only when a decision or gate is waiting, is working when
 * work or a secondmate is live, and is idle otherwise. A secondmate/worker
 * conversation is matched to its own fleet row and is never labeled needs_you
 * unless that row is genuinely a captain decision. When firstmate's state
 * cannot be read at all, the state is `unknown` rather than a guess.
 */
export function deriveSessionState(
  kind: ConversationKind,
  name: string,
  fleet: FleetState | null,
): ConversationState {
  if (fleet === null) return "unknown";

  const captainWaiting =
    fleet.decisions_open > 0 ||
    fleet.gates > 0 ||
    fleet.secondmates.some((mate) => mate.state === "captain_decision");

  if (kind === "primary") {
    if (captainWaiting) return "needs_you";
    if (fleet.in_flight.length > 0 || fleet.secondmates.length > 0) return "working";
    return "idle";
  }

  if (kind === "secondmate") {
    const mate = findRow(name, fleet.secondmates, (entry) => [entry.id]);
    if (mate === undefined) return "idle";
    if (mate.state === "captain_decision") return "needs_you";
    if (mate.state === "active_child_work" || mate.state === "working") return "working";
    return "idle";
  }

  const worker = findRow(name, fleet.in_flight, (entry) => [entry.id, entry.name]);
  return worker === undefined ? "idle" : "working";
}

export function buildSessions(
  panes: readonly HerdrPane[],
  workspaces: readonly HerdrWorkspace[],
  tabs: readonly HerdrTab[],
  fleet: FleetState | null = null,
): ConversationSession[] {
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.label]));
  const tabLabels = new Map(tabs.map((tab) => [tab.tabId, tab.label]));

  const sessions: ConversationSession[] = [];
  for (const pane of panes) {
    // Every pane is a session; one without a registered agent is listed with an
    // unknown status.
    const workspaceLabel = pane.workspaceId === null ? null : workspaceLabels.get(pane.workspaceId) ?? null;
    const tabLabel = pane.tabId === null ? null : tabLabels.get(pane.tabId) ?? null;
    const kind = classify(workspaceLabel, tabLabel);
    const name = conversationName(kind, workspaceLabel, tabLabel, pane.paneId);
    sessions.push({
      id: pane.paneId,
      name,
      kind,
      status: pane.status ?? "unknown",
      state: deriveSessionState(kind, name, fleet),
      agent: pane.agent,
      agent_session: pane.agentSession,
      title: pane.title,
      cwd: pane.cwd,
      workspace_id: pane.workspaceId,
      tab_id: pane.tabId,
    });
  }

  sessions.sort((a, b) => {
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rank !== 0) return rank;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
  return sessions;
}

/** Clamp a user-supplied line count to a bounded, cheap read. */
export function clampLines(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_CONVERSATION_LINES;
  if (parsed < MIN_CONVERSATION_LINES) return MIN_CONVERSATION_LINES;
  if (parsed > MAX_CONVERSATION_LINES) return MAX_CONVERSATION_LINES;
  return parsed;
}

/**
 * The read-only Conversations view. `list` joins herdr's panes, workspaces, and
 * tabs into a fleet session list and derives each session's displayed state
 * from firstmate's own fleet state; `history` reads a session's full
 * conversation from the agent's own store, falling back to the terminal's
 * visible screen when no store or agent session is available. Every read
 * delegates to a read-only client, so the service never steers a session.
 */
export class Conversations {
  private readonly herdr: HerdrClient;
  private readonly store: ConversationStore | null;
  private readonly fleetProvider: FleetStateProvider | null;
  private paneAgents = new Map<string, string | null>();

  constructor(
    herdr: HerdrClient,
    store: ConversationStore | null = null,
    fleetProvider: FleetStateProvider | null = null,
  ) {
    this.herdr = herdr;
    this.store = store;
    this.fleetProvider = fleetProvider;
  }

  async list(): Promise<ConversationList> {
    // The pane list is the essential read; the workspace and tab lists only
    // add labels and classification, so a failure there degrades the view
    // rather than hiding every session.
    const panes = await this.herdr.listPanes();
    this.rememberPanes(panes);
    const [workspaces, tabs] = await Promise.all([
      this.herdr.listWorkspaces().catch(() => [] as HerdrWorkspace[]),
      this.herdr.listTabs().catch(() => [] as HerdrTab[]),
    ]);
    // The fleet read only supplies the badge; a failure there degrades every
    // state to `unknown` rather than hiding the sessions.
    const fleet =
      this.fleetProvider === null ? null : await this.fleetProvider().catch(() => null);
    return { sessions: buildSessions(panes, workspaces, tabs, fleet) };
  }

  /**
   * Read one session's detail: its full conversation from the agent store when
   * possible, else the terminal's visible screen. The pane-to-agent-session map
   * comes from the most recent `list`; a miss refreshes it once.
   */
  async history(paneId: string, options: HistoryOptions = {}): Promise<ConversationDetail> {
    const agentSession = await this.resolveAgentSession(paneId);
    if (agentSession !== null && this.store !== null) {
      const page = await this.store.readHistory(agentSession, {
        limit: options.limit ?? DEFAULT_HISTORY_LIMIT,
        before: options.before ?? null,
      });
      if (page !== null) {
        return { id: paneId, agent_session: agentSession, source: "history", ...page };
      }
    }
    const lines = options.lines ?? DEFAULT_CONVERSATION_LINES;
    const output = await this.herdr.readPane(paneId, lines);
    return { id: paneId, agent_session: agentSession, source: "terminal", lines, output };
  }

  private rememberPanes(panes: readonly HerdrPane[]): void {
    this.paneAgents = new Map(panes.map((pane) => [pane.paneId, pane.agentSession]));
  }

  private async resolveAgentSession(paneId: string): Promise<string | null> {
    if (this.paneAgents.has(paneId)) return this.paneAgents.get(paneId) ?? null;
    this.rememberPanes(await this.herdr.listPanes());
    return this.paneAgents.get(paneId) ?? null;
  }
}
