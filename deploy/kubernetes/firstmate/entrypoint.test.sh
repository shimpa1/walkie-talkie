#!/usr/bin/env bash
# Exercise deploy/kubernetes/firstmate/entrypoint.sh against a fake herdr so the
# harness-start, harness-supervision, and credential-environment paths are
# verified without a cluster and without driving any real Herdr lifecycle. A
# gateway-managed firstmate's credential fetch runs against a fake gateway (a
# small local HTTP server) with the same fake herdr. Prints "ok" on success.
#
# Usage: bash deploy/kubernetes/firstmate/entrypoint.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="$HERE/entrypoint.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "skip: jq is required" >&2
  exit 0
fi
if ! command -v git >/dev/null 2>&1; then
  echo "skip: git is required" >&2
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fm-entrypoint-test.XXXXXX")"
EP_PID=
cleanup() {
  if [ -n "$EP_PID" ] && kill -0 "$EP_PID" 2>/dev/null; then
    kill -TERM "$EP_PID" 2>/dev/null || true
    wait "$EP_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

HOME_DIR="$TMP/home"
SEED_DIR="$TMP/seed"
FAKE_BIN="$TMP/bin"
HERDR_LOG="$TMP/herdr.log"
PANE_LOG="$TMP/pane.log"
SERVER_ENV="$TMP/server.env"
FORCE_DEAD="$TMP/force-dead"
STARTING="$TMP/starting"
STATUS_FAIL_ONCE="$TMP/status-fail-once"
READ_FAIL="$TMP/read-fail"
WS_FAIL="$TMP/ws-fail"
: > "$HERDR_LOG"
: > "$PANE_LOG"

# Pre-seed the home so the entrypoint skips copying the baked distro.
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/config" "$HOME_DIR/state" "$HOME_DIR/data" "$HOME_DIR/projects" "$FAKE_BIN"
printf '#!/bin/sh\n' > "$HOME_DIR/bin/fm-inbox.sh"
# A watcher lock left by a previous container names a pid that no longer
# exists; the entrypoint must drop it so the fresh harness arms against a clean
# home. state/.watcher-down is firstmate's durable recovery state and must be
# left for the watcher to resurface, so it is present and must survive.
mkdir -p "$HOME_DIR/state/.watch.lock.owner.DEAD"
printf '2147483647\n' > "$HOME_DIR/state/.watch.lock.owner.DEAD/pid"
printf '/home/firstmate\n' > "$HOME_DIR/state/.watch.lock.owner.DEAD/fm-home"
ln -s "$HOME_DIR/state/.watch.lock.owner.DEAD" "$HOME_DIR/state/.watch.lock"
printf 'pending:downtime:1.1700000000.keepme\n' > "$HOME_DIR/state/.watcher-down"
# Stand in for firstmate's bin/fm-sessionstart-nudge.sh so the test can assert
# the entrypoint exports its output as the harness's opening prompt.
cat > "$HOME_DIR/bin/fm-sessionstart-nudge.sh" <<'FAKE_NUDGE'
#!/usr/bin/env bash
printf '%s\n' 'FM_TEST_SESSION_START_NUDGE'
FAKE_NUDGE
# firstmate's tracked OpenCode session-start plugin, which the entrypoint must
# remove once the opening prompt is its delivery, beside a sibling plugin it must
# leave in place for supervision.
mkdir -p "$HOME_DIR/.opencode/plugins"
printf 'export const X = async () => ({});\n' > "$HOME_DIR/.opencode/plugins/fm-primary-sessionstart-nudge.js"
printf 'export const Y = async () => ({});\n' > "$HOME_DIR/.opencode/plugins/fm-primary-watch-arm.js"
# The image's patched watch-arm plugin lives in the seed; a home on an existing
# volume carries an older copy, so the entrypoint must refresh it from the seed.
mkdir -p "$SEED_DIR/.opencode/plugins"
printf 'export const PATCHED_WATCH_ARM = true;\n' > "$SEED_DIR/.opencode/plugins/fm-primary-watch-arm.js"
# The image's patched watcher also lives in the seed; a home on an existing
# volume carries upstream's watcher, so the entrypoint must refresh it too.
mkdir -p "$SEED_DIR/bin"
printf '#!/bin/sh\nprintf "PATCHED_WATCHER\\n"\n' > "$SEED_DIR/bin/fm-watch.sh"
chmod 0755 "$SEED_DIR/bin/fm-watch.sh"

cat > "$FAKE_BIN/herdr" <<'FAKE_HERDR'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
printf '%s\n' "$*" >> "${FAKE_HERDR_LOG:?}"
case "${args[0]:-} ${args[1]:-}" in
  "status --json")
    if [ -e "${FAKE_HERDR_STATUS_FAIL_ONCE:-/nonexistent}" ]; then
      rm -f "$FAKE_HERDR_STATUS_FAIL_ONCE"
      printf '{"client":{"version":"0.9.0","protocol":22},"server":{"running":false,"protocol":22,"compatible":true}}\n'
    else
      printf '{"client":{"version":"0.9.0","protocol":22},"server":{"running":true,"protocol":22,"compatible":true}}\n'
    fi
    ;;
  "workspace list")
    # A transient transport failure (not an authoritative empty list) must be
    # reported as a failed read, never as "no workspace".
    if [ -e "${FAKE_HERDR_WS_FAIL:-/nonexistent}" ]; then
      printf '{"error":{"code":"server_not_running","message":"transient"}}\n' >&2
      exit 1
    elif [ -e "${FAKE_HERDR_RETAINED:-/nonexistent}" ]; then
      # A retained session: the workspace is listed until the restored husk is
      # closed, then the fresh one the entrypoint creates is listed.
      if grep -q '^workspace close' "${FAKE_HERDR_LOG:?}" 2>/dev/null; then
        if grep -q '^workspace create' "${FAKE_HERDR_LOG:?}" 2>/dev/null; then
          printf '{"result":{"workspaces":[{"workspace_id":"w2","label":"firstmate"}]}}\n'
        else
          printf '{"result":{"workspaces":[]}}\n'
        fi
      else
        printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"firstmate"}]}}\n'
      fi
    elif grep -q '^workspace create' "${FAKE_HERDR_LOG:?}" 2>/dev/null; then
      printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"firstmate"}]}}\n'
    else
      printf '{"result":{"workspaces":[]}}\n'
    fi
    ;;
  "workspace create")
    if [ -e "${FAKE_HERDR_RETAINED:-/nonexistent}" ]; then
      printf '{"result":{"workspace":{"workspace_id":"w2","label":"firstmate"},"tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1"}}}\n'
    else
      printf '{"result":{"workspace":{"workspace_id":"w1","label":"firstmate"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}\n'
    fi
    ;;
  "pane list")
    if [ -e "${FAKE_HERDR_RETAINED:-/nonexistent}" ] \
      && grep -q '^workspace close' "${FAKE_HERDR_LOG:?}" 2>/dev/null; then
      printf '{"result":{"panes":[{"pane_id":"w2:p1","tab_id":"w2:t1"}]}}\n'
    else
      printf '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}\n'
    fi
    ;;
  "agent get")
    # A transient transport failure must be reported as a failed read, never as
    # agent_not_found (which is an authoritative "the harness is gone").
    if [ -e "${FAKE_HERDR_READ_FAIL:-/nonexistent}" ]; then
      printf '{"error":{"code":"server_not_running","message":"transient"}}\n' >&2
      exit 1
    # A retained husk: agent get still reports the pane's last agent idle even
    # though no terminal survived the server restart.
    elif [ -e "${FAKE_HERDR_RETAINED:-/nonexistent}" ] && [ "${args[2]:-}" = "w1:p1" ]; then
      printf '{"result":{"agent":{"agent":"opencode","agent_status":"idle"}}}\n'
    # No agent while the start window is open (the harness is still coming up),
    # while the test forces it dead (the harness exited), or before any pane_run;
    # otherwise a live idle harness.
    elif [ -e "${FAKE_HERDR_FORCE_DEAD:-/nonexistent}" ] \
      || [ -e "${FAKE_HERDR_STARTING:-/nonexistent}" ] \
      || ! grep -q '^pane_run ' "${FAKE_HERDR_PANE_LOG:?}" 2>/dev/null; then
      printf '{"error":{"code":"agent_not_found","message":"no agent"}}\n'
    else
      printf '{"result":{"agent":{"agent":"opencode","agent_status":"idle"}}}\n'
    fi
    ;;
  "pane process-info")
    # A retained husk has no live terminal: process-info, like pane run and
    # send-text, returns pane_not_found even though pane list and agent get
    # still name the pane. A live pane returns its shell process info.
    p="${args[3]:-}"
    if [ -e "${FAKE_HERDR_RETAINED:-/nonexistent}" ] && [ "$p" = "w1:p1" ]; then
      printf '{"error":{"code":"pane_not_found","message":"pane %s not found"}}\n' "$p"
      exit 1
    fi
    printf '{"result":{"process_info":{"pane_id":"%s","shell_pid":4242}}}\n' "$p"
    ;;
  "pane run")
    printf 'pane_run pane=%s command=%s\n' "${args[2]:-}" "${args[3]:-}" >> "${FAKE_HERDR_PANE_LOG:?}"
    printf 'pane_run deepseek_api_key=%s\n' "${DEEPSEEK_API_KEY:-}" >> "${FAKE_HERDR_PANE_LOG:?}"
    ;;
  "server "*|"server")
    env | sort > "${FAKE_HERDR_SERVER_ENV:?}"
    if [ -n "${FAKE_ORDER_LOG:-}" ]; then
      printf 'server\n' >> "$FAKE_ORDER_LOG"
    fi
    exec sleep 300
    ;;
  *)
    ;;
