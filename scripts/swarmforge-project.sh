#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.swarmforge"
RUNTIME_FILE="$STATE_DIR/runtime.edn"

usage() {
  cat <<'EOF'
Usage: scripts/swarmforge-project.sh <command> [argument]

Commands:
  start [auto|ghostty|current]  Start the configured four-role swarm.
  status                        List Herdr workspaces for this project.
  attach [role]                 Attach to Herdr's integrated view, or one role.
  stop                          Stop the project swarm and handoff daemon.
EOF
}

ensure_clean_baseline() {
  if [[ "${SWARMFORGE_ALLOW_DIRTY:-0}" == "1" ]]; then
    return
  fi

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    cat >&2 <<'EOF'
SwarmForge should start from a clean, committed baseline.
Resolve the output of `git status --short`, or set SWARMFORGE_ALLOW_DIRTY=1
when you have deliberately chosen to start with local changes.
EOF
    git -C "$ROOT_DIR" status --short >&2
    exit 1
  fi
}

start_swarm() {
  local surface="${1:-auto}"
  local terminal_backend=""
  local terminal_type="${TERM:-xterm-256color}"

  ensure_clean_baseline

  case "$surface" in
    auto)
      ;;
    ghostty)
      terminal_backend="ghostty"
      terminal_type="${SWARMFORGE_TERM:-xterm-256color}"
      ;;
    current)
      terminal_backend="none"
      ;;
    *)
      printf 'Unknown terminal surface: %s\n' "$surface" >&2
      usage >&2
      exit 2
      ;;
  esac

  cd "$ROOT_DIR"
  if [[ -n "$terminal_backend" ]]; then
    exec env TERM="$terminal_type" SWARMFORGE_RUNTIME=herdr SWARMFORGE_TERMINAL="$terminal_backend" ./swarm
  fi
  exec env SWARMFORGE_RUNTIME=herdr ./swarm
}

runtime_value() {
  local expression="$1"
  ROOT_DIR="$ROOT_DIR" EXPRESSION="$expression" bb -e '
    (require (quote clojure.edn))
    (let [state (clojure.edn/read-string (slurp (str (System/getenv "ROOT_DIR") "/.swarmforge/runtime.edn")))]
      (println (get-in state (clojure.edn/read-string (System/getenv "EXPRESSION")))))'
}

show_status() {
  if [[ ! -s "$RUNTIME_FILE" ]]; then
    printf 'No active project swarm. Start one with `pnpm swarm:start`.\n'
    return 0
  fi

  local session
  session="$(runtime_value '[:instance]')"
  printf 'Herdr session: %s\n' "$session"
  herdr --session "$session" workspace list
}

attach_role() {
  local role="${1:-specifier}"
  case "$role" in
    integrated|specifier|coder|refactorer|architect)
      ;;
    *)
      printf 'Unknown SwarmForge role: %s\n' "$role" >&2
      exit 2
      ;;
  esac

  if [[ ! -s "$RUNTIME_FILE" ]]; then
    printf 'No active project swarm. Start one with `pnpm swarm:start`.\n' >&2
    exit 1
  fi

  local session terminal_id
  session="$(runtime_value '[:instance]')"
  if [[ "$role" == "integrated" || -z "$role" ]]; then
    exec herdr --session "$session"
  fi
  terminal_id="$(runtime_value "[:roles \"$role\" :handle :terminal-id]")"
  exec herdr --session "$session" terminal attach "$terminal_id"
}

stop_swarm() {
  if [[ ! -s "$RUNTIME_FILE" ]]; then
    printf 'No active project swarm to stop.\n'
    return 0
  fi

  local cleanup="$ROOT_DIR/swarmforge/scripts/swarm-cleanup.sh"
  if [[ -x "$cleanup" ]]; then
    SWARMFORGE_TERMINAL_BACKEND=none "$cleanup" "$ROOT_DIR" "$STATE_DIR/window-ids"
  else
    printf 'SwarmForge cleanup helper is missing: %s\n' "$cleanup" >&2
    exit 1
  fi

  printf 'SwarmForge stopped. Worktrees and durable handoff state were preserved.\n'
}

case "${1:-}" in
  start)
    start_swarm "${2:-auto}"
    ;;
  status)
    show_status
    ;;
  attach)
    attach_role "${2:-specifier}"
    ;;
  stop)
    stop_swarm
    ;;
  help|-h|--help|"")
    usage
    ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac

