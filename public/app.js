import { createVoiceInput, speechRecognitionCtor } from "./voice.js";
import {
  authHeaders,
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
  pendingRequestKey: null,
  status: null,
  /** Firstmate's own live state from /api/firstmate; Status and Conversations share it. */
  firstmate: null,
  /** The last /api/firstmate read failed, so the card shows unknown, not loading. */
  firstmateFailed: false,
  statusTimer: null,
  voice: null,
  view: null,
  /**
   * Null when this is a standalone service guarded by the shared token. Behind
   * the multi-user gateway: { confirmed, signedIn, user, legacyBearer } from
   * /auth/session; confirmed is false when the last known mode stands in for an
   * answer the probe did not get.
   */
  gateway: null,
};

const conversationState = {
  sessions: [],
  threads: [],
  selectedId: null,
  selectedThreadId: null,
  composingNew: false,
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
const STATUS_INTERVAL_MS = 10000;
const CONVERSATION_OUTPUT_INTERVAL_MS = 3000;
const CONVERSATION_OUTPUT_LINES = 400;
const CONVERSATION_HISTORY_LIMIT = 200;

const $ = (id) => document.getElementById(id);

/**
 * The connection banner is shared by the health check and the status read, so
 * each owner only ever clears its own message: a successful status read must
 * not erase the health line that answered first. The status read only writes
 * the banner on failure, and that error outranks the health line.
 */
function setBanner(message, kind, owner) {
  const banner = $("connection-banner");
  if (owner && banner.dataset.owner === "status" && owner !== "status") return;
  if (!message) {
    if (owner && banner.dataset.owner !== owner) return;
    banner.hidden = true;
    banner.textContent = "";
    banner.dataset.owner = "";
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind || ""}`;
  banner.textContent = message;
  banner.dataset.owner = owner || "";
}

/** Messages for the `?signin=` outcome the gateway redirects back with. */
const SIGNIN_MESSAGES = {
  failed: "Sign-in with GitHub failed. Try again.",
  expired: "That sign-in expired or was started in another window. Try again.",
  denied: "GitHub sign-in was cancelled.",
  not_invited: "This GitHub account is not invited. Ask the admin to invite you.",
  pending: "Your request is waiting for the admin's approval. Sign in again once you hear back.",
  suspended: "This account is suspended. Ask the admin.",
  busy: "Too many sign-in attempts right now. Wait a minute and try again.",
  signed_out: "You are signed out.",
};

const MODE_KEY = "walkie-talkie.mode";

function rememberMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // A storage that refuses writes just re-probes next launch.
  }
}

function rememberedMode() {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

/**
 * Ask the service which mode it runs in. A standalone service has no
 * /auth/session, so only a 404 means standalone. When the probe gets no usable
 * answer (unreachable, a 5xx during a rollout, an unreadable body), the last
 * answer stands, so a launch behind the gateway does not fall back to the
 * token form.
 */
async function probeMode() {
  const unknown = () =>
    rememberedMode() === "gateway" ? { confirmed: false, signedIn: true, user: null, legacyBearer: false } : null;
  let response;
  try {
    response = await fetch("/auth/session", { headers: { accept: "application/json" } });
  } catch {
    return unknown();
  }
  if (response.status === 404) {
    rememberMode("standalone");
    return null;
  }
  if (!response.ok) return unknown();
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!payload || payload.mode !== "gateway") return unknown();
  rememberMode("gateway");
  return {
    confirmed: true,
    signedIn: payload.signed_in === true,
    user: payload.user && typeof payload.user === "object" ? payload.user : null,
    legacyBearer: payload.legacy_bearer === true,
  };
}

/** Whether API calls can be authorized: a token, or a gateway session. */
function authReady() {
  if (!state.gateway) return Boolean(state.token);
  return state.gateway.signedIn || (state.gateway.legacyBearer && Boolean(state.token));
}

function showSignIn(outcome) {
  $("signin-status").textContent = (outcome && SIGNIN_MESSAGES[outcome]) || "";
  // Nothing about the previous user stays on screen, on a shared device too.
  $("home-label").textContent = "firstmate companion";
  $("admin-tab").hidden = true;
  $("setup-tab").hidden = true;
  showView("signin");
}

function renderAccount() {
  if (!state.gateway) return;
  $("settings-form").hidden = true;
  $("token-hint").hidden = true;
  $("account-panel").hidden = false;
  const user = state.gateway.user;
  $("admin-tab").hidden = !(state.gateway.signedIn && user && user.admin === true);
  $("setup-tab").hidden = !setupOffered();
  $("devices-panel").hidden = !state.gateway.signedIn;
  if (state.gateway.signedIn) {
    $("account-line").textContent = user && user.login ? `Signed in with GitHub as @${user.login}.` : "Signed in with GitHub.";
    $("account-signin").hidden = true;
    $("sign-out").hidden = false;
  } else {
    $("account-line").textContent =
      "This device still uses the shared token, which is being retired. Sign in with GitHub to keep access.";
    $("account-signin").hidden = false;
    $("sign-out").hidden = true;
  }
}

async function signOut() {
  try {
    await fetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  } catch {
    // Signing out locally still matters; the server session expires on its own.
  }
  forgetToken(localStorage);
  state.token = "";
  if (state.gateway) {
    state.gateway.signedIn = false;
    state.gateway.user = null;
  }
  showSignIn("signed_out");
}

/** A JSON write to the gateway's own routes; same-origin, so the cookie rides along. */
function jsonInit(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
}

/** A small button for a card's action row; `confirmLabel` asks for a second tap first. */
function actionButton(label, action, id, onClick, confirmLabel) {
  const button = el("button", "ghost small", label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = String(id);
  button.addEventListener("click", () => {
    if (confirmLabel && button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = confirmLabel;
      return;
    }
    button.disabled = true;
    void onClick();
  });
  return button;
}

function withActions(node, buttons) {
  const row = el("div", "actions");
  for (const button of buttons) row.appendChild(button);
  node.appendChild(row);
  return node;
}

function setAdminStatus(message, kind) {
  const status = $("admin-status");
  status.textContent = message;
  status.className = `hint ${kind || ""}`;
}

/** Run an admin action, then reload the admin view so it shows the result. */
async function adminAction(path, init, done) {
  try {
    await api(path, init);
    setAdminStatus(done, "ok");
  } catch (error) {
    setAdminStatus(error.message, "bad");
  }
  await loadAdmin();
}

function renderRequests(requests) {
  const body = $("requests-body");
  body.textContent = "";
  if (!requests.length) {
    body.appendChild(el("p", "hint", "No one is waiting."));
    return;
  }
  for (const request of requests) {
    const node = card(`@${request.login}`, `asked ${formatTimestamp(request.requested_at)}`);
    body.appendChild(
      withActions(node, [
        actionButton("Approve", "approve", request.github_id, () =>
          adminAction(`/api/admin/requests/${request.github_id}/approve`, jsonInit("POST"), `Approved @${request.login}.`),
        ),
        actionButton("Deny", "deny", request.github_id, () =>
          adminAction(`/api/admin/requests/${request.github_id}/deny`, jsonInit("POST"), `Denied @${request.login}.`),
        ),
      ]),
    );
  }
}

function renderInvites(invites) {
  const body = $("invites-body");
  body.textContent = "";
  if (!invites.length) {
    body.appendChild(el("p", "hint", "No open invites."));
    return;
  }
  for (const invite of invites) {
    const node = card(`@${invite.login}`, `open until ${formatTimestamp(invite.expires_at)}`);
    body.appendChild(
      withActions(node, [
        actionButton("Revoke", "revoke", invite.id, () =>
          adminAction(`/api/admin/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" }, `Revoked the invite for @${invite.login}.`),
        ),
      ]),
    );
  }
}

