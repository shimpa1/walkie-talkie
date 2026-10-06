#!/usr/bin/env bash
#
# Entrypoint for the firstmate Kubernetes runtime. It seeds the persistent
# firstmate home from the baked distro on first start, keeps the herdr backend
# explicit, starts the herdr headless server for the configured named session,
# and then starts firstmate's primary harness inside that session so the pod
# runs a live firstmate that drains queued instructions instead of only the
# server. The harness command opens with firstmate's own session-start prompt
# (exported below), because a bare harness would sit idle and never start
# firstmate; firstmate's tracked session-start plugin is removed so that opening
# prompt is its only delivery. A supervisor keeps the harness running: `herdr pane run` returns as
# soon as the command is typed, so a harness that exits (a bad credential, a
# crash, a quit, an auto-update restart) is started again in the same pane. The
# server stays in the foreground, so the session stays attachable with
# `herdr session attach <session>`. A per-user firstmate run by the multi-user
# gateway first fetches its own credentials from the gateway (step 2c), so no
# provider key ever sits in a Kubernetes Secret.
set -euo pipefail

HOME_DIR="${FM_HOME:-/home/firstmate}"
SEED_DIR="${FIRSTMATE_SEED_DIR:-/opt/firstmate}"
SESSION="${HERDR_SESSION:-firstmate}"
# Command that starts the primary harness in the session's home pane. It runs
# with the firstmate home as its working directory, inheriting this container's
# environment (including any harness credentials the chart passed). Empty
# leaves the server running with no harness, for an operator who prefers to
# start it by hand after attaching.
HARNESS_CMD="${FM_HARNESS_COMMAND:-}"
# firstmate's own primary workspace label for a home (bin/backends/herdr.sh,
# fm_backend_herdr_workspace_label). Reusing it keeps the primary harness in
# the same workspace firstmate later places its crewmate tabs in.
WORKSPACE_LABEL="firstmate"
# Seconds between supervisor liveness checks. Overridable for the entrypoint
# test; the production default trades a short detection delay for one cheap
# read-only `agent get` per interval.
HARNESS_CHECK_INTERVAL="${FM_HARNESS_SUPERVISION_INTERVAL:-5}"
# Seconds a freshly started harness is given to register before the supervisor
# treats its absence as a failure. `herdr pane run` returns as soon as the
# command is typed, so an unregistered pane can simply mean the harness is still
# coming up; without this pause the supervisor would type the command a second
# time into a harness that is still starting.
HARNESS_START_GRACE="${FM_HARNESS_SUPERVISION_GRACE:-30}"
# Written once the herdr server runs (and, for a gateway-managed firstmate,
# after its credentials arrived), so a readiness probe can tell a pod that is
# still waiting for its keys from one that is up. Empty writes nothing.
READY_FILE="${FM_READY_FILE:-}"
# Credential fetch backoff for a gateway-managed firstmate, in whole seconds:
# the first retry waits RETRY_DELAY, doubling up to RETRY_MAX.
TENANT_CREDENTIALS_RETRY_DELAY="${FM_TENANT_CREDENTIALS_RETRY_DELAY:-2}"
TENANT_CREDENTIALS_RETRY_MAX="${FM_TENANT_CREDENTIALS_RETRY_MAX:-60}"
SERVER_PID=
SUPERVISOR_PID=
HARNESS_STARTED_AT=

log() { printf 'firstmate-entrypoint: %s\n' "$*" >&2; }

# Every herdr control call is scoped to the named session with BOTH the
# HERDR_SESSION env var and a trailing `--session` flag. Firstmate verified
# that HERDR_SESSION alone is not reliably honored once another herdr server is
# bound on the host, so the flag is the authoritative selector; the env var is
# kept alongside it as documented defense in depth.
herdr_cli() { HERDR_SESSION="$SESSION" herdr "$@" --session "$SESSION"; }

herdr_server_running() {
  herdr_cli status --json 2>/dev/null \
    | jq -e '.server.running == true' >/dev/null 2>&1
}

