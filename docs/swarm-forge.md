# Legacy SwarmForge four-role workflow

SwarmForge is no longer the default development workflow. Use the Git hooks
and commands in [repository verification](verification.md). No role handoff is
required. The launchers and configuration below remain available for existing
sessions; installing Git hooks does not stop those sessions.

The legacy local Herdr-backed SwarmForge fork uses this sequence:

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
`/home/dev/src/swarm-forge`. Its fallback is configurable, but it must point at
a published archive that contains the Herdr runtime.

## Start

SwarmForge requires a clean, committed baseline.

From an ordinary SSH terminal:

```bash
cd /home/dev/src/auto-qa
fnm exec --using 22 pnpm swarm:start:terminal
```

That runs the normal `./swarm` command with:

```text
SWARMFORGE_RUNTIME=herdr
SWARMFORGE_TERMINAL=none
```

and attaches Herdr's integrated project view in the current terminal. To let
the launcher choose its presentation surface, use:

```bash
fnm exec --using 22 pnpm swarm:start
```

For Ghostty:

```bash
fnm exec --using 22 pnpm swarm:start:ghostty
```

The first role is the specifier in the main checkout. It reads the existing
architecture and begins with Slice 1 from `docs/implementation-slices.md`. The
specifier must ask for user approval before committing a feature and handing it
to the coder.

## Observe and attach

```bash
fnm exec --using 22 pnpm swarm:status
fnm exec --using 22 pnpm swarm:attach
fnm exec --using 22 pnpm swarm:attach:specifier
fnm exec --using 22 pnpm swarm:attach:coder
fnm exec --using 22 pnpm swarm:attach:refactorer
fnm exec --using 22 pnpm swarm:attach:architect
```

Detach from Herdr with `Ctrl-b q`; this leaves the agents, handoff daemon, and
sleep inhibitor running.

## Stop

```bash
fnm exec --using 22 pnpm swarm:stop
```

Stopping preserves role worktrees and durable handoff state. Do not use
`herdr session stop` merely to detach because that terminates the managed pane
processes.

`./close-swarm` provides the same explicit stop path when package scripts are
unavailable.

## Local overrides

- `SWARMFORGE_SCRIPTS_SOURCE` changes the local fork directory.
- `SWARMFORGE_SOURCE_DIR` is the preferred name for the same local override.
- `SWARMFORGE_SCRIPTS_BRANCH` changes the downloaded branch.
- `SWARMFORGE_SCRIPTS_URL` changes the fallback archive.
- `SWARMFORGE_ALLOW_DIRTY=1` deliberately bypasses the clean-baseline guard.
- `SWARMFORGE_RESTART=1` deliberately replaces a recorded runtime.
- `SWARMFORGE_TERM` overrides the Ghostty compatibility terminal type.