function renderUsers(users) {
  const body = $("users-body");
  body.textContent = "";
  for (const user of users) {
    const badges = [];
    if (user.admin) badges.push(["admin", "ok"]);
    if (user.state === "suspended") badges.push(["suspended", "bad"]);
    const firstmate = user.firstmate === "ready" ? "has a firstmate" : "no firstmate yet";
    const node = card(`@${user.login}`, `${firstmate} · ${user.sessions} device(s)`, badges);
    if (user.declared) {
      node.appendChild(el("div", "sub", "Declared in the configuration."));
      body.appendChild(node);
      continue;
    }
    const id = encodeURIComponent(user.id);
    const buttons = [
      user.state === "suspended"
        ? actionButton("Resume", "resume", user.id, () =>
            adminAction(`/api/admin/users/${id}/resume`, jsonInit("POST"), `Resumed @${user.login}.`),
          )
        : actionButton("Suspend", "suspend", user.id, () =>
            adminAction(`/api/admin/users/${id}/suspend`, jsonInit("POST"), `Suspended @${user.login}.`),
          ),
      actionButton(
        "Remove",
        "remove",
        user.id,
        () => adminAction(`/api/admin/users/${id}`, { method: "DELETE" }, `Removed @${user.login}.`),
        "Tap again to remove",
      ),
    ];
    body.appendChild(withActions(node, buttons));
  }
}

async function loadAdmin() {
  try {
    const [requests, invites, users] = await Promise.all([
      api("/api/admin/requests"),
      api("/api/admin/invites"),
      api("/api/admin/users"),
    ]);
    renderRequests(requests.requests || []);
    renderInvites(invites.invites || []);
    renderUsers(users.users || []);
  } catch (error) {
    setAdminStatus(`Could not load: ${error.message}`, "bad");
  }
}

async function submitInvite(event) {
  event.preventDefault();
  const input = $("invite-login");
  const login = input.value.trim().replace(/^@/, "");
  if (!login) {
    setAdminStatus("Enter a GitHub login.", "bad");
    return;
  }
  try {
    const result = await api("/api/admin/invites", jsonInit("POST", { login }));
    input.value = "";
    setAdminStatus(`Invited @${result.invite.login}: they can sign in with GitHub until ${formatTimestamp(result.invite.expires_at)}.`, "ok");
  } catch (error) {
    setAdminStatus(error.message, "bad");
  }
  await loadAdmin();
}

