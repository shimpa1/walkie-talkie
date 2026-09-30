#!/usr/bin/env bash
# Exercise deploy/kubernetes/firstmate/entrypoint.sh against a fake herdr so the
# harness-start, harness-supervision, and credential-environment paths are
# verified without a cluster and without driving any real Herdr lifecycle.
# Prints "ok" on success.
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
    elif grep -q '^workspace create' "${FAKE_HERDR_LOG:?}" 2>/dev/null; then
      printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"firstmate"}]}}\n'
    else
      printf '{"result":{"workspaces":[]}}\n'
    fi
    ;;
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"w1","label":"firstmate"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}\n'
    ;;
  "pane list")
    printf '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}\n'
    ;;
  "agent get")
    # A transient transport failure must be reported as a failed read, never as
    # agent_not_found (which is an authoritative "the harness is gone").
    if [ -e "${FAKE_HERDR_READ_FAIL:-/nonexistent}" ]; then
      printf '{"error":{"code":"server_not_running","message":"transient"}}\n' >&2
      exit 1
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
  "pane run")
    printf 'pane_run pane=%s command=%s\n' "${args[2]:-}" "${args[3]:-}" >> "${FAKE_HERDR_PANE_LOG:?}"
    printf 'pane_run deepseek_api_key=%s\n' "${DEEPSEEK_API_KEY:-}" >> "${FAKE_HERDR_PANE_LOG:?}"
    ;;
  "server "*|"server")
    env | sort > "${FAKE_HERDR_SERVER_ENV:?}"
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
grep -q 'deepseek_api_key=test-deepseek-key' "$PANE_LOG" \
  || fail "harness credentials did not reach the herdr pane call"
grep -q '^DEEPSEEK_API_KEY=test-deepseek-key$' "$SERVER_ENV" \
  || fail "harness credentials did not reach the herdr server environment"

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

echo "ok"
