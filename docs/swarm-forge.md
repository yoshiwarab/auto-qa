# SwarmForge Four-Role Workflow

This repository uses the local Herdr-backed SwarmForge fork for implementation:

```text
user intent
  -> specifier writes one Gherkin tracer bullet and asks for approval
  -> coder implements it with red/green TDD
  -> refactorer improves structure and property coverage
  -> architect verifies boundaries and performs deeper hardening
  -> specifier reviews and merges the completed slice
```

The role configuration and project-specific prompts are committed under
`swarmforge/`. Runtime state lives in ignored `.swarmforge/`, role worktrees in
ignored `.worktrees/`, and shared runtime scripts in ignored
`swarmforge/scripts/`.

## Prerequisites

The machine needs Git, FNM with Node 22, pnpm, Babashka, Herdr 0.7.4 or newer,
and an authenticated Codex CLI. The launcher prefers the local fork at
`/home/dev/src/swarm-forge`; when it is absent, it downloads the configured
`herdr-runtime` branch from `yoshiwarab/swarm-forge`.

## Start

SwarmForge requires a clean, committed baseline.

From an ordinary SSH terminal:

```bash
cd /home/dev/src/auto-qa
pnpm swarm:start:terminal
```

That runs the normal `./swarm` command with:

```text
SWARMFORGE_RUNTIME=herdr
SWARMFORGE_TERMINAL=none
```

and attaches Herdr's integrated project view in the current terminal. To let
the launcher choose its presentation surface, use:

```bash
pnpm swarm:start
```

For Ghostty:

```bash
pnpm swarm:start:ghostty
```

The first role is the specifier in the main checkout. It reads the existing
architecture and begins with Slice 1 from `docs/implementation-slices.md`. The
specifier must ask for user approval before committing a feature and handing it
to the coder.

## Observe and attach

```bash
pnpm swarm:status
pnpm swarm:attach
pnpm swarm:attach:specifier
pnpm swarm:attach:coder
pnpm swarm:attach:refactorer
pnpm swarm:attach:architect
```

Detach from Herdr with `Ctrl-b q`; this leaves the agents, handoff daemon, and
sleep inhibitor running.

## Stop

```bash
pnpm swarm:stop
```

Stopping preserves role worktrees and durable handoff state. Do not use
`herdr session stop` merely to detach because that terminates the managed pane
processes.

## Local overrides

- `SWARMFORGE_SCRIPTS_SOURCE` changes the local fork directory.
- `SWARMFORGE_SCRIPTS_BRANCH` changes the downloaded branch.
- `SWARMFORGE_SCRIPTS_URL` changes the fallback archive.
- `SWARMFORGE_ALLOW_DIRTY=1` deliberately bypasses the clean-baseline guard.
- `SWARMFORGE_TERM` overrides the Ghostty compatibility terminal type.