// ---- setup: provider, key and model for the user's own firstmate ----------

/** What the Setup view last read: the catalog, the user's key metadata and choice. */
const setupState = { catalog: null, credentials: [], firstmate: null };

/** Whether this signed-in user sets up their own firstmate (not a declared one). */
function setupOffered() {
  const user = state.gateway && state.gateway.user;
  return Boolean(state.gateway && state.gateway.signedIn && user && user.setup === true);
}

/** A signed-in user whose firstmate is not set up yet starts on the Setup view. */
function needsSetup() {
  return setupOffered() && state.gateway.user.firstmate !== "ready";
}

function setSetupStatus(message, kind) {
  const status = $("setup-status");
  status.textContent = message;
  status.className = `hint ${kind || ""}`;
}

/** Replace a select's options with `entries` ([value, label]); keep `selected` when offered. */
function fillSelect(select, entries, selected, emptyLabel) {
  select.textContent = "";
  const values = [];
  if (emptyLabel !== undefined) {
    const option = el("option", "", emptyLabel);
    option.value = "";
    select.appendChild(option);
    values.push("");
  }
  for (const [value, label] of entries) {
    const option = el("option", "", label);
    option.value = value;
    select.appendChild(option);
    values.push(value);
  }
  select.value = values.includes(selected) ? selected : values[0] || "";
}

function setupProvider() {
  const catalog = setupState.catalog;
  if (!catalog) return null;
  return catalog.providers.find((provider) => provider.id === $("setup-provider").value) || null;
}

function savedCredential(name) {
  return setupState.credentials.find((credential) => credential.name === name) || null;
}

function renderSetupProvider() {
  const provider = setupProvider();
  if (!provider) return;
  const key = savedCredential(provider.key_name);
  $("setup-key-line").textContent = key
    ? `Your ${provider.name} key is saved (checked ${formatTimestamp(key.validated_at)}). Save a new one to replace it.`
    : `Add your ${provider.name} API key. It is checked with ${provider.name} before it is saved.`;
  $("setup-key-remove").hidden = !key;
  const choice = setupState.firstmate && setupState.firstmate.choice;
  const mine = choice && choice.provider === provider.id ? choice : null;
  const models = provider.models.map((model) => [model, model]);
  fillSelect($("setup-model"), models, mine ? mine.model : provider.models[0]);
  fillSelect($("setup-routine"), models, mine && mine.routine_model ? mine.routine_model : "", "None");
}

function renderSetupSummary() {
  const view = setupState.firstmate;
  const line = $("setup-summary");
  if (!view || !view.setup) {
    line.textContent = "";
    return;
  }
  const choice = view.choice;
  if (view.setup.ready && choice) {
    line.textContent = `Ready: your firstmate will run ${choice.harness} on ${choice.provider}/${choice.model}. It starts once the admin turns on per-user firstmates.`;
  } else if (choice && !view.setup.key_saved) {
    line.textContent = `You chose ${choice.provider}/${choice.model}; add that provider's key to finish.`;
  } else {
    line.textContent = "Pick a provider, save its key, then choose a model.";
  }
}

function renderSetup() {
  const catalog = setupState.catalog;
  if (!catalog) return;
  const choice = setupState.firstmate && setupState.firstmate.choice;
  const current = $("setup-provider").value || (choice ? choice.provider : "");
  fillSelect(
    $("setup-provider"),
    catalog.providers.map((provider) => [provider.id, provider.name]),
    current,
  );
  renderSetupProvider();
  const github = catalog.github;
  $("setup-github-form").hidden = !github;
  if (github) $("setup-github-remove").hidden = !savedCredential(github.key_name);
  renderSetupSummary();
}

async function loadSetup() {
  if (!setupOffered()) return;
  try {
    const [catalog, credentials, firstmate] = await Promise.all([
      api("/api/catalog"),
      api("/api/me/credentials"),
      api("/api/me/firstmate"),
    ]);
    setupState.catalog = catalog.catalog;
    setupState.credentials = credentials.credentials || [];
    setupState.firstmate = firstmate;
    renderSetup();
  } catch (error) {
    setSetupStatus(`Could not load: ${error.message}`, "bad");
  }
}

/** Send a key for checking and storage. The field is cleared whatever happens. */
async function saveSetupKey(input, name, label) {
  const value = input.value.trim();
  input.value = "";
  if (!value) {
    setSetupStatus(`Paste your ${label} first.`, "bad");
    return;
  }
  setSetupStatus(`Checking your ${label}…`, "");
  try {
    await api(`/api/me/credentials/${encodeURIComponent(name)}`, jsonInit("PUT", { value }));
    setSetupStatus(`Saved: your ${label} works and is stored encrypted.`, "ok");
  } catch (error) {
    setSetupStatus(error.message, "bad");
  }
  await loadSetup();
}

async function removeSetupKey(name, label) {
  try {
    await api(`/api/me/credentials/${encodeURIComponent(name)}`, { method: "DELETE" });
    setSetupStatus(`Removed your ${label}.`, "ok");
  } catch (error) {
    setSetupStatus(error.message, "bad");
  }
  await loadSetup();
}