shutdown() {
  if [ -n "$SUPERVISOR_PID" ] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

# Run a read-only herdr control call, capturing stderr as well as stdout
# because herdr reports a server error as JSON on stderr with a non-zero exit.
# Prints the combined reply and returns non-zero when the reply is missing or is
# not a JSON object, so callers can tell a completed read from a failed one.
# Every liveness helper uses this, so a failed, timed-out, empty, or unparseable
# read is never mistaken for an absent harness.
herdr_read() {  # <args...>
  local out
  out=$(herdr_cli "$@" 2>&1) || true
  printf '%s' "$out"
  printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1
}

# The id of this home's primary workspace in the session. Prints the id and
# returns 0 when it exists, returns 1 when the session authoritatively has no
# such workspace, and returns 2 when the read itself failed (unknown). Read-only.
herdr_workspace_id() {
  local out id
  out=$(herdr_read workspace list) || return 2
  if printf '%s' "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    return 2
  fi
  # The jq variable is named `want`, not `label`: `label` is a jq keyword, and
  # jq 1.6 (the Debian package the runtime image installs) rejects `$label` with
  # a syntax error, so a `--arg label` / `$label` pair fails the whole read.
  id=$(printf '%s' "$out" | jq -r --arg want "$WORKSPACE_LABEL" \
    '[.result.workspaces[]? | select(.label == $want) | .workspace_id][0] // empty' 2>/dev/null) \
    || return 2
  [ -n "$id" ] || return 1
  printf '%s' "$id"
}

# The pane to run the harness in: the workspace's root pane, read back from a
# live `pane list` so a husk restored across a server restart still resolves to
# its own pane id. Prints the id and returns 0 when it exists, returns 1 when the
# workspace authoritatively has no pane, and returns 2 when the read failed.
herdr_workspace_pane() {  # <workspace-id>
  local out pane
  out=$(herdr_read pane list --workspace "$1") || return 2
  if printf '%s' "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    return 2
  fi
  pane=$(printf '%s' "$out" | jq -r '.result.panes[0].pane_id // empty' 2>/dev/null) || return 2
  [ -n "$pane" ] || return 1
  printf '%s' "$pane"
}

# Whether a pane still has a live terminal in the running herdr server. A herdr
# server restart rehydrates the persisted session layout: `pane list` and
# `agent get` keep reporting the pane and its last agent, but no terminal
# process was restored, so `pane run`, `send-text`, `pane read`, and
# `pane process-info` all return `pane_not_found`. This read is the
# discriminator the agent record cannot give: 0 live, 1 authoritatively no
# terminal (a restored husk), 2 when the read itself failed (unknown).
herdr_pane_terminal_live() {  # <pane-id>
  local out
  out=$(herdr_read pane process-info --pane "$1") || return 2
  # herdr reports `pane_not_found` inside an `error` object for process-info and
  # as a top-level `code` for pane read; accept either envelope.
  if printf '%s' "$out" | jq -e '((.error.code? // empty) == "pane_not_found") or ((.code? // empty) == "pane_not_found")' >/dev/null 2>&1; then
    return 1
  fi
  if printf '%s' "$out" | jq -e 'has("error") or has("code")' >/dev/null 2>&1; then
    return 2
  fi
  return 0
}

# Returns 0 when herdr reports a registered agent in a pane that still has a live
# terminal, 1 when the server authoritatively reports no live harness there (no
# agent, or a restored husk whose stale agent record has no terminal behind it),
# and 2 when a read failed, so a transient CLI/IPC failure is never taken as
# evidence the harness is gone. While the agent is live the entrypoint never
# types over it (for example if it is re-run against a server it did not start).
herdr_pane_has_agent() {  # <pane-id>
  local out status term_rc=0
  # Prove the terminal first. A restart rehydrates `agent get` with the old
  # agent status while the pane has no process behind it, so trusting the agent
  # record alone made the entrypoint skip starting a harness after every
  # restart and leave the home idle with captain notes undrained.
  herdr_pane_terminal_live "$1" || term_rc=$?
  if [ "$term_rc" -eq 1 ]; then
    return 1
  fi
  if [ "$term_rc" -eq 2 ]; then
    return 2
  fi
  out=$(herdr_read agent get "$1") || return 2
  if printf '%s' "$out" | jq -e '.error.code == "agent_not_found"' >/dev/null 2>&1; then
    return 1
  fi
  if printf '%s' "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    return 2
  fi
  status=$(printf '%s' "$out" | jq -r '.result.agent.agent_status // empty' 2>/dev/null) || return 2
  [ -n "$status" ] || return 1
  return 0
}

# Resolve a live pane for the primary harness, creating the workspace or tab
# when missing and reusing both afterwards so restarts do not leak workspaces or
# tabs. A pane restored by a herdr server restart is a husk: it is listed and
# its stale agent is reported, but no terminal survived, so pane
# run/send-text/read/process-info return pane_not_found and it cannot host the
# harness. Such a pane is closed (with its workspace, which closes with its last
# pane) and a fresh live pane is created instead. Prints the pane id on success
# and returns 1 when none can be resolved.
ensure_primary_pane() {
  local wsid pane out ws_rc=0 pane_rc=0 term_rc=0
  for _ in 1 2; do
    wsid='' pane='' ws_rc=0 pane_rc=0 term_rc=0
    wsid=$(herdr_workspace_id) || ws_rc=$?
    if [ "$ws_rc" -eq 2 ]; then
      log "could not read the herdr workspace list for session '$SESSION'" >&2
      return 1
    fi
    if [ -z "$wsid" ]; then
      out=$(herdr_cli workspace create --cwd "$HOME_DIR" --label "$WORKSPACE_LABEL" --no-focus 2>/dev/null) || {
        log "herdr workspace create failed for session '$SESSION'" >&2
        return 1
      }
      wsid=$(printf '%s' "$out" | jq -r '.result.workspace.workspace_id // empty' 2>/dev/null)
      pane=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)
    fi
    if [ -n "$wsid" ] && [ -z "${pane:-}" ]; then
      pane=$(herdr_workspace_pane "$wsid") || pane_rc=$?
      if [ "$pane_rc" -eq 2 ]; then
        log "could not read the herdr pane list for workspace '$wsid'" >&2
        return 1
      fi
    fi
    if [ -n "$wsid" ] && [ -z "${pane:-}" ]; then
      out=$(herdr_cli tab create --workspace "$wsid" --cwd "$HOME_DIR" --label "$WORKSPACE_LABEL" --no-focus 2>/dev/null) \
        || out=
      pane=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)
    fi
    if [ -z "${pane:-}" ]; then
      log "could not resolve a herdr pane for the primary harness" >&2
      return 1
    fi
    herdr_pane_terminal_live "$pane" || term_rc=$?
    if [ "$term_rc" -eq 1 ]; then
      # Retained husk: a restart rehydrated this pane's layout but no terminal,
      # so it cannot accept pane run. Close the workspace and resolve again so a
      # fresh live pane starts firstmate instead of sitting idle.
      log "herdr pane '$pane' is a retained husk with no live terminal; replacing it with a fresh pane" >&2
      herdr_cli workspace close "$wsid" >/dev/null 2>&1 || true
      continue
    fi
    if [ "$term_rc" -eq 2 ]; then
      # Unknown terminal read: never destroy panes on an unreadable state; the
      # agent probe and the supervisor decide from here.
      log "could not read the terminal state for pane '$pane'; using it as-is" >&2
    fi
    printf '%s' "$pane"
    return 0
  done
  log "could not replace the retained herdr husk with a live pane" >&2
  return 1
}

# Start the primary harness in the home workspace's live pane. On a fresh or
# empty home ensure_primary_pane creates the workspace; on a restart whose herdr
# server rehydrated a terminal-less husk it replaces that pane so the harness
# always starts in a live pane.
start_primary_harness() {
  local pane sessionstart_plugin
  local pane_rc=0 agent_rc=0
  pane=$(ensure_primary_pane) || pane_rc=$?
  if [ "$pane_rc" -ne 0 ]; then
    return 1
  fi
  herdr_pane_has_agent "$pane" || agent_rc=$?
  if [ "$agent_rc" -eq 0 ]; then
    log "a harness is already live in pane '$pane'; not starting another"
    return 0
  fi
  if [ "$agent_rc" -eq 2 ]; then
    log "could not read the harness state for pane '$pane'"
    return 1
  fi
  # firstmate's tracked OpenCode plugin also nudges on session.created. The
  # command about to be typed already carries firstmate's session-start prompt,
  # so the plugin would deliver the same instruction a second time and could make
  # the model run firstmate's mutating startup sweeps twice. The plugin is a
  # tracked distro file with no stand-down switch, so suppress it in this home
  # before every start; only the session-start plugin is removed, leaving the
  # watcher and turn-end plugins in place for supervision.
  sessionstart_plugin="$HOME_DIR/.opencode/plugins/fm-primary-sessionstart-nudge.js"
  if [ -e "$sessionstart_plugin" ]; then
    rm -f "$sessionstart_plugin" 2>/dev/null || true
    log "removed firstmate's session-start nudge plugin so the opening prompt is its only delivery"
  fi
  log "starting primary harness in $SESSION:$pane: $HARNESS_CMD"
  if ! herdr_cli pane run "$pane" "$HARNESS_CMD" >/dev/null 2>&1; then
    log "herdr pane run failed for $SESSION:$pane"
    return 1
  fi
  HARNESS_STARTED_AT=$(date +%s)
}

