#!/usr/bin/env bash
# Exercise deploy/kubernetes/firstmate/entrypoint.sh against a fake herdr so the
# harness-start and credential-environment paths are verified without a cluster
# and without driving any real Herdr lifecycle. Prints "ok" on success.
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
: > "$HERDR_LOG"
: > "$PANE_LOG"

# Pre-seed the home so the entrypoint skips copying the baked distro.
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/config" "$HOME_DIR/state" "$HOME_DIR/data" "$HOME_DIR/projects" "$FAKE_BIN"
printf '#!/bin/sh\n' > "$HOME_DIR/bin/fm-inbox.sh"

cat > "$FAKE_BIN/herdr" <<'FAKE_HERDR'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
printf '%s\n' "$*" >> "${FAKE_HERDR_LOG:?}"
case "${args[0]:-} ${args[1]:-}" in
  "status --json")
    printf '{"client":{"version":"0.9.0","protocol":22},"server":{"running":true,"protocol":22,"compatible":true}}\n'
    ;;
  "workspace list")
    printf '{"result":{"workspaces":[]}}\n'
    ;;
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"w1","label":"firstmate"},"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}\n'
    ;;
  "pane list")
    printf '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}\n'
    ;;
  "agent get")
    printf '{"error":{"code":"agent_not_found","message":"no agent"}}\n'
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

HARNESS_CMD="OPENCODE_CONFIG_CONTENT='{\"permission\":{\"*\":\"allow\"}}' opencode"

PATH="$FAKE_BIN:$PATH" \
  HOME="$HOME_DIR" \
  FM_HOME="$HOME_DIR" \
  HERDR_SESSION=firstmate \
  FM_HARNESS_COMMAND="$HARNESS_CMD" \
  DEEPSEEK_API_KEY=test-deepseek-key \
  FAKE_HERDR_LOG="$HERDR_LOG" \
  FAKE_HERDR_PANE_LOG="$PANE_LOG" \
  FAKE_HERDR_SERVER_ENV="$SERVER_ENV" \
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
grep -q 'deepseek_api_key=test-deepseek-key' "$PANE_LOG" \
  || fail "harness credentials did not reach the herdr pane call"
grep -q '^DEEPSEEK_API_KEY=test-deepseek-key$' "$SERVER_ENV" \
  || fail "harness credentials did not reach the herdr server environment"

echo "ok"
