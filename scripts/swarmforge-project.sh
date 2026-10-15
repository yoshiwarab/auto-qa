#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.swarmforge"
RUNTIME_FILE="$STATE_DIR/runtime.edn"

usage() {
  cat <<'EOF'
Usage: scripts/swarmforge-project.sh <command> [argument]

Commands:
  start [auto|ghostty|current]  Start the configured four-role swarm in Herdr.
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

  if [[ -s "$RUNTIME_FILE" && "${SWARMFORGE_RESTART:-0}" != "1" ]]; then
    printf 'A project swarm is already recorded:\n' >&2
    show_status >&2 || true
    cat >&2 <<'EOF'
Attach with `pnpm swarm:attach` or stop it with `pnpm swarm:stop`.
Set SWARMFORGE_RESTART=1 only when you intentionally want the launcher to
replace the recorded swarm.
EOF
    exit 1
  fi

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
  exec env -u SWARMFORGE_TERMINAL SWARMFORGE_RUNTIME=herdr ./swarm
}

runtime_value_at() {
  local edn_path="$1"
  if ! command -v bb >/dev/null 2>&1; then
    printf 'Babashka is required to read SwarmForge runtime state.\n' >&2
    exit 1
  fi
  ROOT_DIR="$ROOT_DIR" EDN_PATH="$edn_path" bb -e '
    (require (quote clojure.edn))
    (let [state (clojure.edn/read-string (slurp (str (System/getenv "ROOT_DIR") "/.swarmforge/runtime.edn")))]
      (println (get-in state (clojure.edn/read-string (System/getenv "EDN_PATH")))))'
}

show_status() {
  if [[ ! -s "$RUNTIME_FILE" ]]; then
    printf 'No active project swarm. Start one with `pnpm swarm:start`.\n'
    return 0
  fi

  local kind session
  kind="$(runtime_value_at '[:kind]')"
  session="$(runtime_value_at '[:instance]')"
  if [[ -z "$session" || "$session" == "nil" ]]; then
    printf 'SwarmForge runtime state has no session identifier. Run `pnpm swarm:stop` to clear it.\n' >&2
    return 1
  fi
  if [[ "$kind" == ":tmux" ]]; then
    printf 'Legacy tmux swarm: %s\n' "$session"
    if ! tmux -S "$session" list-sessions; then
      printf 'The legacy tmux state is stale. Run `pnpm swarm:stop` to clear it.\n' >&2
      return 1
    fi
    return
  fi
  printf 'Herdr session: %s\n' "$session"
  herdr --session "$session" workspace list
}

attach_role() {
  local role="${1:-integrated}"
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

  local kind session terminal_id
  kind="$(runtime_value_at '[:kind]')"
  session="$(runtime_value_at '[:instance]')"
  if [[ -z "$session" || "$session" == "nil" ]]; then
    printf 'SwarmForge runtime state has no session identifier. Run `pnpm swarm:stop` to clear it.\n' >&2
    exit 1
  fi
  if [[ "$kind" == ":tmux" ]]; then
    local tmux_session
    if [[ "$role" == "integrated" ]]; then
      role="specifier"
    fi
    tmux_session="$(runtime_value_at "[:roles \"$role\" :handle :session]")"
    if [[ -z "$tmux_session" || "$tmux_session" == "nil" ]]; then
      printf 'No tmux session is recorded for role %s.\n' "$role" >&2
      exit 1
    fi
    exec tmux -S "$session" attach-session -t "$tmux_session"
  fi
  if [[ "$role" == "integrated" ]]; then
    exec herdr --session "$session"
  fi
  terminal_id="$(runtime_value_at "[:roles \"$role\" :handle :terminal-id]")"
  if [[ -z "$terminal_id" || "$terminal_id" == "nil" ]]; then
    printf 'No Herdr terminal is recorded for role %s.\n' "$role" >&2
    exit 1
  fi
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
    attach_role "${2:-integrated}"
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