# Whether the home workspace's pane has a registered live harness: 0 alive,
# 1 authoritatively not running, 2 when any read failed. Resolves the workspace
# and pane fresh each call so a pane recreated by a restart is picked up; the
# caller treats 2 as unknown and retries start_primary_harness, which re-reads
# and only types the command when the server authoritatively finds no agent.
herdr_home_harness_live() {
  local wsid pane ws_rc=0 pane_rc=0
  wsid=$(herdr_workspace_id) || ws_rc=$?
  [ "$ws_rc" -eq 0 ] || return "$ws_rc"
  pane=$(herdr_workspace_pane "$wsid") || pane_rc=$?
  [ "$pane_rc" -eq 0 ] || return "$pane_rc"
  herdr_pane_has_agent "$pane"
}

# Keep the primary harness running for as long as the server is. `herdr pane
# run` returns once the command is typed, so without this an opencode that
# exits immediately (a bad or missing credential) or later (a crash, a quit, an
# auto-update restart) would leave the server up, the pod Ready, and queued
# instructions pending. Each interval it checks the home pane and starts the
# harness again when it cannot confirm a live harness there, but never before the
# harness it last started has had its grace period to register, so a slow start
# is not mistaken for a dead harness. `live` is 1 when the server authoritatively
# reports no harness and 2 when a read failed, so the state is unknown. An
# unknown read is not evidence the harness is gone and must never type over a
# live pane, but it also must not park supervision forever: a start that failed
# at boot on a transient read, or a read that stays unknown, would otherwise
# leave the home with no harness and no retry. Both states therefore fall
# through to start_primary_harness, which re-reads the state and only types the
# command when it authoritatively finds no agent.
supervise_primary_harness() {
  local live
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sleep "$HARNESS_CHECK_INTERVAL"
    kill -0 "$SERVER_PID" 2>/dev/null || return 0
    herdr_server_running || continue
    if herdr_home_harness_live; then
      continue
    else
      live=$?
    fi
    if [ -n "$HARNESS_STARTED_AT" ] \
      && [ $(( $(date +%s) - HARNESS_STARTED_AT )) -lt "$HARNESS_START_GRACE" ]; then
      continue
    fi
    if [ "$live" -eq 2 ]; then
      log "could not confirm the primary harness state in session '$SESSION'; retrying the start path"
    else
      log "primary harness is not running in session '$SESSION'; starting it again"
    fi
    start_primary_harness \
      || log "warning: failed to start the primary harness again"
  done
}

# One fetch of this firstmate's credentials from the gateway. The token goes to
# curl on stdin (`-H @-`), never on a command line where another process could
# read it. Prints the delivery on success; returns 1 when the request failed or
# the answer is malformed, and 2 when it lacks the required provider key.
tenant_credentials_fetch() {  # <token>
  local body
  body=$(printf 'Authorization: Bearer %s\n' "$1" \
    | curl -sS --fail --max-time 15 --proto '=http,https' --max-redirs 0 \
        -H @- -H 'Accept: application/json' "$FM_TENANT_CREDENTIALS_URL" 2>/dev/null) || return 1
  printf '%s' "$body" | jq -e '
      (.env | type == "object")
      and all(.env | keys[]; test("^[A-Z_][A-Z0-9_]{0,127}$"))
      and all(.env[]; type == "string" and test("^[!-~]{1,8192}$"))' >/dev/null 2>&1 || return 1
  if [ -n "${FM_TENANT_REQUIRED_ENV:-}" ]; then
    printf '%s' "$body" | jq -e --arg need "$FM_TENANT_REQUIRED_ENV" '(.env[$need] // "") != ""' \
      >/dev/null 2>&1 || return 2
  fi
  printf '%s' "$body"
}

