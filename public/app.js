import { createVoiceInput, speechRecognitionCtor } from "./voice.js";
import {
  createApi,
  forgetToken,
  readToken,
  resolveToken,
  tokenSuffix,
  UNAUTHORIZED_MESSAGE,
  writeToken,
} from "./token.js";

const state = {
  token: readToken(localStorage),
  pendingRequestId: null,
  pendingRequestText: null,
  status: null,
  voice: null,
  view: null,
};

const conversationState = {
  sessions: [],
  threads: [],
  selectedId: null,
  selectedThreadId: null,
  listTimer: null,
  outputTimer: null,
  busy: false,
  forceScroll: false,
  source: null,
  agentSession: null,
  messages: [],
  oldestCursor: null,
  hasOlder: false,
};

const CONVERSATION_LIST_INTERVAL_MS = 5000;
const CONVERSATION_OUTPUT_INTERVAL_MS = 3000;
const CONVERSATION_OUTPUT_LINES = 400;
const CONVERSATION_HISTORY_LIMIT = 200;

const $ = (id) => document.getElementById(id);

function setBanner(message, kind) {
  const banner = $("connection-banner");
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind || ""}`;
  banner.textContent = message;
}

function handleUnauthorized(_response, token) {
  if (token !== state.token) return;
  if (resolveToken(localStorage, $("token-input").value) === token) {
    state.token = "";
    forgetToken(localStorage);
    $("token-input").value = "";
  }
  setBanner(UNAUTHORIZED_MESSAGE, "bad");
  showView("settings");
  setSettingsStatus(UNAUTHORIZED_MESSAGE, "bad");
}

const api = createApi({
  getToken: () => state.token,
  onUnauthorized: handleUnauthorized,
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function mintRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function card(title, sub, badges) {
  const node = el("article", "card");
  const heading = el("h3");
  heading.appendChild(document.createTextNode(title));
  for (const [label, kind] of badges || []) {
    heading.appendChild(el("span", `badge ${kind || ""}`, label));
  }
  node.appendChild(heading);
  if (sub) node.appendChild(el("div", "sub", sub));
  return node;
}

function section(title, container) {
  const wrap = el("section");
  wrap.appendChild(el("div", "section-title", title));
  wrap.appendChild(container);
  return wrap;
}

function renderStatus(payload) {
  state.status = payload;
  $("home-label").textContent = payload.home ? `home: ${payload.home}` : "firstmate companion";

  const meta = $("status-meta");
  meta.textContent = "";
  const counts = [
    ["In flight", Array.isArray(payload.in_flight) ? payload.in_flight.length : 0],
    ["Secondmates", Array.isArray(payload.secondmates) ? payload.secondmates.length : 0],
    ["Open decisions", Array.isArray(payload.decisions_open) ? payload.decisions_open.length : 0],
    ["Gates", Array.isArray(payload.gates) ? payload.gates.length : 0],
  ];
  for (const [label, value] of counts) {
    const stat = el("div", "stat");
    stat.appendChild(el("b", null, value));
    stat.appendChild(el("span", null, label));
    meta.appendChild(stat);
  }

  const body = $("status-body");
  body.textContent = "";
  if (payload.generated) {
    body.appendChild(el("p", "hint", `Observed ${payload.generated}`));
  }

  const flight = el("div", "cards");
  const inFlight = Array.isArray(payload.in_flight) ? payload.in_flight : [];
  if (inFlight.length === 0) flight.appendChild(el("div", "card empty", "Nothing in flight."));
  for (const item of inFlight) {
    flight.appendChild(
      card(item.name || item.id || "work", item.doing || "", [[item.state || "unknown", stateKind(item.state)]]),
    );
  }
  body.appendChild(section("In flight", flight));

  const mates = el("div", "cards");
  const secondmates = Array.isArray(payload.secondmates) ? payload.secondmates : [];
  if (secondmates.length === 0) mates.appendChild(el("div", "card empty", "No secondmates registered."));
  for (const mate of secondmates) {
    mates.appendChild(
      card(mate.id || "secondmate", mate.doing || "", [[mate.state || "unknown", stateKind(mate.state)]]),
    );
  }
  body.appendChild(section("Secondmates", mates));

  const decisions = el("div", "cards");
  const open = Array.isArray(payload.decisions_open) ? payload.decisions_open : [];
  if (open.length === 0) decisions.appendChild(el("div", "card empty", "No open decisions."));
  for (const item of open) {
    decisions.appendChild(card(item.summary || item.key || "decision", item.owner || "", [[item.verb || "open", "warn"]]));
  }
  body.appendChild(section("Open decisions", decisions));

  const gates = el("div", "cards");
  const gateList = Array.isArray(payload.gates) ? payload.gates : [];
  if (gateList.length === 0) gates.appendChild(el("div", "card empty", "No gates."));
  for (const gate of gateList) {
    gates.appendChild(card(gate.title || gate.id || "gate", gate.reason || "", [[gate.owner || "gate", "warn"]]));
  }
  body.appendChild(section("Gates", gates));

  const landed = Array.isArray(payload.landed) ? payload.landed : [];
  if (landed.length > 0) {
    const list = el("div", "cards");
    for (const item of landed) {
      list.appendChild(card(item.what || item.id || "landed", item.artifact || "", [[item.owner || "", ""]]));
    }
    body.appendChild(section("Landed", list));
  }
}

function stateKind(value) {
  const text = String(value || "").toLowerCase();
  if (/(fail|error|block|dead)/.test(text)) return "bad";
  if (/(run|working|active|open|hold|wait)/.test(text)) return "warn";
  if (/(done|ok|ready|green|pass|healthy)/.test(text)) return "ok";
  return "";
}

async function loadStatus() {
  try {
    const payload = await api("/api/status");
    renderStatus(payload);
    setBanner(null);
  } catch (error) {
    if (error && error.status === 401) return;
    setBanner(`Could not load fleet status: ${error.message}`, "bad");
  }
}

/** A timestamp from either Unix milliseconds or an ISO string, or "" if unusable. */
function formatTimestamp(value) {
  if (value === null || value === undefined || value === "") return "";
  let ms;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) ms = Number(value);
  else ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarize(text) {
  const firstLine = String(text || "").split("\n")[0].trim();
  if (firstLine.length === 0) return "(empty instruction)";
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/** Build the instruction threads from firstmate's receipts payload. */
function buildThreads(payload) {
  const byId = new Map();
  const add = (note, handled) => {
    const id = note.note_id || note.id || note.request_id;
    if (!id) return;
    byId.set(id, {
      id,
      body: note.body || note.text || "",
      at: note.at || null,
      requestId: note.request_id || null,
      acknowledged: typeof note.acknowledged === "boolean" ? note.acknowledged : handled,
      announced: note.announced,
      reply: note.reply || null,
    });
  };
  for (const note of Array.isArray(payload.pending) ? payload.pending : []) add(note, false);
  for (const note of Array.isArray(payload.handled) ? payload.handled : []) add(note, true);
  for (const reply of Array.isArray(payload.replies) ? payload.replies : []) {
    const id = reply.id;
    if (!id) continue;
    const thread = byId.get(id);
    if (thread) {
      if (!thread.reply) thread.reply = reply;
      continue;
    }
    byId.set(id, {
      id,
      body: "",
      at: reply.at || null,
      requestId: reply.request_id || null,
      acknowledged: true,
      announced: reply.announced,
      reply,
    });
  }
  const threads = [...byId.values()];
  threads.sort((a, b) => threadTime(b) - threadTime(a));
  return threads;
}

/** The instruction text for a thread, or the reply's text when only a reply exists. */
function threadText(thread) {
  if (thread.body) return thread.body;
  return thread.reply && thread.reply.body ? thread.reply.body : "";
}

function threadTime(thread) {
  const value = (thread.reply && thread.reply.at) || thread.at;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function threadState(thread) {
  if (thread.reply) return { label: "replied", kind: "ok" };
  if (thread.acknowledged) return { label: "working", kind: "warn" };
  return { label: "queued", kind: "" };
}

function deliveryLine(thread) {
  if (thread.reply) return "Delivered; firstmate replied.";
  if (thread.acknowledged) return "Delivered; firstmate is working on it.";
  if (thread.announced === false) return "Queued; firstmate has not been woken yet.";
  return "Queued; waiting for firstmate.";
}

function selectedThread() {
  return conversationState.threads.find((thread) => thread.id === conversationState.selectedThreadId) || null;
}

function selectedThreadById(id) {
  return conversationState.threads.find((thread) => thread.id === id) || null;
}

async function submitNote(event) {
  event.preventDefault();
  if (state.voice) state.voice.stop();
  const text = $("note-text").value.trim();
  if (!text) return;
  if (!state.pendingRequestId || state.pendingRequestText !== text) {
    state.pendingRequestId = mintRequestId();
    state.pendingRequestText = text;
  }
  const button = $("send");
  const status = $("compose-status");
  button.disabled = true;
  status.textContent = "Queueing…";
  try {
    const receipt = await api("/api/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requestId: state.pendingRequestId }),
    });
    status.textContent = "";
    state.pendingRequestId = null;
    state.pendingRequestText = null;
    $("note-text").value = "";
    $("conversation-composer").hidden = true;
    await loadThreads();
    const noteId = receipt && (receipt.note_id || receipt.id);
    if (noteId && selectedThreadById(noteId)) selectThread(noteId);
  } catch (error) {
    status.textContent = `Not queued: ${error.message}. Press send again to retry with the same request id.`;
  } finally {
    button.disabled = false;
  }
}

function initVoice() {
  const button = $("mic");
  const status = $("compose-status");
  const Recognition = speechRecognitionCtor();
  if (!Recognition) {
    button.hidden = true;
    return;
  }
  button.hidden = false;

  const voice = createVoiceInput({
    createRecognition: () => new Recognition(),
    getText: () => $("note-text").value,
    setText: (text) => {
      $("note-text").value = text;
    },
    onState: (state, message) => {
      const listening = state === "listening";
      button.classList.toggle("is-listening", listening);
      button.setAttribute("aria-pressed", listening ? "true" : "false");
      button.textContent = listening ? "Listening…" : "Hold to talk";
      if (listening) status.textContent = "Listening… release to stop.";
      else if (message) status.textContent = message;
      else status.textContent = "";
    },
  });
  state.voice = voice;

  const begin = (event) => {
    event.preventDefault();
    if (typeof button.setPointerCapture === "function") {
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a convenience; the release handlers still stop the voice.
      }
    }
    voice.start();
  };
  const end = () => voice.stop();

  button.addEventListener("pointerdown", begin);
  button.addEventListener("pointerup", end);
  button.addEventListener("pointercancel", end);
  button.addEventListener("pointerleave", end);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      voice.start();
    }
  });
  button.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      voice.stop();
    }
  });
}

function applyThreads(payload) {
  conversationState.threads = buildThreads(payload || {});
  renderThreads();
}

function renderThreads() {
  const body = $("threads-body");
  body.textContent = "";
  const threads = conversationState.threads;
  if (threads.length === 0) {
    body.appendChild(el("div", "card empty", "No conversations yet. Start one."));
    return;
  }
  for (const thread of threads) {
    const card = el("button", "session-card thread-card");
    card.type = "button";
    card.dataset.id = thread.id;
    if (thread.id === conversationState.selectedThreadId) card.classList.add("is-selected");

    const head = el("div", "session-card-head");
    head.appendChild(el("strong", null, summarize(threadText(thread))));
    const info = threadState(thread);
    head.appendChild(el("span", `badge ${info.kind}`, info.label));
    card.appendChild(head);

    const stamp = formatTimestamp(threadTime(thread) || null);
    card.appendChild(el("div", "sub", stamp ? `${stamp} · ${deliveryLine(thread)}` : deliveryLine(thread)));
    card.addEventListener("click", () => selectThread(thread.id));
    body.appendChild(card);
  }
}

async function loadThreads() {
  try {
    const payload = await api("/api/receipts");
    applyThreads(payload);
    if (conversationState.selectedThreadId && !selectedThread()) closeConversation();
    else if (conversationState.selectedThreadId) {
      setConversationHeader();
      renderThread();
    }
  } catch (error) {
    if (error && error.status === 401) return;
    const body = $("threads-body");
    body.textContent = "";
    body.appendChild(el("div", "card empty", `Could not load conversations: ${error.message}`));
  }
}

function selectedSession() {
  return conversationState.sessions.find((session) => session.id === conversationState.selectedId) || null;
}

function conversationStateKind(value) {
  if (value === "needs_you") return "bad";
  if (value === "working") return "warn";
  return "";
}

function conversationStateLabel(value) {
  if (value === "needs_you") return "needs you";
  return value || "unknown";
}

function renderSessions(payload) {
  const body = $("sessions-body");
  body.textContent = "";
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  conversationState.sessions = sessions;

  if (sessions.length === 0) {
    body.appendChild(el("div", "card empty", "No live sessions found."));
    return;
  }

  for (const session of sessions) {
    const card = el("button", "session-card");
    card.type = "button";
    card.dataset.id = session.id;
    if (session.id === conversationState.selectedId) card.classList.add("is-selected");

    const head = el("div", "session-card-head");
    head.appendChild(el("strong", null, session.name || session.id));
    head.appendChild(
      el("span", `badge ${conversationStateKind(session.state)}`, conversationStateLabel(session.state)),
    );
    card.appendChild(head);
    card.appendChild(el("div", "sub", session.title || session.kind));
    card.appendChild(el("div", "session-card-meta", `${session.kind} · ${session.agent || "agent"} · ${session.id}`));
    card.addEventListener("click", () => selectSession(session.id));
    body.appendChild(card);
  }
}

function setConversationHeader() {
  const status = $("conversation-status");
  if (conversationState.selectedThreadId) {
    const thread = selectedThread();
    $("conversation-name").textContent = thread ? summarize(threadText(thread)) : "—";
    $("conversation-sub").textContent = thread && thread.requestId ? `request ${thread.requestId}` : "";
    const info = thread ? threadState(thread) : null;
    status.textContent = info ? info.label : "—";
    status.className = info ? `badge ${info.kind}` : "badge";
    return;
  }
  const session = selectedSession();
  $("conversation-name").textContent = session ? session.name || session.id : "—";
  const parts = [];
  if (session) {
    parts.push(session.kind);
    if (session.cwd) parts.push(session.cwd);
    parts.push(session.id);
  }
  $("conversation-sub").textContent = parts.join(" · ");
  const sessionState = session ? session.state : null;
  status.textContent = sessionState ? conversationStateLabel(sessionState) : "—";
  status.className = sessionState ? `badge ${conversationStateKind(sessionState)}` : "badge";
}

function selectSession(id) {
  conversationState.selectedThreadId = null;
  conversationState.selectedId = id;
  conversationState.forceScroll = true;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  $("conversation-composer").hidden = true;
  $("conversation-detail").hidden = false;
  $("conversations-pane").classList.add("is-detail");
  setConversationHeader();
  renderThreads();
  renderSessions({ sessions: conversationState.sessions });
  showConversationMessage("Loading…");
  void refreshConversation();
}

function selectThread(id) {
  conversationState.selectedId = null;
  conversationState.selectedThreadId = id;
  conversationState.forceScroll = true;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  $("conversation-composer").hidden = true;
  $("conversation-detail").hidden = false;
  $("conversations-pane").classList.add("is-detail");
  setConversationHeader();
  renderThreads();
  renderSessions({ sessions: conversationState.sessions });
  renderThread();
}

function closeConversation() {
  conversationState.selectedId = null;
  conversationState.selectedThreadId = null;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  $("conversation-detail").hidden = true;
  $("conversations-pane").classList.remove("is-detail");
  renderThreads();
  renderSessions({ sessions: conversationState.sessions });
}

function renderThread() {
  const box = conversationOutput();
  box.textContent = "";
  const thread = selectedThread();
  if (!thread) {
    box.appendChild(el("p", "hint", "This conversation is no longer available."));
    return;
  }
  const messages = [];
  if (thread.body) {
    messages.push({ role: "user", label: "you", time: thread.at, text: thread.body });
  }
  if (thread.reply) {
    messages.push({ role: "assistant", label: "firstmate", time: thread.reply.at, text: thread.reply.body });
  }
  for (const node of messageCards(messages)) box.appendChild(node);
  box.appendChild(el("p", "hint thread-delivery", deliveryLine(thread)));
}

function conversationOutput() {
  return $("conversation-output");
}

function showConversationMessage(text) {
  const box = conversationOutput();
  box.textContent = "";
  box.appendChild(el("p", "hint", text));
}

function conversationNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
}

function messageCards(messages) {
  const nodes = [];
  for (const message of messages) {
    const role = message.role === "user" ? "user" : "assistant";
    const card = el("article", `msg msg-${role}`);
    const label =
      message.label || (role === "user" ? "firstmate" : message.role === "assistant" ? "agent" : message.role);
    const head = el("div", "msg-head");
    head.appendChild(el("span", "msg-role", label));
    const stamp = formatTimestamp(message.time);
    if (stamp) head.appendChild(el("time", "msg-time", stamp));
    card.appendChild(head);
    card.appendChild(el("div", "msg-text", message.text));
    nodes.push(card);
  }
  return nodes;
}

function renderHistory() {
  const box = conversationOutput();
  const nearBottom = conversationNearBottom(box);
  const previousScrollTop = box.scrollTop;
  box.textContent = "";
  if (conversationState.hasOlder) {
    const button = el("button", "ghost small load-older", "Load older messages");
    button.type = "button";
    button.addEventListener("click", () => void loadOlderMessages());
    box.appendChild(button);
  }
  if (conversationState.messages.length === 0) {
    box.appendChild(el("p", "hint", "No conversation messages yet."));
  } else {
    for (const node of messageCards(conversationState.messages)) box.appendChild(node);
  }
  if (nearBottom || conversationState.forceScroll) {
    box.scrollTop = box.scrollHeight;
    conversationState.forceScroll = false;
  } else {
    box.scrollTop = previousScrollTop;
  }
}

function renderTerminal(payload) {
  const box = conversationOutput();
  const nearBottom = conversationNearBottom(box);
  const previousScrollTop = box.scrollTop;
  box.textContent = "";
  box.appendChild(el("pre", "terminal", payload.output || "(no output yet)"));
  if (nearBottom || conversationState.forceScroll) {
    box.scrollTop = box.scrollHeight;
    conversationState.forceScroll = false;
  } else {
    box.scrollTop = previousScrollTop;
  }
}

function applyTerminal(payload) {
  conversationState.source = "terminal";
  conversationState.agentSession = payload.agent_session || null;
  setConversationHeader();
  renderTerminal(payload);
}

function normalizeMessages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((message) => message && typeof message.id === "string" && typeof message.text === "string")
    .map((message) => ({
      id: message.id,
      role: typeof message.role === "string" ? message.role : "assistant",
      time: Number(message.time) || 0,
      text: message.text,
    }));
}

function mergeMessages(incoming) {
  const byId = new Map(conversationState.messages.map((message) => [message.id, message]));
  let changed = 0;
  let added = 0;
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing === undefined) {
      byId.set(message.id, message);
      conversationState.messages.push(message);
      added += 1;
      changed += 1;
      continue;
    }
    if (existing.text !== message.text || existing.role !== message.role) {
      existing.text = message.text;
      existing.role = message.role;
      changed += 1;
    }
  }
  if (added > 0) {
    conversationState.messages.sort(
      (a, b) => a.time - b.time || a.id.localeCompare(b.id),
    );
  }
  return changed;
}

function conversationUrl(params) {
  const query = new URLSearchParams();
  query.set("limit", String(CONVERSATION_HISTORY_LIMIT));
  query.set("lines", String(CONVERSATION_OUTPUT_LINES));
  if (params && params.before) query.set("before", params.before);
  return `/api/sessions/${encodeURIComponent(conversationState.selectedId)}?${query.toString()}`;
}

async function fetchConversation(params) {
  const id = conversationState.selectedId;
  const payload = await api(conversationUrl(params));
  if (!id || conversationState.selectedId !== id) return null;
  return payload;
}

function applyHistory(payload) {
  conversationState.source = "history";
  conversationState.agentSession = payload.agent_session || null;
  conversationState.messages = normalizeMessages(payload.messages);
  conversationState.oldestCursor = payload.oldest_cursor || null;
  conversationState.hasOlder = Boolean(payload.has_older);
  setConversationHeader();
  renderHistory();
}

function historySessionChanged(payload) {
  return (payload.agent_session || null) !== conversationState.agentSession;
}

async function fetchLatestConversation() {
  const payload = await fetchConversation({});
  if (payload === null) return;
  if (payload.source !== "history") {
    applyTerminal(payload);
    return;
  }
  applyHistory(payload);
}

async function refreshHistoryMessages() {
  const payload = await fetchConversation({});
  if (payload === null) return;
  if (payload.source !== "history") {
    applyTerminal(payload);
    return;
  }
  if (historySessionChanged(payload)) {
    applyHistory(payload);
    return;
  }
  const changed = mergeMessages(normalizeMessages(payload.messages));
  if (conversationState.oldestCursor === null && payload.oldest_cursor) {
    conversationState.oldestCursor = payload.oldest_cursor;
    conversationState.hasOlder = Boolean(payload.has_older);
  }
  if (changed > 0) renderHistory();
}

async function loadOlderMessages() {
  const cursor = conversationState.oldestCursor;
  if (!cursor || conversationState.busy) return;
  const session = selectedSession();
  if (session && (session.agent_session || null) !== conversationState.agentSession) {
    await fetchLatestConversation();
    return;
  }
  conversationState.busy = true;
  const box = conversationOutput();
  const previousHeight = box.scrollHeight;
  try {
    const payload = await fetchConversation({ before: cursor });
    if (payload === null || payload.source !== "history") return;
    if (historySessionChanged(payload)) {
      await fetchLatestConversation();
      return;
    }
    mergeMessages(normalizeMessages(payload.messages));
    conversationState.oldestCursor = payload.oldest_cursor || conversationState.oldestCursor;
    conversationState.hasOlder = Boolean(payload.has_older);
    renderHistory();
    box.scrollTop += box.scrollHeight - previousHeight;
  } catch (error) {
    // Keep the conversation already on screen; the next poll can retry.
    if (error && error.status === 401) return;
  } finally {
    conversationState.busy = false;
  }
}

async function refreshConversation() {
  if (!conversationState.selectedId || conversationState.busy) return;
  conversationState.busy = true;
  try {
    if (conversationState.source === "history") await refreshHistoryMessages();
    else await fetchLatestConversation();
  } catch (error) {
    if (error && error.status === 401) return;
    if (conversationState.source === "history" && conversationState.messages.length > 0) return;
    showConversationMessage(`Could not read this conversation: ${error.message}`);
  } finally {
    conversationState.busy = false;
  }
}

async function loadSessions() {
  const body = $("sessions-body");
  try {
    const payload = await api("/api/sessions");
    renderSessions(payload);
    if (conversationState.selectedId && !selectedSession()) closeConversation();
    else if (conversationState.selectedId) setConversationHeader();
  } catch (error) {
    if (error && error.status === 401) return;
    body.textContent = "";
    body.appendChild(el("div", "card empty", `Could not load live sessions: ${error.message}`));
  }
}

function startConversationsPolling() {
  stopConversationsPolling();
  conversationState.listTimer = setInterval(() => {
    void loadSessions();
    void loadThreads();
  }, CONVERSATION_LIST_INTERVAL_MS);
  conversationState.outputTimer = setInterval(
    () => void refreshConversation(),
    CONVERSATION_OUTPUT_INTERVAL_MS,
  );
}

function stopConversationsPolling() {
  if (conversationState.listTimer !== null) {
    clearInterval(conversationState.listTimer);
    conversationState.listTimer = null;
  }
  if (conversationState.outputTimer !== null) {
    clearInterval(conversationState.outputTimer);
    conversationState.outputTimer = null;
  }
}

function urlBase64ToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function setPushStatus(message, kind) {
  const line = $("push-status-line");
  line.textContent = message;
  line.className = `hint ${kind || ""}`;
}

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function refreshPushStatus() {
  if (!pushSupported()) {
    setPushStatus(
      "This browser has no push support. On iOS, add the app to the Home Screen first.",
      "bad",
    );
    return;
  }
  try {
    const subscription = await currentPushSubscription();
    if (subscription) {
      setPushStatus("Notifications are enabled on this device.", "ok");
    } else if (Notification.permission === "denied") {
      setPushStatus("Notifications are blocked for this app in browser settings.", "bad");
    } else {
      setPushStatus("Notifications are not enabled on this device.", "");
    }
  } catch (error) {
    setPushStatus(`Could not read push state: ${error.message}`, "bad");
  }
}

async function enablePush() {
  if (!state.token) {
    setPushStatus("Save your bearer token first.", "bad");
    return;
  }
  if (!pushSupported()) {
    setPushStatus("Push is not supported here. On iOS, add the app to the Home Screen first.", "bad");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Notification permission was not granted.", "bad");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const config = await api("/api/push/config");
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
    const json = subscription.toJSON();
    await api("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
    setPushStatus("Notifications are enabled on this device.", "ok");
  } catch (error) {
    setPushStatus(`Could not enable notifications: ${error.message}`, "bad");
  }
}

async function disablePush() {
  try {
    const subscription = await currentPushSubscription();
    if (!subscription) {
      setPushStatus("Notifications are not enabled on this device.", "");
      return;
    }
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    if (state.token) {
      try {
        await api("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      } catch {
        // The local unsubscribe is what matters; the server drops it on the next send.
      }
    }
    setPushStatus("Notifications are disabled on this device.", "");
  } catch (error) {
    setPushStatus(`Could not disable notifications: ${error.message}`, "bad");
  }
}

async function sendPushTest() {
  if (!state.token) {
    setPushStatus("Save your bearer token first.", "bad");
    return;
  }
  try {
    const result = await api("/api/push/test", { method: "POST" });
    setPushStatus(`Test sent to ${result.sent} device(s).`, "ok");
  } catch (error) {
    setPushStatus(`Could not send a test: ${error.message}`, "bad");
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    setBanner(`firstmate reachable — can receive: ${payload.can_receive ? "yes" : "no"}`, "ok");
  } catch (error) {
    setBanner(`firstmate not reachable: ${error.message}`, "bad");
  }
}

function showView(name) {
  state.view = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  }
  if (name === "status") void loadStatus();
  if (name === "settings") void refreshPushStatus();
  if (name === "conversations") {
    void loadSessions();
    void loadThreads();
    void refreshConversation();
    startConversationsPolling();
  } else {
    stopConversationsPolling();
  }
}

const VIEWS = ["status", "conversations", "settings"];
const TOKEN_SAVE_DELAY_MS = 300;
let tokenSaveTimer = null;

function setSettingsStatus(message, kind) {
  const status = $("settings-status");
  const suffix = tokenSuffix(state.token);
  status.textContent = suffix ? `${message} - ${suffix}` : message;
  status.className = `hint ${kind || ""}`;
}

function persistToken(value) {
  state.token = writeToken(localStorage, value);
  return state.token;
}

function scheduleTokenPersist() {
  if (tokenSaveTimer !== null) clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(() => {
    tokenSaveTimer = null;
    persistToken($("token-input").value);
  }, TOKEN_SAVE_DELAY_MS);
}

async function verifyToken() {
  const token = state.token;
  setSettingsStatus("Checking…", "");
  try {
    await api("/api/status");
    if (state.token !== token) return;
    setSettingsStatus("Token accepted", "ok");
  } catch (error) {
    if (state.token !== token) return;
    if (error && error.status === 401) setSettingsStatus("Token rejected", "bad");
    else setSettingsStatus(`Could not verify token: ${error.message}`, "bad");
  }
}

function saveToken() {
  if (tokenSaveTimer !== null) {
    clearTimeout(tokenSaveTimer);
    tokenSaveTimer = null;
  }
  persistToken($("token-input").value);
  return verifyToken();
}

function init() {
  $("fact-origin").textContent = window.location.origin;
  $("token-input").value = state.token;

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  $("refresh").addEventListener("click", () => {
    void loadStatus();
    void loadHealth();
    if (state.view === "conversations") {
      void loadSessions();
      void loadThreads();
      void refreshConversation();
    }
  });
  $("conversations-refresh").addEventListener("click", () => {
    void loadSessions();
    void loadThreads();
    void refreshConversation();
  });
  $("new-conversation").addEventListener("click", () => {
    $("conversation-composer").hidden = false;
    $("note-text").focus?.();
  });
  $("compose-cancel").addEventListener("click", () => {
    $("conversation-composer").hidden = true;
    $("compose-status").textContent = "";
  });
  $("conversation-back").addEventListener("click", closeConversation);
  $("note-form").addEventListener("submit", submitNote);
  $("note-text").addEventListener("input", () => {
    state.pendingRequestId = null;
    state.pendingRequestText = null;
  });
  initVoice();
  const tokenInput = $("token-input");
  tokenInput.addEventListener("input", scheduleTokenPersist);
  tokenInput.addEventListener("change", () => persistToken(tokenInput.value));
  tokenInput.addEventListener("blur", () => void saveToken());
  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveToken();
  });
  $("clear-token").addEventListener("click", () => {
    if (tokenSaveTimer !== null) {
      clearTimeout(tokenSaveTimer);
      tokenSaveTimer = null;
    }
    forgetToken(localStorage);
    state.token = "";
    tokenInput.value = "";
    setSettingsStatus("Token cleared.", "");
  });
  $("push-enable").addEventListener("click", () => void enablePush());
  $("push-disable").addEventListener("click", () => void disablePush());
  $("push-test").addEventListener("click", () => void sendPushTest());

  const requested = new URLSearchParams(window.location.search).get("view");
  if (requested && VIEWS.includes(requested)) {
    showView(requested);
  } else if (!state.token) {
    showView("settings");
  } else {
    showView("status");
  }
  void loadHealth();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

init();