esac
FAKE_HERDR
chmod +x "$FAKE_BIN/herdr"

# The chart default: opencode auto-approved and opened with firstmate's
# session-start prompt, which the entrypoint exports for the pane to expand.
HARNESS_CMD="OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"allow\"}}' opencode --prompt \"\$FM_PRIMARY_SESSION_START_PROMPT\""

# The harness is "starting" (no agent registered) until the test removes this
# marker, so the supervisor's start-grace window is exercised.
: > "$STARTING"

PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME_DIR" \
  FM_HOME="$HOME_DIR" \
  FIRSTMATE_SEED_DIR="$SEED_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  FM_HARNESS_SUPERVISION_INTERVAL=0.2 \
  FM_HARNESS_SUPERVISION_GRACE=3 \
  DEEPSEEK_API_KEY=test-deepseek-key \
  FAKE_HERDR_LOG="$HERDR_LOG" \
  FAKE_HERDR_PANE_LOG="$PANE_LOG" \
  FAKE_HERDR_SERVER_ENV="$SERVER_ENV" \
  FAKE_HERDR_FORCE_DEAD="$FORCE_DEAD" \
  FAKE_HERDR_STARTING="$STARTING" \
  FAKE_HERDR_STATUS_FAIL_ONCE="$STATUS_FAIL_ONCE" \
  FAKE_HERDR_READ_FAIL="$READ_FAIL" \
  FAKE_HERDR_WS_FAIL="$WS_FAIL" \
  bash "$ENTRYPOINT" &
