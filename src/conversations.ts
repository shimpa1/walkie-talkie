import type { HerdrClient, HerdrPane, HerdrTab, HerdrWorkspace } from "./herdr.js";

export type ConversationKind = "primary" | "secondmate" | "worker";

export interface ConversationSession {
  /** Stable id for the detail route; the herdr pane id. */
  id: string;
  name: string;
  kind: ConversationKind;
  status: string;
  agent: string | null;
  title: string | null;
  cwd: string | null;
  workspace_id: string | null;
  tab_id: string | null;
}

export interface ConversationList {
  sessions: ConversationSession[];
}

export interface ConversationOutput {
  id: string;
  lines: number;
  output: string;
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

export function buildSessions(
  panes: readonly HerdrPane[],
  workspaces: readonly HerdrWorkspace[],
  tabs: readonly HerdrTab[],
): ConversationSession[] {
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.label]));
  const tabLabels = new Map(tabs.map((tab) => [tab.tabId, tab.label]));

  const sessions: ConversationSession[] = [];
  for (const pane of panes) {
    // Only panes with a registered agent are conversations; an empty shell pane
    // is not one.
    if (pane.agent === null) continue;
    const workspaceLabel = pane.workspaceId === null ? null : workspaceLabels.get(pane.workspaceId) ?? null;
    const tabLabel = pane.tabId === null ? null : tabLabels.get(pane.tabId) ?? null;
    const kind = classify(workspaceLabel, tabLabel);
    sessions.push({
      id: pane.paneId,
      name: conversationName(kind, workspaceLabel, tabLabel, pane.paneId),
      kind,
      status: pane.status ?? "unknown",
      agent: pane.agent,
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
 * tabs into a fleet session list; `read` returns one session's recent output.
 * Both delegate to the read-only herdr client, so the service never steers a
 * session.
 */
export class Conversations {
  private readonly herdr: HerdrClient;

  constructor(herdr: HerdrClient) {
    this.herdr = herdr;
  }

  async list(): Promise<ConversationList> {
    // The pane list is the essential read; the workspace and tab lists only
    // add labels and classification, so a failure there degrades the view
    // rather than hiding every session.
    const panes = await this.herdr.listPanes();
    const [workspaces, tabs] = await Promise.all([
      this.herdr.listWorkspaces().catch(() => [] as HerdrWorkspace[]),
      this.herdr.listTabs().catch(() => [] as HerdrTab[]),
    ]);
    return { sessions: buildSessions(panes, workspaces, tabs) };
  }

  async read(paneId: string, lines: number = DEFAULT_CONVERSATION_LINES): Promise<ConversationOutput> {
    const output = await this.herdr.readPane(paneId, lines);
    return { id: paneId, lines, output };
  }
}
