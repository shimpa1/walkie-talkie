import { createVoiceInput, speechRecognitionCtor, voiceMode } from "./voice.js";

const TOKEN_KEY = "reach.token";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  pendingRequestId: null,
  pendingRequestText: null,
  status: null,
};

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

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (state.token) headers["authorization"] = `Bearer ${state.token}`;
  return headers;
}

async function api(path, options) {
  const init = Object.assign({}, options || {});
  init.headers = authHeaders(init.headers);
  const response = await fetch(path, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

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
    setBanner(`Could not load fleet status: ${error.message}`, "bad");
  }
}

function receiptLine(receipt) {
  const note = receipt || {};
  const id = note.note_id || "(unknown)";
  const outcome = note.outcome || "queued";
  const announced = note.announced === false ? "wake pending" : "wake queued";
  return `Queued ${id} (${outcome}); ${announced}.`;
}

function showReceipt(receipt) {
  const box = $("receipt-card");
  box.hidden = false;
  box.textContent = "";
  box.appendChild(el("strong", null, "Instruction queued"));
  box.appendChild(el("p", null, receiptLine(receipt)));
  if (receipt && receipt.request_id) {
    const line = el("p");
    line.appendChild(document.createTextNode("Request id: "));
    line.appendChild(el("code", null, receipt.request_id));
    box.appendChild(line);
  }
}

async function submitNote(event) {
  event.preventDefault();
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
    showReceipt(receipt);
    status.textContent = "";
    state.pendingRequestId = null;
    state.pendingRequestText = null;
    $("note-text").value = "";
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
  const toggle = voiceMode() === "toggle";
  const idleLabel = toggle ? "Tap to talk" : "Hold to talk";
  const listeningHint = toggle ? "Listening… tap again to stop." : "Listening… release to stop.";
  button.textContent = idleLabel;

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
      button.textContent = listening ? (toggle ? "Tap to stop" : "Listening…") : idleLabel;
      if (listening) status.textContent = listeningHint;
      else if (message) status.textContent = message;
      else status.textContent = "";
    },
  });

  if (toggle) {
    button.addEventListener("click", () => {
      if (voice.isListening()) voice.stop();
      else voice.start();
    });
    return;
  }

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

async function loadReceipts() {
  const body = $("receipts-body");
  body.textContent = "";
  try {
    const payload = await api("/api/receipts");
    const groups = [
      ["Pending", payload.pending],
      ["Handled", payload.handled],
      ["Replies", payload.replies],
    ];
    for (const [title, items] of groups) {
      const list = el("div", "cards");
      const records = Array.isArray(items) ? items : [];
      if (records.length === 0) list.appendChild(el("div", "card empty", `No ${title.toLowerCase()} receipts.`));
      for (const item of records) {
        const label = item.note_id || item.id || item.request_id || "receipt";
        const sub = item.reply || item.body || item.text || item.cursor || "";
        list.appendChild(card(label, sub, [[title.toLowerCase(), title === "Replies" ? "ok" : ""]]));
      }
      body.appendChild(section(title, list));
    }
  } catch (error) {
    body.appendChild(el("div", "card empty", `Could not load receipts: ${error.message}`));
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
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  }
  if (name === "status") void loadStatus();
  if (name === "receipts") void loadReceipts();
  if (name === "settings") void refreshPushStatus();
}

const VIEWS = ["status", "compose", "receipts", "settings"];

function init() {
  $("fact-origin").textContent = window.location.origin;
  $("token-input").value = state.token;

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  $("refresh").addEventListener("click", () => {
    void loadStatus();
    void loadHealth();
  });
  $("note-form").addEventListener("submit", submitNote);
  $("note-text").addEventListener("input", () => {
    state.pendingRequestId = null;
    state.pendingRequestText = null;
  });
  initVoice();
  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = $("token-input").value.trim();
    localStorage.setItem(TOKEN_KEY, state.token);
    $("settings-status").textContent = "Saved.";
    void loadStatus();
  });
  $("clear-token").addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(TOKEN_KEY);
    $("token-input").value = "";
    $("settings-status").textContent = "Token cleared.";
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