EP_PID=$!

for _ in $(seq 1 200); do
  grep -q '^pane_run ' "$PANE_LOG" 2>/dev/null && break
  kill -0 "$EP_PID" 2>/dev/null || break
  sleep 0.1
done

grep -q 'workspace create' "$HERDR_LOG" \
  || fail "entrypoint did not create a herdr workspace"
grep -q -- '--label firstmate' "$HERDR_LOG" \
  || fail "entrypoint did not use firstmate's primary workspace label"
grep -q '^pane_run pane=w1:p1 ' "$PANE_LOG" \
  || fail "entrypoint did not run the harness in the workspace pane"
grep -Fq "command=$HARNESS_CMD" "$PANE_LOG" \
  || fail "entrypoint did not pass firstmate.harnessCommand to the pane"
# shellcheck disable=SC2016 # The flag is matched literally; the pane expands it.
grep -Fq -- '--prompt "$FM_PRIMARY_SESSION_START_PROMPT"' "$PANE_LOG" \
  || fail "entrypoint did not open the harness with the session-start prompt flag"
grep -q '^FM_PRIMARY_SESSION_START_PROMPT=FM_TEST_SESSION_START_NUDGE$' "$SERVER_ENV" \
  || fail "entrypoint did not export firstmate's session-start prompt to the pane environment"
