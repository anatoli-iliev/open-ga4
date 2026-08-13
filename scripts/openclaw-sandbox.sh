#!/usr/bin/env bash
# Run the `openclaw` CLI against a throwaway state directory.
#
# `openclaw plugins build|validate` boots enough of the runtime to run config
# doctor and state migrations. Against a real installation that can rewrite
# config and relocate state files. This wrapper redirects HOME and the state
# directory into ./.sandbox so a plugin build can never touch the developer's
# own OpenClaw setup.
#
#   ./scripts/openclaw-sandbox.sh plugins validate --entry ./dist/index.js
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox="${OPENCLAW_SANDBOX_DIR:-$root/.sandbox}"

mkdir -p "$sandbox/home" "$sandbox/state"

HOME="$sandbox/home" \
XDG_CONFIG_HOME="$sandbox/home/.config" \
XDG_STATE_HOME="$sandbox/home/.local/state" \
XDG_DATA_HOME="$sandbox/home/.local/share" \
OPENCLAW_STATE_DIR="$sandbox/state" \
OPENCLAW_CONFIG_DIR="$sandbox/home/.openclaw" \
  exec openclaw "$@"
