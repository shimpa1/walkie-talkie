#!/usr/bin/env bash
# Test double for firstmate's bin/fm-bearings-snapshot.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/.."

cat "$FIXTURES/bearings.json"