[ ! -e "$HOME_DIR/.opencode/plugins/fm-primary-sessionstart-nudge.js" ] \
  || fail "entrypoint left firstmate's session-start nudge plugin to deliver the prompt a second time"
[ -e "$HOME_DIR/.opencode/plugins/fm-primary-watch-arm.js" ] \
  || fail "entrypoint removed a plugin other than the session-start nudge"
grep -q 'PATCHED_WATCH_ARM' "$HOME_DIR/.opencode/plugins/fm-primary-watch-arm.js" \
  || fail "entrypoint did not refresh the seed's patched watch-arm plugin into the home"
grep -q 'PATCHED_WATCHER' "$HOME_DIR/bin/fm-watch.sh" \
  || fail "entrypoint did not refresh the seed's patched watcher into the home"
[ -x "$HOME_DIR/bin/fm-watch.sh" ] \
  || fail "entrypoint refreshed the patched watcher without its executable bit"
grep -q 'deepseek_api_key=test-deepseek-key' "$PANE_LOG" \
  || fail "harness credentials did not reach the herdr pane call"
grep -q '^DEEPSEEK_API_KEY=test-deepseek-key$' "$SERVER_ENV" \
  || fail "harness credentials did not reach the herdr server environment"
[ ! -e "$HOME_DIR/state/.watch.lock" ] \
  || fail "entrypoint left a dead watcher lock from a previous container"
[ ! -e "$HOME_DIR/state/.watch.lock.owner.DEAD" ] \
  || fail "entrypoint left a dead watcher lock owner directory"
[ -e "$HOME_DIR/state/.watcher-down" ] \
  || fail "entrypoint cleared firstmate's durable recovery marker"

# The harness has not registered yet (start window open), so the supervisor
# must give it its grace period instead of typing a duplicate command.
sleep 1
starting_runs=$(grep -c '^pane_run pane=' "$PANE_LOG" || true)
[ "$starting_runs" -eq 1 ] \
  || fail "supervisor started $starting_runs harnesses during the start grace window"

# The harness is now registered and live, so the supervisor must leave it alone.
rm -f "$STARTING"
sleep 1
live_runs=$(grep -c '^pane_run pane=' "$PANE_LOG" || true)
[ "$live_runs" -eq 1 ] \
  || fail "supervisor started $live_runs harnesses while one was already live"

# A transient `agent get` failure (a transport error, not an authoritative
# agent_not_found) must not be taken as the harness having exited: the
# supervisor must skip the interval instead of typing the command over the live
# pane. The failure window outlasts the start grace, so a fail-open read would
# have restarted by now.
: > "$READ_FAIL"
sleep 1.5
read_fail_runs=$(grep -c '^pane_run pane=' "$PANE_LOG" || true)
[ "$read_fail_runs" -eq 1 ] \
  || fail "supervisor restarted the harness on a failed agent read"
rm -f "$READ_FAIL"

# The same holds for a failed workspace read, the other liveness input: it must
# not create a second workspace or type over the live pane.
: > "$WS_FAIL"
sleep 1.5
ws_fail_runs=$(grep -c '^pane_run pane=' "$PANE_LOG" || true)
[ "$ws_fail_runs" -eq 1 ] \
  || fail "supervisor restarted the harness on a failed workspace read"
rm -f "$WS_FAIL"

# Simulate the harness exiting and assert the supervisor starts it again. A
# single transient `herdr status` failure is injected first: it must not end
# supervision, so the restart must still happen.
: > "$STATUS_FAIL_ONCE"
: > "$FORCE_DEAD"
for _ in $(seq 1 100); do
  [ "$(grep -c '^pane_run pane=' "$PANE_LOG" || true)" -ge 2 ] && break
  kill -0 "$EP_PID" 2>/dev/null || break
  sleep 0.1
done
restarted_runs=$(grep -c '^pane_run pane=' "$PANE_LOG" || true)
[ "$restarted_runs" -ge 2 ] \
  || fail "supervisor did not restart the primary harness after it exited"

