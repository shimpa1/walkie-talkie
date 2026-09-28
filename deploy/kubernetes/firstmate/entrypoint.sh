#!/usr/bin/env bash
#
# Entrypoint for the firstmate Kubernetes runtime. It seeds the persistent
# firstmate home from the baked distro on first start, keeps the herdr backend
# explicit, and then runs the herdr headless server for the configured named
# session so the pod stays alive and the session stays attachable.
set -euo pipefail

HOME_DIR="${FM_HOME:-/home/firstmate}"
SEED_DIR="${FIRSTMATE_SEED_DIR:-/opt/firstmate}"
SESSION="${HERDR_SESSION:-firstmate}"

log() { printf 'firstmate-entrypoint: %s\n' "$*" >&2; }

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
  printf '%s\n' "${FM_BACKEND:-herdr}" > "$HOME_DIR/config/backend"
fi

# Allow seeding to run on its own (for an initContainer or an image test)
# without starting the herdr server.
if [ "${FIRSTMATE_SEED_ONLY:-0}" = "1" ]; then
  log "seed-only mode: home is ready at $HOME_DIR"
  exit 0
fi

# 3. Run the herdr headless server as the long-lived process. firstmate's
#    adapter reuses a running server for this session, and you attach with
#    `herdr session attach <session>`.
log "starting herdr server for session '$SESSION'"
exec herdr server --session "$SESSION"