async function submitSetupKey(event) {
  event.preventDefault();
  const provider = setupProvider();
  if (!provider) return;
  await saveSetupKey($("setup-key"), provider.key_name, `${provider.name} key`);
}

async function submitSetupGithub(event) {
  event.preventDefault();
  const github = setupState.catalog && setupState.catalog.github;
  if (!github) return;
  await saveSetupKey($("setup-github"), github.key_name, "GitHub token");
}

async function submitSetupModel(event) {
  event.preventDefault();
  const provider = setupProvider();
  if (!provider) return;
  const body = { provider: provider.id, model: $("setup-model").value };
  const routine = $("setup-routine").value;
  if (routine) body.routine_model = routine;
  try {
    setupState.firstmate = await api("/api/me/firstmate", jsonInit("PUT", body));
    setSetupStatus(`Saved: ${provider.name} ${body.model}.`, "ok");
    renderSetupSummary();
  } catch (error) {
    setSetupStatus(error.message, "bad");
  }
}

function renderDevices(devices) {
  const body = $("devices-body");
  body.textContent = "";
  for (const device of devices) {
    const node = card(device.label, `last used ${formatTimestamp(device.last_seen_at)}`, device.current ? [["this device", "ok"]] : []);
    if (!device.current) {
      withActions(node, [
        actionButton("Sign out", "sign-out-device", device.id, async () => {
          try {
            await api(`/api/me/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
          } catch {
            // The list below shows whether it went.
          }
          await loadDevices();
        }),
      ]);
    }
    body.appendChild(node);
  }
}

async function loadDevices() {
  if (!state.gateway || !state.gateway.signedIn) return;
  try {
    const result = await api("/api/me/devices");
    renderDevices(result.devices || []);
  } catch {
    // A failed read leaves the list as it was.
  }
}

async function signOutOtherDevices() {
  try {
    await api("/api/me/devices", { method: "DELETE" });
  } catch {
    // The list below shows what is left.
  }
  await loadDevices();
}

async function showLinkCode() {
  const line = $("link-code");
  try {
    const response = await fetch("/auth/link/code", jsonInit("POST"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    line.textContent = `On the other device choose "Use link code" and enter ${result.code}. It works once, within 5 minutes.`;
  } catch (error) {
    line.textContent = `Could not make a link code: ${error.message}`;
  }
}

const LINK_ERRORS = {
  429: "Too many tries. Wait a minute and try again.",
  400: "That code is wrong or has expired. Make a new one on your signed-in device.",
};

async function redeemLinkCode(event) {
  event.preventDefault();
  const status = $("link-status");
  const code = $("link-input").value.trim();
  if (!code) {
    status.textContent = "Enter the code from your signed-in device.";
    return;
  }
  status.textContent = "Checking…";
  let response;
  try {
    response = await fetch("/auth/link/redeem", jsonInit("POST", { code }));
  } catch (error) {
    status.textContent = `Could not reach the service: ${error.message}`;
    return;
  }
  if (!response.ok) {
    status.textContent = LINK_ERRORS[response.status] || `Could not use the code (HTTP ${response.status}).`;
    return;
  }
  $("link-input").value = "";
  status.textContent = "";
  const probed = await probeMode();
  if (probed) state.gateway = probed;
  renderAccount();
  showView("status");
  void loadHealth();
}

function handleUnauthorized(_response, token) {
  if (state.gateway) {
    // Behind the gateway a 401 means neither a session nor the retiring shared
    // token was accepted: the token, if any, is no good any more.
    state.gateway.signedIn = false;
    if (token && token === state.token) {
      state.token = "";
      forgetToken(localStorage);
    }
    showSignIn("signed_out");
    return;
  }
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
    setBanner(null, "", "status");
  } catch (error) {
    if (error && error.status === 401) return;
    setBanner(`Could not load fleet status: ${error.message}`, "bad", "status");
  }
}

/** How long ago something happened, compactly: "40s", "4 min", "2 h 5 min". */
function formatAge(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function ageSince(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? formatAge((Date.now() - ms) / 1000) : "";
}

const FIRSTMATE_ACTIVITY = {
  busy: { label: "working", kind: "warn", phrase: "firstmate is working and has not picked it up yet" },
  idle: { label: "idle", kind: "ok", phrase: "firstmate is idle and has not picked it up yet" },
  blocked: { label: "blocked", kind: "bad", phrase: "firstmate is blocked waiting on a prompt" },
  not_running: { label: "not running", kind: "bad", phrase: "firstmate is not running" },
  unknown: { label: "unknown", kind: "", phrase: "firstmate's state is unknown" },
};

function firstmateActivity() {
  const live = state.firstmate;
  return (live && FIRSTMATE_ACTIVITY[live.activity]) || null;
}

/** The Status tab's firstmate card: is it up, busy, receiving, and what is queued. */
function renderFirstmate() {
  const box = $("firstmate-body");
  box.textContent = "";
  const live = state.firstmate;
  if (!live) {
    if (state.firstmateFailed) {
      box.appendChild(card("firstmate", "Could not read firstmate's state", [["unknown", ""]]));
    } else {
      box.appendChild(el("div", "card empty", "Reading firstmate's state…"));
    }
    return;
  }
  const activity = firstmateActivity() || { label: "unknown", kind: "" };
  const receiving =
    live.can_receive === true ? "Receiving notes" : live.can_receive === false ? "Not receiving notes" : "Receiving: unknown";
  let queued = "Queue unknown";
  if (live.queue) {
    const oldest = live.queue.oldest_queued_at ? ageSince(live.queue.oldest_queued_at) : "";
    queued =
      live.queue.queued === 0
        ? "Nothing queued"
        : `${live.queue.queued} queued${oldest ? `, oldest ${oldest}` : ""}`;
  }
  box.appendChild(card("firstmate", `${receiving} · ${queued}`, [[activity.label, activity.kind]]));
}

async function loadFirstmate() {
  try {
    state.firstmate = await api("/api/firstmate");
    state.firstmateFailed = false;
  } catch (error) {
    if (error && error.status === 401) return;
    // Unknown is shown as unknown; the thread list keeps what is on screen
    // until its own next poll rather than redrawing on a failed read.
    state.firstmate = null;
    state.firstmateFailed = true;
    renderFirstmate();
    return;
  }
  renderFirstmate();
  if (state.view === "conversations") {
    renderThreads();
    if (conversationState.selectedThreadId && selectedThread()) renderThread();
  }
}

function pageHidden() {
  return document.visibilityState === "hidden";
}

function startStatusPolling() {
  stopStatusPolling();
  if (pageHidden()) return;
  state.statusTimer = setInterval(() => {
    void loadStatus();
    void loadFirstmate();
    void loadHealth();
  }, STATUS_INTERVAL_MS);
}

function stopStatusPolling() {
  if (state.statusTimer !== null) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
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

/**
 * The context header the service writes as the first line of a note sent from
 * an open conversation (src/note-context.ts). Parsing it back lets a follow-up
 * join its thread and lets the thread show where a note was written from.
 */
const CONTEXT_HEADER =
  /^\[walkie-talkie\] (Follow-up in conversation|Sent while viewing live session) (\S+)(?: ("(?:[^"\\\n]|\\.)*"))?\n\n/;

const ESCAPED_CONTEXT_HEADER = "\\[walkie-talkie]";

/** Undo the service's escape of a captain message that itself looks like a header. */
function unescapeNoteText(text) {
  return text.startsWith(ESCAPED_CONTEXT_HEADER) ? text.slice(1) : text;
}

function splitNoteContext(body) {
  const text = String(body || "");
  const match = CONTEXT_HEADER.exec(text);
  if (!match) return { context: null, text: unescapeNoteText(text) };
  let label = "";
  if (match[3]) {
    try {
      label = String(JSON.parse(match[3]));
    } catch {
      label = "";
    }
  }
  const kind = match[1].startsWith("Follow-up") ? "thread" : "session";
  return { context: { kind, id: match[2], label }, text: unescapeNoteText(text.slice(match[0].length)) };
}

function noteTime(note) {
  const value = (note.reply && note.reply.at) || note.at;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function sentTime(note) {
  const ms = typeof note.at === "number" ? note.at : Date.parse(note.at);
  return Number.isFinite(ms) ? ms : noteTime(note);
}

/** The thread a follow-up belongs to: the first note up its chain of thread contexts. */
function rootNoteId(note, notes) {
  let current = note;
  const seen = new Set();
  while (current.context && current.context.kind === "thread" && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = notes.get(current.context.id);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

/**
 * Build the instruction threads from firstmate's receipts payload. A thread is
 * one note plus every follow-up sent from it, in the order they were sent.
 */
function buildThreads(payload) {
  const notes = new Map();
  const add = (note, handled) => {
    const id = note.note_id || note.id || note.request_id;
    if (!id) return;
    const parsed = splitNoteContext(note.body || note.text || "");
    notes.set(id, {
      id,
      body: parsed.text,
      context: parsed.context,
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
    const note = notes.get(id);
    if (note) {
      if (!note.reply) note.reply = reply;
      continue;
    }
    notes.set(id, {
      id,
      body: "",
      context: null,
      at: reply.at || null,
      requestId: reply.request_id || null,
      acknowledged: true,
      announced: reply.announced,
      reply,
    });
  }
  const byRoot = new Map();
  for (const note of notes.values()) {
    const rootId = rootNoteId(note, notes);
    const thread = byRoot.get(rootId) || { id: rootId, notes: [] };
    thread.notes.push(note);
    byRoot.set(rootId, thread);
  }
  const threads = [...byRoot.values()];
  for (const thread of threads) {
    thread.notes.sort((a, b) => sentTime(a) - sentTime(b) || (a.id === thread.id ? -1 : b.id === thread.id ? 1 : 0));
  }
  threads.sort((a, b) => threadTime(b) - threadTime(a));
  return threads;
}

function rootNote(thread) {
  return thread.notes.find((note) => note.id === thread.id) || thread.notes[0];
}

function latestNote(thread) {
  return thread.notes[thread.notes.length - 1];
}

/** The instruction text for a thread, or the reply's text when only a reply exists. */
function threadText(thread) {
  const root = rootNote(thread);
  if (root.body) return root.body;
  return root.reply && root.reply.body ? root.reply.body : "";
}

function threadTime(thread) {
  return Math.max(0, ...thread.notes.map(noteTime));
}

function threadState(thread) {
  const note = latestNote(thread);
  if (note.reply) return { label: "replied", kind: "ok" };
  if (note.acknowledged) return { label: "working", kind: "warn" };
  const age = note.at ? ageSince(note.at) : "";
  return { label: age ? `queued ${age}` : "queued", kind: "" };
}

/**
 * A queued note says how long it has waited and what firstmate is doing, from
 * the same live state as the Status tab, so a slow pickup reads differently
 * from a stuck one.
 */
function deliveryLine(thread) {
  const note = latestNote(thread);
  if (note.reply) return "Delivered; firstmate replied.";
  if (note.acknowledged) return "Delivered; firstmate is working on it.";
  const age = note.at ? ageSince(note.at) : "";
  const queued = age ? `Queued ${age}` : "Queued";
  if (note.announced === false) return `${queued}; firstmate has not been woken yet.`;
  const activity = firstmateActivity();
  if (activity) return `${queued}; ${activity.phrase}.`;
  return `${queued}; waiting for firstmate.`;
}

/** Where a thread's first note was written from, when it was not a new conversation. */
function contextLine(context) {
  if (!context) return "";
  const label = context.label ? ` (${context.label})` : "";
  if (context.kind === "session") return `About live session ${context.id}${label}`;
  return `Follow-up to conversation ${context.id}${label}`;
}

function threadIdForNote(noteId) {
  const thread = conversationState.threads.find((item) => item.notes.some((note) => note.id === noteId));
  return thread ? thread.id : null;
}

function selectedThread() {
  return conversationState.threads.find((thread) => thread.id === conversationState.selectedThreadId) || null;
}

/** The conversation a message from the open composer is about, or null for a new one. */
function composerContext() {
  if (conversationState.selectedThreadId) {
    const thread = selectedThread();
    return {
      kind: "thread",
      id: conversationState.selectedThreadId,
      label: thread ? summarize(threadText(thread)) : "",
    };
  }
  if (conversationState.selectedId) {
    const session = selectedSession();
    const label = session ? [session.name || session.id, session.title].filter(Boolean).join(": ") : "";
    return { kind: "session", id: conversationState.selectedId, label };
  }
  return null;
}

function composerMode() {
  if (conversationState.selectedThreadId) return "thread";
  if (conversationState.selectedId) return "session";
  return "new";
}

const COMPOSER_MODES = {
  new: {
    placeholder: "What should the fleet know or do next?",
    hint: "Starts a new conversation: this queues a note into firstmate's existing intake. It makes no decision and changes no project.",
  },
  thread: {
    placeholder: "Reply to firstmate in this conversation…",
    hint: "Queues a follow-up note to firstmate, marked as part of this conversation.",
  },
  session: {
    placeholder: "Tell firstmate about this session…",
    hint: "Goes to firstmate, not into this session; the note names this session so firstmate knows what you mean.",
  },
};

function setComposerMode() {
  const mode = COMPOSER_MODES[composerMode()];
  $("note-text").placeholder = mode.placeholder;
  $("compose-hint").textContent = mode.hint;
  $("compose-status").textContent = "";
}

async function submitNote(event) {
  event.preventDefault();
  if (state.voice) state.voice.stop();
  const text = $("note-text").value.trim();
  if (!text) return;
  const context = composerContext();
  const mode = composerMode();
  const key = JSON.stringify([context ? context.kind : "", context ? context.id : "", text]);
  if (!state.pendingRequestId || state.pendingRequestKey !== key) {
    state.pendingRequestId = mintRequestId();
    state.pendingRequestKey = key;
  }
  const payload = { text, requestId: state.pendingRequestId };
  if (context) payload.context = context;
  const button = $("send");
  const status = $("compose-status");
  button.disabled = true;
  status.textContent = "Queueing…";
  try {
    const receipt = await api("/api/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.pendingRequestId = null;
    state.pendingRequestKey = null;
    $("note-text").value = "";
    status.textContent = mode === "session" ? "Sent to firstmate. Its reply appears under Conversations." : "";
    await loadThreads();
    const noteId = receipt && (receipt.note_id || receipt.id);
    const threadId = noteId ? threadIdForNote(noteId) : null;
    if (mode !== "session" && threadId && composerMode() === mode) selectThread(threadId);
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
    const about = contextLine(rootNote(thread).context);
    const count = thread.notes.length > 1 ? `${thread.notes.length} messages` : "";
    const meta = [count, about].filter(Boolean).join(" · ");
    if (meta) card.appendChild(el("div", "session-card-meta", meta));
    card.addEventListener("click", () => selectThread(thread.id));
    body.appendChild(card);
  }
}

async function loadThreads() {
  try {
    const payload = await api("/api/receipts");
    applyThreads(payload);
    if (conversationState.selectedThreadId && !selectedThread()) {
      // A note can move under its parent once the parent shows up in receipts.
      const owner = threadIdForNote(conversationState.selectedThreadId);
      if (owner) {
        conversationState.selectedThreadId = owner;
        renderThreads();
      }
    }
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
  if (conversationState.composingNew) {
    $("conversation-name").textContent = "New conversation";
    $("conversation-sub").textContent = "Firstmate replies in a new thread.";
    status.textContent = "new";
    status.className = "badge";
    return;
  }
  if (conversationState.selectedThreadId) {
    const thread = selectedThread();
    $("conversation-name").textContent = thread ? summarize(threadText(thread)) : "—";
    const root = thread ? rootNote(thread) : null;
    $("conversation-sub").textContent = root && root.requestId ? `request ${root.requestId}` : "";
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

/** Show the detail pane with its composer, matched to what is now open. */
function openDetail() {
  if (state.voice) state.voice.stop();
  $("conversation-detail").hidden = false;
  $("conversations-pane").classList.add("is-detail");
  setConversationHeader();
  setComposerMode();
  renderThreads();
  renderSessions({ sessions: conversationState.sessions });
}

function openNewConversation() {
  conversationState.selectedId = null;
  conversationState.selectedThreadId = null;
  conversationState.composingNew = true;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  openDetail();
  showConversationMessage("Write the first message below. Firstmate's reply appears here.");
  $("note-text").focus?.();
}

function selectSession(id) {
  conversationState.composingNew = false;
  conversationState.selectedThreadId = null;
  conversationState.selectedId = id;
  conversationState.forceScroll = true;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  openDetail();
  showConversationMessage("Loading…");
  void refreshConversation();
}

function selectThread(id) {
  conversationState.composingNew = false;
  conversationState.selectedId = null;
  conversationState.selectedThreadId = id;
  conversationState.forceScroll = true;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  openDetail();
  renderThread();
}

function closeConversation() {
  if (state.voice) state.voice.stop();
  conversationState.composingNew = false;
  conversationState.selectedId = null;
  conversationState.selectedThreadId = null;
  conversationState.source = null;
  conversationState.agentSession = null;
  conversationState.messages = [];
  conversationState.oldestCursor = null;
  conversationState.hasOlder = false;
  $("conversation-detail").hidden = true;
  $("conversations-pane").classList.remove("is-detail");
  setComposerMode();
  renderThreads();
  renderSessions({ sessions: conversationState.sessions });
}

function renderThread() {
  const box = conversationOutput();
  const nearBottom = conversationNearBottom(box);
  const previousScrollTop = box.scrollTop;
  box.textContent = "";
  const thread = selectedThread();
  if (!thread) {
    box.appendChild(el("p", "hint", "This conversation is no longer available."));
    return;
  }
  const about = contextLine(rootNote(thread).context);
  if (about) box.appendChild(el("p", "hint thread-context", about));
  const messages = [];
  for (const note of thread.notes) {
    if (note.body) messages.push({ role: "user", label: "you", time: note.at, text: note.body });
    if (note.reply) {
      messages.push({ role: "assistant", label: "firstmate", time: note.reply.at, text: note.reply.body });
    }
  }
  for (const node of messageCards(messages)) box.appendChild(node);
  box.appendChild(el("p", "hint thread-delivery", deliveryLine(thread)));
  if (nearBottom || conversationState.forceScroll) {
    box.scrollTop = box.scrollHeight;
    conversationState.forceScroll = false;
  } else {
    box.scrollTop = previousScrollTop;
  }
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
  if (pageHidden()) return;
  conversationState.listTimer = setInterval(() => {
    void loadSessions();
    void loadThreads();
    void loadFirstmate();
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

function signInFirstMessage() {
  return state.gateway ? "Sign in first." : "Save your bearer token first.";
}

async function enablePush() {
  if (!authReady()) {
    setPushStatus(signInFirstMessage(), "bad");
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
    if (authReady()) {
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
  if (!authReady()) {
    setPushStatus(signInFirstMessage(), "bad");
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
  // Behind the gateway health is per user, so it needs the session (or the
  // retiring token); standalone health is open and ignores the header.
  if (state.gateway && !authReady()) return;
  try {
    const response = await fetch("/api/health", { headers: authHeaders(state.token) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const ready = payload && typeof payload === "object" ? payload : null;
    const canReceive = ready && ready.can_receive === true ? "yes" : ready && ready.can_receive === false ? "no" : "unknown";
    setBanner(`firstmate reachable — can receive: ${canReceive}`, canReceive === "yes" ? "ok" : "warn", "health");
  } catch (error) {
    setBanner(`firstmate not reachable: ${error.message}`, "bad", "health");
  }
}

function showView(name) {
  state.view = name;
  $("tabs").hidden = name === "signin";
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  }
  if (name === "status") {
    void loadStatus();
    void loadFirstmate();
    startStatusPolling();
  } else {
    stopStatusPolling();
  }
  if (name === "settings") {
    renderAccount();
    void loadDevices();
    void refreshPushStatus();
  }
  if (name === "admin") void loadAdmin();
  if (name === "setup") void loadSetup();
  if (name === "conversations") {
    void loadSessions();
    void loadThreads();
    void loadFirstmate();
    void refreshConversation();
    startConversationsPolling();
  } else {
    stopConversationsPolling();
  }
}

/**
 * A Home Screen app is suspended in the background and resumed rather than
 * relaunched, so nothing polls while the page is hidden and the open view reads
 * fresh state the moment it is shown again instead of waiting for a tick.
 */
function handleVisibility() {
  if (pageHidden()) {
    stopStatusPolling();
    stopConversationsPolling();
    return;
  }
  if (state.view && state.view !== "signin") showView(state.view);
  void loadHealth();
  checkForShellUpdate();
}

/** A resumed page never re-checks its service worker, so ask for a newer shell. */
function checkForShellUpdate() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration && registration.update())
    .catch(() => {});
}

/** A typed or dictated note, or one still sending, that a reload would drop. */
function hasUnsentWork() {
  if ($("note-text").value.trim()) return true;
  if ($("send").disabled) return true;
  return Boolean(state.voice && state.voice.isListening());
}

const VIEWS = ["status", "conversations", "setup", "settings", "admin"];
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

/** Drop the one-shot `?signin=` outcome from the address bar once it is shown. */
function clearSignInParam(params) {
  if (!params.has("signin")) return;
  params.delete("signin");
  try {
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname || "/"}${query ? `?${query}` : ""}`);
  } catch {
    // Without history the outcome simply stays in the URL.
  }
}

async function init() {
  $("fact-origin").textContent = window.location.origin;
  $("token-input").value = state.token;

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  $("refresh").addEventListener("click", () => {
    void loadStatus();
    void loadHealth();
    void loadFirstmate();
    if (state.view === "conversations") {
      void loadSessions();
      void loadThreads();
      void refreshConversation();
    }
  });
  $("conversations-refresh").addEventListener("click", () => {
    void loadSessions();
    void loadThreads();
    void loadFirstmate();
    void refreshConversation();
  });
  $("new-conversation").addEventListener("click", openNewConversation);
  $("conversation-back").addEventListener("click", closeConversation);
  $("note-form").addEventListener("submit", submitNote);
  $("note-text").addEventListener("input", () => {
    state.pendingRequestId = null;
    state.pendingRequestKey = null;
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
  $("sign-out").addEventListener("click", () => void signOut());
  $("sign-out-others").addEventListener("click", () => void signOutOtherDevices());
  $("link-device").addEventListener("click", () => void showLinkCode());
  $("link-form").addEventListener("submit", (event) => void redeemLinkCode(event));
  $("invite-form").addEventListener("submit", (event) => void submitInvite(event));
  $("setup-provider").addEventListener("change", renderSetupProvider);
  $("setup-key-form").addEventListener("submit", (event) => void submitSetupKey(event));
  $("setup-model-form").addEventListener("submit", (event) => void submitSetupModel(event));
  $("setup-github-form").addEventListener("submit", (event) => void submitSetupGithub(event));
  $("setup-key-remove").addEventListener("click", () => {
    const provider = setupProvider();
    if (provider) void removeSetupKey(provider.key_name, `${provider.name} key`);
  });
  $("setup-github-remove").addEventListener("click", () => {
    const github = setupState.catalog && setupState.catalog.github;
    if (github) void removeSetupKey(github.key_name, "GitHub token");
  });

  const params = new URLSearchParams(window.location.search);
  const signin = params.get("signin");
  clearSignInParam(params);
  const requested = params.get("view");

  const showInitialView = () => {
    if (state.gateway && !authReady()) {
      showSignIn(signin);
    } else if (requested && VIEWS.includes(requested)) {
      showView(requested);
    } else if (needsSetup()) {
      showView("setup");
    } else if (!authReady()) {
      showView("settings");
    } else {
      showView("status");
    }
    void loadHealth();
  };

  // Registered before the probe below is awaited, so a page hidden while the
  // probe is in flight still stops polling.
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) handleVisibility();
  });

  // A device known to sit behind the gateway waits for the probe so it never
  // flashes the token form; anything else starts at once as standalone and
  // switches over only if the probe finds a gateway.
  const knownGateway = rememberedMode() === "gateway";
  if (!knownGateway) showInitialView();
  const probed = await probeMode();
  if (probed) {
    state.gateway = probed;
    if (probed.confirmed && probed.signedIn && state.token) {
      // Signed in with GitHub: the retiring shared token is no longer needed here.
      forgetToken(localStorage);
      state.token = "";
      $("token-input").value = "";
    }
    // Reveals the Admin tab for an admin and swaps the token form for the account.
    renderAccount();
    if (knownGateway || !authReady() || state.view === "settings" || needsSetup()) showInitialView();
  } else if (knownGateway) {
    showInitialView();
  }
}

if ("serviceWorker" in navigator) {
  // A newer worker taking over a page an older one served means a deploy
  // landed while this page stayed open; a resumed Home Screen app would keep
  // running the old shell, so reload into the new one unless a note would be lost.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !hasUnsentWork()) window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

void init();