# A transient or stubbornly-unknown herdr read at boot must not strand
# supervision. With the workspace list unavailable, the boot start fails and
# every liveness read is unknown, so a supervisor that parked on unknown would
# never start the harness; once the read recovers it must still start it.
kill -TERM "$EP_PID" 2>/dev/null || true
wait "$EP_PID" 2>/dev/null || true
EP_PID=

HOME2="$TMP/home2"
HERDR_LOG2="$TMP/herdr2.log"
PANE_LOG2="$TMP/pane2.log"
SERVER_ENV2="$TMP/server2.env"
EP2_ERR="$TMP/ep2.err"
WS_FAIL2="$TMP/ws-fail2"
STARTING2="$TMP/starting2"
mkdir -p "$HOME2/bin" "$HOME2/config" "$HOME2/state" "$HOME2/data" "$HOME2/projects"
printf '#!/bin/sh\n' > "$HOME2/bin/fm-inbox.sh"
: > "$HERDR_LOG2"
: > "$PANE_LOG2"
: > "$WS_FAIL2"
: > "$STARTING2"

PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME2" \
  FM_HOME="$HOME2" \
  FIRSTMATE_SEED_DIR="$SEED_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  FM_HARNESS_SUPERVISION_INTERVAL=0.2 \
  FM_HARNESS_SUPERVISION_GRACE=3 \
  DEEPSEEK_API_KEY=test-deepseek-key \
  FAKE_HERDR_LOG="$HERDR_LOG2" \
  FAKE_HERDR_PANE_LOG="$PANE_LOG2" \
  FAKE_HERDR_SERVER_ENV="$SERVER_ENV2" \
  FAKE_HERDR_FORCE_DEAD="$TMP/force-dead2" \
  FAKE_HERDR_STARTING="$STARTING2" \
  FAKE_HERDR_STATUS_FAIL_ONCE="$TMP/status-fail-once2" \
  FAKE_HERDR_READ_FAIL="$TMP/read-fail2" \
  FAKE_HERDR_WS_FAIL="$WS_FAIL2" \
  bash "$ENTRYPOINT" >"$TMP/ep2.out" 2>"$EP2_ERR" &
EP_PID=$!

# Let the boot start (which fails on the workspace read) and several unknown
# supervision intervals run; the supervisor must not have typed over a state it
# could not read.
sleep 1.5
if grep -q '^pane_run ' "$PANE_LOG2" 2>/dev/null; then
  fail "supervisor started the harness while the home state was unknown"
fi
grep -q 'could not read the herdr workspace list' "$EP2_ERR" \
  || fail "expected the boot harness start to fail on the workspace read"
grep -q 'could not confirm the primary harness state' "$EP2_ERR" \
  || fail "supervisor did not retry the start path on the unknown read"

# The read recovers: the supervisor must now start the harness in the empty home.
rm -f "$WS_FAIL2"
for _ in $(seq 1 100); do
  grep -q '^pane_run ' "$PANE_LOG2" 2>/dev/null && break
  kill -0 "$EP_PID" 2>/dev/null || break
  sleep 0.1
done
grep -q '^pane_run ' "$PANE_LOG2" \
  || fail "supervisor never recovered the harness after the herdr read came back"
grep -q 'workspace create' "$HERDR_LOG2" \
  || fail "supervisor never created the home workspace after the read recovered"

kill -TERM "$EP_PID" 2>/dev/null || true
wait "$EP_PID" 2>/dev/null || true
EP_PID=

# A herdr server restart rehydrates the persisted session layout as a pane with
# no terminal: pane list and agent get still report the primary pane and its
# idle agent, but pane run/send-text/process-info return pane_not_found. The
# entrypoint must not accept that stale agent as a live harness, must close the
# restored workspace, and must start firstmate in a fresh live pane, or every
# restart leaves the deployed firstmate idle and captain notes undrained.
HOME3="$TMP/home3"
HERDR_LOG3="$TMP/herdr3.log"
PANE_LOG3="$TMP/pane3.log"
SERVER_ENV3="$TMP/server3.env"
EP3_ERR="$TMP/ep3.err"
RETAINED3="$TMP/retained3"
mkdir -p "$HOME3/bin" "$HOME3/config" "$HOME3/state" "$HOME3/data" "$HOME3/projects"
printf '#!/bin/sh\n' > "$HOME3/bin/fm-inbox.sh"
: > "$HERDR_LOG3"
: > "$PANE_LOG3"
: > "$RETAINED3"

PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME3" \
  FM_HOME="$HOME3" \
  FIRSTMATE_SEED_DIR="$SEED_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  FM_HARNESS_SUPERVISION_INTERVAL=0.2 \
  FM_HARNESS_SUPERVISION_GRACE=3 \
  DEEPSEEK_API_KEY=test-deepseek-key \
  FAKE_HERDR_LOG="$HERDR_LOG3" \
  FAKE_HERDR_PANE_LOG="$PANE_LOG3" \
  FAKE_HERDR_SERVER_ENV="$SERVER_ENV3" \
  FAKE_HERDR_RETAINED="$RETAINED3" \
  bash "$ENTRYPOINT" >"$TMP/ep3.out" 2>"$EP3_ERR" &
EP_PID=$!

for _ in $(seq 1 200); do
  grep -q '^pane_run ' "$PANE_LOG3" 2>/dev/null && break
  kill -0 "$EP_PID" 2>/dev/null || break
  sleep 0.1
done

grep -q '^workspace close w1 ' "$HERDR_LOG3" \
  || fail "entrypoint did not close the retained husk workspace"
grep -q '^pane_run pane=w2:p1 ' "$PANE_LOG3" \
  || fail "entrypoint did not start the harness in a fresh live pane after the husk"
grep -q 'retained husk with no live terminal' "$EP3_ERR" \
  || fail "entrypoint did not report replacing the retained husk"
if grep -q 'a harness is already live' "$EP3_ERR"; then
  fail "entrypoint treated the retained husk as a live harness"
fi

# A per-user firstmate run by the multi-user gateway fetches its credentials
# from the gateway's internal port before the herdr server starts: the token
# goes in the Authorization header and is unset before anything inherits it, a
# failed fetch is retried, an answer without the provider key is refused rather
# than starting a keyless harness, only declared names are exported, and no
# token or key is ever printed.
if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "skip: python3 and curl are required for the credential-fetch checks" >&2
  echo "ok"
  exit 0
fi

HOME4="$TMP/home4"
HERDR_LOG4="$TMP/herdr4.log"
PANE_LOG4="$TMP/pane4.log"
SERVER_ENV4="$TMP/server4.env"
EP4_ERR="$TMP/ep4.err"
GATEWAY_DIR="$TMP/gateway"
ORDER_LOG="$TMP/order.log"
mkdir -p "$HOME4/bin" "$HOME4/config" "$HOME4/state" "$HOME4/data" "$HOME4/projects" "$GATEWAY_DIR"
printf '#!/bin/sh\n' > "$HOME4/bin/fm-inbox.sh"
: > "$HERDR_LOG4"
: > "$PANE_LOG4"
: > "$ORDER_LOG"
printf 'fail\n' > "$GATEWAY_DIR/mode"

CRED_TOKEN="uabc2345.test-credential-token-$$"
PROVIDER_KEY="sk-ant-test-delivered-key-$$"
GITHUB_KEY="github_pat_test_delivered-$$"

cat > "$GATEWAY_DIR/gateway.py" <<'FAKE_GATEWAY'
import http.server
import json
import os
import sys

state = sys.argv[1]
token = os.environ["FAKE_GATEWAY_TOKEN"]
order = os.environ["FAKE_ORDER_LOG"]