# Fetch this firstmate's credentials and export them for the herdr server (and
# so every pane) to inherit, the way the chart's Secret env reaches the captain's
# own pod. Retries with backoff until the gateway answers with the provider key:
# the harness never starts keyless, and the pod stays un-Ready meanwhile. Only
# the names in FM_TENANT_CREDENTIAL_ENVS are exported. The credential token is
# unset before anything else runs, and no token or value is ever printed.
fetch_tenant_credentials() {
  local token="${FM_TENANT_CREDENTIALS_TOKEN:-}" body='' rc delay attempt=0 line name value count=0
  local allowed=" ${FM_TENANT_CREDENTIAL_ENVS:-} "
  unset FM_TENANT_CREDENTIALS_TOKEN
  if [ -z "$token" ]; then
    log "FM_TENANT_CREDENTIALS_TOKEN is empty; refusing to start a harness without its credentials"
    return 1
  fi
  delay="$TENANT_CREDENTIALS_RETRY_DELAY"
  while :; do
    attempt=$((attempt + 1))
    rc=0
    body=$(tenant_credentials_fetch "$token") || rc=$?
    if [ "$rc" -eq 0 ]; then
      break
    fi
    if [ "$rc" -eq 2 ]; then
      log "the gateway delivered no ${FM_TENANT_REQUIRED_ENV} for this firstmate; refusing to start a keyless harness (attempt $attempt), retrying in ${delay}s"
    else
      log "could not fetch this firstmate's credentials from the gateway (attempt $attempt); retrying in ${delay}s"
    fi
    sleep "$delay"
    delay=$((delay * 2))
    if [ "$delay" -gt "$TENANT_CREDENTIALS_RETRY_MAX" ]; then
      delay="$TENANT_CREDENTIALS_RETRY_MAX"
    fi
  done
  token=
  # Names and values were validated above: one NAME=value line per variable,
  # values printable ASCII without spaces. A name holds no `=`, so the line
  # splits at its first one; the value keeps every `=` of its own.
  while IFS= read -r line; do
    name=${line%%=*}
    value=${line#*=}
    case "$allowed" in
      *" $name "*)
        export "$name=$value"
        count=$((count + 1))
        ;;
      *) log "ignored a delivered credential under an undeclared name: $name" ;;
    esac
  done < <(printf '%s' "$body" | jq -r '.env | to_entries[] | "\(.key)=\(.value)"')
  body=
  line=
  value=
  log "fetched this firstmate's credentials from the gateway ($count variable(s))"
}

# 1. Seed the persistent home on first start. A home that already carries the
#    distro (from a previous run or a migration) is left untouched.
if [ ! -e "$HOME_DIR/bin/fm-inbox.sh" ]; then
  log "seeding firstmate home at $HOME_DIR from $SEED_DIR"
  mkdir -p "$HOME_DIR"
  if [ -d "$SEED_DIR" ]; then
    cp -a "$SEED_DIR/." "$HOME_DIR/"
  else
    log "warning: seed directory $SEED_DIR is missing; the home will be empty"
  fi
fi
mkdir -p "$HOME_DIR/state" "$HOME_DIR/data" "$HOME_DIR/projects" "$HOME_DIR/config"

# 1b. Refresh the repo-patched OpenCode watch-arm plugin into the home. The seed
#     carries the patch (Dockerfile patches/), but the home is a
#     PersistentVolume seeded only once, so an existing volume would keep
#     upstream's plugin and never arm supervision for a home whose only pending
#     work is a queued inbox note. The plugin is a distro file firstmate does
#     not user-edit, so installing the seed's copy on every start applies the
#     fix to existing volumes as well as fresh ones. The write only happens when
#     the bytes differ, so a fresh seed is not rewritten.
WATCH_ARM_PLUGIN=".opencode/plugins/fm-primary-watch-arm.js"
if [ -f "$SEED_DIR/$WATCH_ARM_PLUGIN" ]; then
  mkdir -p "$HOME_DIR/.opencode/plugins"
  if ! cmp -s "$SEED_DIR/$WATCH_ARM_PLUGIN" "$HOME_DIR/$WATCH_ARM_PLUGIN"; then
    cp -f "$SEED_DIR/$WATCH_ARM_PLUGIN" "$HOME_DIR/$WATCH_ARM_PLUGIN"
    log "installed the patched OpenCode watch-arm plugin so supervision arms without an in-flight task"
  fi
