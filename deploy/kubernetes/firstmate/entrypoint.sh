#!/usr/bin/env bash
#
# Entrypoint for the firstmate Kubernetes runtime. It seeds the persistent
# firstmate home from the baked distro on first start, keeps the herdr backend
# explicit, starts the herdr headless server for the configured named session,
# and then starts firstmate's primary harness inside that session so the pod
# runs a live firstmate that drains queued instructions instead of only the
# server. A supervisor keeps the harness running: `herdr pane run` returns as
# soon as the command is typed, so a harness that exits (a bad credential, a
# crash, a quit, an auto-update restart) is started again in the same pane. The
# server stays in the foreground, so the session stays attachable with
# `herdr session attach <session>`.
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

# The id of this home's primary workspace in the session, or empty. Read-only.
herdr_workspace_id() {
  herdr_cli workspace list 2>/dev/null \
    | jq -r --arg label "$WORKSPACE_LABEL" \
        '.result.workspaces[]? | select(.label == $label) | .workspace_id' 2>/dev/null \
    | head -1 || true
}

# The pane to run the harness in: the workspace's root pane, read back from a
# live `pane list` so a husk restored across a server restart still resolves to
# its own pane id. Empty when the workspace has no pane.
herdr_workspace_pane() {  # <workspace-id>
  herdr_cli pane list --workspace "$1" 2>/dev/null \
    | jq -r '.result.panes[0].pane_id // empty' 2>/dev/null \
    | head -1 || true
}

# True when herdr already reports a registered agent in the pane. A server
# restart clears live registrations, so after a restart this is false and the
# harness is started; while it is true the entrypoint never types over a live
# agent (for example if it is re-run against a server it did not start).
herdr_pane_has_agent() {  # <pane-id>
  local status
  status=$(herdr_cli agent get "$1" 2>/dev/null \
    | jq -r '.result.agent.agent_status // empty' 2>/dev/null || true)
  [ -n "$status" ]
}

# Start the primary harness in the home workspace's pane. Creates the workspace
# on first start and reuses it afterwards, so restarts do not leak workspaces
# or tabs.
start_primary_harness() {
  local wsid pane out
  wsid=$(herdr_workspace_id)
  if [ -z "$wsid" ]; then
    out=$(herdr_cli workspace create --cwd "$HOME_DIR" --label "$WORKSPACE_LABEL" --no-focus 2>/dev/null) || {
      log "herdr workspace create failed for session '$SESSION'"
      return 1
    }
    wsid=$(printf '%s' "$out" | jq -r '.result.workspace.workspace_id // empty' 2>/dev/null)
    pane=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)
  fi
  if [ -n "$wsid" ] && [ -z "${pane:-}" ]; then
    pane=$(herdr_workspace_pane "$wsid")
  fi
  if [ -n "$wsid" ] && [ -z "${pane:-}" ]; then
    out=$(herdr_cli tab create --workspace "$wsid" --cwd "$HOME_DIR" --label "$WORKSPACE_LABEL" --no-focus 2>/dev/null) \
      || out=
    pane=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)
  fi
  if [ -z "${pane:-}" ]; then
    log "could not resolve a herdr pane for the primary harness"
    return 1
  fi
  if herdr_pane_has_agent "$pane"; then
    log "a harness is already live in pane '$pane'; not starting another"
    return 0
  fi
  log "starting primary harness in $SESSION:$pane: $HARNESS_CMD"
  if ! herdr_cli pane run "$pane" "$HARNESS_CMD" >/dev/null 2>&1; then
    log "herdr pane run failed for $SESSION:$pane"
    return 1
  fi
  HARNESS_STARTED_AT=$(date +%s)
}

# True when the home workspace's pane has a registered live harness. Resolves
# the workspace and pane fresh each call so a pane recreated by a restart is
# picked up.
herdr_home_harness_live() {
  local wsid pane
  wsid=$(herdr_workspace_id) || return 1
  [ -n "$wsid" ] || return 1
  pane=$(herdr_workspace_pane "$wsid") || return 1
  [ -n "$pane" ] || return 1
  herdr_pane_has_agent "$pane"
}

# Keep the primary harness running for as long as the server is. `herdr pane
# run` returns once the command is typed, so without this an opencode that
# exits immediately (a bad or missing credential) or later (a crash, a quit, an
# auto-update restart) would leave the server up, the pod Ready, and queued
# instructions pending. Each interval it checks the home pane and starts the
# harness again when nothing is registered there, but never before the harness
# it last started has had its grace period to register, so a slow start is not
# mistaken for a dead harness.
supervise_primary_harness() {
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sleep "$HARNESS_CHECK_INTERVAL"
    kill -0 "$SERVER_PID" 2>/dev/null || return 0
    herdr_server_running || continue
    herdr_home_harness_live && continue
    if [ -n "$HARNESS_STARTED_AT" ] \
      && [ $(( $(date +%s) - HARNESS_STARTED_AT )) -lt "$HARNESS_START_GRACE" ]; then
      continue
    fi
    log "primary harness is not running in session '$SESSION'; starting it again"
    start_primary_harness \
      || log "warning: failed to start the primary harness again"
  done
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