class Gateway(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        with open(os.path.join(state, "mode")) as handle:
            mode = handle.read().strip()
        authorized = self.headers.get("Authorization") == "Bearer " + token
        with open(os.path.join(state, "requests.log"), "a") as handle:
            handle.write("%s %s %s\n" % (self.path, "auth-ok" if authorized else "auth-bad", mode))
        with open(order, "a") as handle:
            handle.write("fetch:%s\n" % mode)
        if self.path != "/internal/v1/credentials" or not authorized:
            self.send_response(401)
            self.end_headers()
            return
        if mode == "fail":
            self.send_response(503)
            self.end_headers()
            return
        env = {"GH_TOKEN": os.environ["FAKE_GITHUB_KEY"], "GITHUB_TOKEN": os.environ["FAKE_GITHUB_KEY"]}
        if mode == "ok":
            env["ANTHROPIC_API_KEY"] = os.environ["FAKE_PROVIDER_KEY"]
            env["UNDECLARED_NAME"] = "should-not-be-exported"
        body = json.dumps({"env": env}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.HTTPServer(("127.0.0.1", 0), Gateway)
with open(os.path.join(state, "port"), "w") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
FAKE_GATEWAY

FAKE_GATEWAY_TOKEN="$CRED_TOKEN" FAKE_ORDER_LOG="$ORDER_LOG" \
  FAKE_PROVIDER_KEY="$PROVIDER_KEY" FAKE_GITHUB_KEY="$GITHUB_KEY" \
  python3 "$GATEWAY_DIR/gateway.py" "$GATEWAY_DIR" &
GATEWAY_PID=$!
cleanup_gateway() {
  kill "$GATEWAY_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
}
for _ in $(seq 1 100); do
  [ -s "$GATEWAY_DIR/port" ] && break
  sleep 0.05
done
[ -s "$GATEWAY_DIR/port" ] || { cleanup_gateway; fail "the fake gateway did not start"; }
GATEWAY_URL="http://127.0.0.1:$(cat "$GATEWAY_DIR/port")/internal/v1/credentials"
gateway_requests() {
  if [ -f "$GATEWAY_DIR/requests.log" ]; then grep -c '' "$GATEWAY_DIR/requests.log"; else echo 0; fi
}

PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME4" \
  FM_HOME="$HOME4" \
  FIRSTMATE_SEED_DIR="$SEED_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  FM_HARNESS_SUPERVISION_INTERVAL=0.2 \
  FM_HARNESS_SUPERVISION_GRACE=3 \
  FM_READY_FILE="$TMP/ready4" \
  FM_TENANT_CREDENTIALS_URL="$GATEWAY_URL" \
  FM_TENANT_CREDENTIALS_TOKEN="$CRED_TOKEN" \
  FM_TENANT_CREDENTIAL_ENVS="ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN" \
  FM_TENANT_REQUIRED_ENV=ANTHROPIC_API_KEY \
  FM_TENANT_CREDENTIALS_RETRY_DELAY=1 \
  FM_TENANT_CREDENTIALS_RETRY_MAX=1 \
  FAKE_ORDER_LOG="$ORDER_LOG" \
  FAKE_HERDR_LOG="$HERDR_LOG4" \
  FAKE_HERDR_PANE_LOG="$PANE_LOG4" \
  FAKE_HERDR_SERVER_ENV="$SERVER_ENV4" \
  bash "$ENTRYPOINT" >"$TMP/ep4.out" 2>"$EP4_ERR" &
EP_PID=$!

# The gateway is down: the entrypoint retries and starts nothing meanwhile.
for _ in $(seq 1 100); do
  [ "$(gateway_requests)" -ge 2 ] && break
  sleep 0.1
done
[ "$(gateway_requests)" -ge 2 ] || { cleanup_gateway; fail "entrypoint did not retry a failed credential fetch"; }
grep -q '^server$' "$ORDER_LOG" && { cleanup_gateway; fail "the herdr server started before the credentials were fetched"; }
[ ! -e "$TMP/ready4" ] || { cleanup_gateway; fail "the pod reported ready while its credentials were missing"; }
grep -q "could not fetch this firstmate's credentials" "$EP4_ERR" \
  || { cleanup_gateway; fail "entrypoint did not report the failed fetch"; }

# The gateway answers without the provider key: refused, never a keyless harness.
printf 'keyless\n' > "$GATEWAY_DIR/mode"
for _ in $(seq 1 100); do
  grep -q 'refusing to start a keyless harness' "$EP4_ERR" && break
  sleep 0.1
done
grep -q 'refusing to start a keyless harness' "$EP4_ERR" \
  || { cleanup_gateway; fail "entrypoint accepted a delivery without the provider key"; }
grep -q '^server$' "$ORDER_LOG" && { cleanup_gateway; fail "the herdr server started on a keyless delivery"; }
[ ! -e "$TMP/ready4" ] || { cleanup_gateway; fail "the pod reported ready on a keyless delivery"; }

# The gateway delivers: the server starts after the fetch, with the keys.
printf 'ok\n' > "$GATEWAY_DIR/mode"
for _ in $(seq 1 100); do
  grep -q '^pane_run ' "$PANE_LOG4" 2>/dev/null && break
  kill -0 "$EP_PID" 2>/dev/null || break
  sleep 0.1
done
cleanup_gateway
grep -q '^pane_run ' "$PANE_LOG4" || fail "entrypoint never started the harness after the credentials arrived"
first_server=$(grep -n '^server$' "$ORDER_LOG" | head -1 | cut -d: -f1)
first_ok=$(grep -n '^fetch:ok$' "$ORDER_LOG" | head -1 | cut -d: -f1)
[ -n "$first_server" ] && [ -n "$first_ok" ] && [ "$first_ok" -lt "$first_server" ] \
  || fail "the herdr server did not start after the credential fetch"
if grep -q 'auth-bad' "$GATEWAY_DIR/requests.log"; then
  fail "entrypoint presented the wrong credential token"
fi
grep -q "^ANTHROPIC_API_KEY=$PROVIDER_KEY\$" "$SERVER_ENV4" \
  || fail "the delivered provider key did not reach the herdr server environment"
grep -q "^GH_TOKEN=$GITHUB_KEY\$" "$SERVER_ENV4" \
  || fail "the delivered GitHub token did not reach the herdr server environment"
grep -q "^GITHUB_TOKEN=$GITHUB_KEY\$" "$SERVER_ENV4" \
  || fail "the delivered GitHub token did not reach GITHUB_TOKEN"
if grep -q '^FM_TENANT_CREDENTIALS_TOKEN=' "$SERVER_ENV4"; then
  fail "the credential token leaked into the herdr server environment"
fi
if grep -q '^UNDECLARED_NAME=' "$SERVER_ENV4"; then
  fail "a credential under an undeclared name was exported"
fi
[ -e "$TMP/ready4" ] || fail "entrypoint did not mark the pod ready once the server ran"
for secret in "$CRED_TOKEN" "$PROVIDER_KEY" "$GITHUB_KEY"; do
  if grep -qF "$secret" "$EP4_ERR" "$TMP/ep4.out" "$HERDR_LOG4"; then
    fail "a credential or token was printed"
  fi
done

kill -TERM "$EP_PID" 2>/dev/null || true
wait "$EP_PID" 2>/dev/null || true
EP_PID=

# The URL without its token is a broken deployment: exit, never start keyless.
HOME5="$TMP/home5"
mkdir -p "$HOME5/bin" "$HOME5/config" "$HOME5/state" "$HOME5/data" "$HOME5/projects"
printf '#!/bin/sh\n' > "$HOME5/bin/fm-inbox.sh"
: > "$TMP/order5.log"
set +e
PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME5" \
  FM_HOME="$HOME5" \
  FIRSTMATE_SEED_DIR="$SEED_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  FM_TENANT_CREDENTIALS_URL="http://127.0.0.1:9/internal/v1/credentials" \
  FM_TENANT_REQUIRED_ENV=ANTHROPIC_API_KEY \
  FAKE_ORDER_LOG="$TMP/order5.log" \
  FAKE_HERDR_LOG="$TMP/herdr5.log" \
  FAKE_HERDR_PANE_LOG="$TMP/pane5.log" \
  FAKE_HERDR_SERVER_ENV="$TMP/server5.env" \
  bash "$ENTRYPOINT" >"$TMP/ep5.out" 2>"$TMP/ep5.err"
ep5_status=$?
set -e
[ "$ep5_status" -ne 0 ] || fail "entrypoint ran without its credential token"
grep -q '^server$' "$TMP/order5.log" && fail "the herdr server started without a credential token"
grep -q 'FM_TENANT_CREDENTIALS_TOKEN is empty' "$TMP/ep5.err" \
  || fail "entrypoint did not explain the missing credential token"

echo "ok"
