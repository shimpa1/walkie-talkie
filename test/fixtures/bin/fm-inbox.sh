#!/usr/bin/env bash
# Test double for firstmate's bin/fm-inbox.sh. Implements just enough of the
# documented contract to exercise the service against a real child process
# without depending on a live firstmate home.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/.."
STATE="${FM_HOME:?FM_HOME must be set}/state"
mkdir -p "$STATE/notes"

record_argv() {
  printf '%s\0' "$@" > "$STATE/argv.bin"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  ready)
    cat "$FIXTURES/ready.json"
    ;;
  receipts)
    after=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --after)
          after="${2:-}"
          shift 2
          ;;
        *) shift ;;
      esac
    done
    template="$(cat "$FIXTURES/receipts.json")"
    printf '%s\n' "${template/__AFTER__/$after}"
    ;;
  note)
    record_argv note "$@"
    request_id=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --request-id)
          request_id="${2:-}"
          shift 2
          ;;
        --json|-)
          shift
          ;;
        *) shift ;;
      esac
    done
    body="$(cat)"
    if [ -n "${FM_TEST_FAIL_NOTE:-}" ]; then
      printf 'fm-inbox: simulated failure\n' >&2
      exit 1
    fi
    note_file="$STATE/notes/$request_id"
    if [ -f "$note_file" ]; then
      outcome="replay"
    else
      printf '%s' "$body" > "$note_file"
      outcome="created"
    fi
    printf '{"schema":"fm-inbox-note.v1","outcome":"%s","note_id":"note-%s","request_id":"%s","saved":true,"announced":true,"path":"%s"}\n' \
      "$outcome" "$request_id" "$request_id" "$note_file"
    ;;
  *)
    printf 'fm-inbox: unsupported test subcommand: %s\n' "$cmd" >&2
    exit 1
    ;;
esac