fi

# 1b2. Refresh the repo-patched watcher into the home. The seed carries the
#      patch (Dockerfile patches/), but the home is a PersistentVolume seeded
#      only once, so an existing volume would keep upstream's watcher and, in a
#      home whose only work is queued notes, every note after the first watcher
#      cycle would sit in the wake queue forever. bin/ is the distro firstmate
#      does not user-edit, so installing the seed's copy on every start applies
#      the fix to existing volumes as well as fresh ones. The watcher is
#      replaced atomically because a concurrently armed watcher may exec it
#      while this runs. The write only happens when the bytes differ, so a fresh
#      seed is not rewritten.
WATCH_WATCHER="bin/fm-watch.sh"
if [ -f "$SEED_DIR/$WATCH_WATCHER" ]; then
  if ! cmp -s "$SEED_DIR/$WATCH_WATCHER" "$HOME_DIR/$WATCH_WATCHER"; then
    mkdir -p "$HOME_DIR/bin"
    tmp="$HOME_DIR/$WATCH_WATCHER.tmp.$$"
    if cp -f "$SEED_DIR/$WATCH_WATCHER" "$tmp" \
      && chmod 0755 "$tmp" \
      && mv -f "$tmp" "$HOME_DIR/$WATCH_WATCHER"; then
      log "installed the patched watcher so a queued note resurfaces after any watcher cycle"
    else
      rm -f "$tmp" 2>/dev/null || true
    fi
  fi
fi

# 1c. Refresh the OpenCode herdr integration into the home. It reports the pane's
#     agent session id to herdr, which the walkie-talkie Conversations view maps
#     to the agent store to render the session's real history. The home is a
#     PersistentVolume seeded only once, so an existing volume would never get
#     it; the file is a herdr-managed integration baked into the seed (not a
#     user-edited distro file), so installing the seed's copy on every start
#     applies it to existing volumes as well as fresh ones. The write only
#     happens when the bytes differ, so a fresh seed is not rewritten.
HERDR_OPENCODE_PLUGIN=".opencode/plugins/herdr-agent-state.js"
if [ -f "$SEED_DIR/$HERDR_OPENCODE_PLUGIN" ]; then
  mkdir -p "$HOME_DIR/.opencode/plugins"
  if ! cmp -s "$SEED_DIR/$HERDR_OPENCODE_PLUGIN" "$HOME_DIR/$HERDR_OPENCODE_PLUGIN"; then
    cp -f "$SEED_DIR/$HERDR_OPENCODE_PLUGIN" "$HOME_DIR/$HERDR_OPENCODE_PLUGIN"
    log "installed the OpenCode herdr integration so the primary pane reports its agent session"
  fi
fi

# 1d. Reconcile a watcher lock a previous container left behind. A container
#     restart tears the watcher down without running its exit cleanup, so
#     state/.watch.lock can name a pid that no longer exists; the fresh harness
#     must not be left arming against a dead holder. Only a lock whose recorded
#     pid is provably not alive is removed - a live watcher's lock (a running
#     server's home) is left for firstmate's own stale-lock recovery, which also
#     persists the downtime marker. state/.watcher-down and state/.wake-queue are
#     firstmate's durable recovery state and are deliberately left in place: the
#     patched watcher consumes them to resurface the queued note, so clearing
#     them here would drop the very wake this path exists to deliver.
reconcile_dead_watcher_lock() {
  local lock="$HOME_DIR/state/.watch.lock" owner pid
  [ -L "$lock" ] || return 0
  pid=$(cat "$lock/pid" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$pid" != 1 ] || return 0
  kill -0 "$pid" 2>/dev/null && return 0
  owner=$(readlink "$lock" 2>/dev/null || true)
  if rm -f "$lock" 2>/dev/null; then
    case "$owner" in
      "$HOME_DIR/state/.watch.lock.owner."*) rm -rf -- "$owner" 2>/dev/null || true ;;
    esac
    log "removed a watcher lock left by a previous container so supervision can re-arm"
  fi
}
reconcile_dead_watcher_lock

# 2. git must trust a home owned by the volume's group, and the backend is
#    written to config/backend so an interactive attach session resolves the
#    same herdr backend firstmate uses.
git config --global --add safe.directory "$HOME_DIR" 2>/dev/null || true
if [ ! -e "$HOME_DIR/config/backend" ]; then
  printf '%s\n' herdr > "$HOME_DIR/config/backend"
fi

# Allow seeding to run on its own (for an initContainer or an image test)
# without starting the herdr server.
if [ "${FIRSTMATE_SEED_ONLY:-0}" = "1" ]; then
  log "seed-only mode: home is ready at $HOME_DIR"
  exit 0
fi

# 2b. Compute the prompt that starts firstmate when the harness opens. A bare
#     OpenCode TUI stays on its empty "Ask anything" landing screen and does not
#     create a session until it receives a first prompt, so firstmate's tracked
#     .opencode/plugins/fm-primary-sessionstart-nudge.js plugin never fires and
#     the session-start never runs. The entrypoint therefore asks firstmate's own
#     nudge adapter for the exact session-start prompt and exports it before the
#     server starts, because the herdr server passes its environment to every
#     pane it creates; the default harness command passes it as `--prompt`, which
#     both creates the session and starts firstmate. A home without the adapter
#     (an older or partial seed) falls back to the same instruction as plain
#     text, so the harness still starts firstmate instead of idling. Because this
#     prompt is now the session-start delivery, start_primary_harness removes the
#     plugin (below) so it cannot deliver the same instruction a second time.
PRIMARY_SESSION_START_PROMPT=
if [ -f "$HOME_DIR/bin/fm-sessionstart-nudge.sh" ]; then
  PRIMARY_SESSION_START_PROMPT=$(FM_HOME="$HOME_DIR" bash "$HOME_DIR/bin/fm-sessionstart-nudge.sh" 2>/dev/null || true)
fi
if [ -z "$PRIMARY_SESSION_START_PROMPT" ]; then
  # shellcheck disable=SC2016 # Backticks are literal prompt markup, not expansion.
  PRIMARY_SESSION_START_PROMPT='Run `bin/fm-session-start.sh` now, exactly once, before executing any other instructions.'
fi
export FM_PRIMARY_SESSION_START_PROMPT="$PRIMARY_SESSION_START_PROMPT"
log "primary harness will open with firstmate's session-start prompt"

# 2c. A per-user firstmate run by the multi-user gateway has no key in its
#     environment yet: fetch it from the gateway's internal port before the
#     herdr server starts, because the server passes its startup environment to
#     every pane it creates (fetch_tenant_credentials above). The captain's own
#     pod sets no FM_TENANT_CREDENTIALS_URL and skips this.
if [ -n "$READY_FILE" ]; then
  rm -f "$READY_FILE" 2>/dev/null || true
fi
if [ -n "${FM_TENANT_CREDENTIALS_URL:-}" ]; then
  fetch_tenant_credentials || exit 1
fi

# 3. Start the herdr headless server in the background so the entrypoint can
#    make control calls (create the home workspace, start the harness) against
#    it. firstmate's adapter reuses a running server for this session, and you
#    attach with `herdr session attach <session>`.
log "starting herdr server for session '$SESSION'"
HERDR_SESSION="$SESSION" herdr server --session "$SESSION" &
SERVER_PID=$!
trap shutdown TERM INT

for _ in $(seq 1 60); do
  herdr_server_running && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done

if ! herdr_server_running; then
  log "herdr server for session '$SESSION' did not report running; exiting"
  shutdown
  exit 1
fi
if [ -n "$READY_FILE" ]; then
  : > "$READY_FILE" 2>/dev/null || log "warning: could not write the readiness marker $READY_FILE"
fi

# 4. Start firstmate's primary harness inside the session and supervise it. The
#    server passes its startup environment to every pane it creates, so the
#    harness inherits this container's environment, including the harness
#    credentials the chart mounted. A failure to start is not fatal: the session
#    stays attachable, the supervisor keeps retrying, and an operator can start
#    the harness by hand.
if [ -n "$HARNESS_CMD" ]; then
  start_primary_harness \
    || log "warning: the primary harness did not start; the supervisor will keep trying and you can attach to '$SESSION' and start it manually"
  supervise_primary_harness &
  SUPERVISOR_PID=$!
else
  log "FM_HARNESS_COMMAND is empty; running the herdr server without a harness"
fi

# 5. Keep the server as the long-lived foreground process. Its exit ends the
#    container so Kubernetes restarts the pod.
wait "$SERVER_PID"
