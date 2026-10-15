# Browser resource recovery

The Linux Scenario Runtime reconciles browser resources under the worktree's
exclusive Turn before a mutating dispatch proceeds. `job` and `status` remain
read-only. Recovery is not a daemon: after a killed CLI, run `auto-qa cleanup`
from its Git worktree. Repeating its submission or abandoning its Run also
triggers reconciliation.

## Standalone command

`auto-qa cleanup` needs no Run ID or Base URL. It acquires the same exclusive
worktree lock as a Run Turn, reconciles registered runtime resources, releases
the lock, and returns the usual versioned JSON envelope with
`result: { "status": "clean" }`. Repeating it is safe when nothing remains.
An unused worktree gets its local state store initialized, but no Run is created.

A live owner causes `RunBusyError`; cleanup does not interrupt it. Cleanup does
not contact or stop the Target Application, advance a Run, create a Finding,
consume an execution budget, or delete finalized evidence. An interrupted Run therefore
still shows its interrupted workflow phase until a subsequent mutating Run
command performs workflow recovery. Existing Jobs and completed reports remain
unchanged. This command requires a readable state store to acquire the lock;
recovering from a damaged state store is not part of this implementation.

## Ownership and cleanup

Before launch, the runtime atomically writes registry version 2 with the Run,
random launch token, canonical browser and launcher executable paths, and owner
PID, boot ID, and process start ticks. A per-launch executable shell shim starts
the packaged Node launcher using the current Node executable. Playwright starts
this launcher as a separate Linux session and process-group leader.

The launcher durably records its own identity in
`.browser-launch-<token>.json` before spawning Chromium in that same group. This
single-writer record is separate from `registry.json`, so a late launcher cannot
overwrite a recovering CLI's registry checkpoint. After recording its identity,
it rechecks its original owner before starting Chromium. A dead owner prevents
new browser work. Playwright's protocol pipes pass through to Chromium. When
Chromium exits, the launcher terminates its group, including itself and any
remaining descendants. It is an Attempt-scoped process, not a background daemon.

Both launcher and browser receive the launch token as an argument. Recovery can
use the recorded launcher when Chromium's leader has died, or the marked browser
when the launcher has died. Once Playwright launch returns, the CLI checkpoints
all current process identities before executing the Scenario Script.

Discovery checks the same user, canonical executable, session, group, and stable
process incarnation. It records current group members before signaling. A live
group leader must still match its token, executable, and any recorded identity.
A surviving recorded member can identify the group when its leader has died.
No process environments are read or stored. Successful cleanup removes the
owned disposable workspace, launcher shim, launch record, and registry, but does
not delete finalized evidence.

Cleanup requests SIGTERM, polls for roughly half a second, then escalates to
SIGKILL and polls for roughly two more seconds. Each signal rechecks the boot
and process identity. It never selects processes by name or a PID alone.
Normal browser-context close has a two-second limit; failure falls back to
registered-resource cleanup. These cleanup intervals are
excluded from the active-work budget.

Registry updates use write, fsync, rename, and directory fsync. Cleanup retains
the registry on an ownership mismatch, unreadable or malformed state, or a
termination timeout. A failed cleanup does not prevent a later retry from
recovering the interrupted Attempt. The Scenario is not replayed, and repeated
submission returns the same classification Job.

Zombie processes are already terminated and are not treated as live browser
work. Their parent or the operating system must reap their process-table entries.

## Disposable files

Each Attempt gets a private `.auto-qa/runtime/<launch-token>/` directory. The
runtime journals its intent before creating this directory and checkpoints its
device and inode before adding contents. Chromium's profile, Playwright's
temporary artifacts, and unpublished Evidence Bundle files all live beneath it.
The persistent-context launch API supplies an explicit profile path; profiles
are fresh for every Attempt, never shared or reused as Auth Profiles.

Successful evidence publication atomically renames the staged bundle into
`runs/<run-id>/scenarios/<scenario-id>/attempt-<n>/`, then fsyncs both containing
directories. Finalized bundles are outside the disposable workspace and survive
cleanup, including when a later Scenario crashes.

Only after owned processes have stopped does cleanup recursively remove the
registered workspace. It checks directory ownership and the recorded device and
inode, and refuses replacement workspace directories or symlinks at the
workspace and its checked parents. Symlinks inside the workspace are unlinked
without following their targets. A filesystem failure retains the registry for retry; a missing
workspace is safe to retry. Cleanup does not sweep `/tmp`, guess ownership from
directory names, or expire Run evidence. These checks are not a security boundary
against a malicious same-user process racing filesystem operations.

## Verification

Run `fnm exec --using 22 pnpm browser`. The packed-CLI tests stop an owned browser
group before killing the CLI, preventing pipe closure from hiding missing
cleanup. They cover repeated recovery, an unrelated live browser, an externally
owned QA Lab, malformed registries, mismatched launch tokens and start ticks,
an intent-only registry, and surviving children after their leader dies. Launch
crash tests stop the CLI immediately after it spawns the launcher and verify
that it has not checkpointed Chromium identities. They then kill the CLI and
either the browser leader or launcher. They prove that cleanup removes the
descendants, preserves an unrelated browser using the same executable with a
different token, and rejects a mismatched registry token. Killing both witnesses
before a browser snapshot proves that unidentifiable live members block cleanup
without signals or registry loss.
Use `pnpm browser -t launch-` to run just these launch-window cases through the
same build-and-pack gate.

The same gate verifies profile and partial-evidence removal, finalized evidence
preservation, nested symlink target preservation, and refusal of symlinked or
replaced workspaces followed by a successful retry after restoration. Run these
cases with `pnpm browser -t 'standalone-cleanup|workspace-'`.

## Remaining limits

- The full per-checkpoint crash matrix is not implemented yet.
- An intent-only registry with no verifiable live process still fails closed.
  This includes a crash before the launcher records its identity. If both the
  launcher and browser leader die before the CLI's first snapshot, surviving
  unmarked descendants also cause cleanup to fail closed. Absence of an
  ownership witness is not permission to signal a process or discard its record.
  Since reconciliation precedes every mutating command, this also blocks
  `start`, `submit`, and abandonment in that worktree. `job` and `status` remain
  readable. Preserve the registry and evidence for ownership diagnosis; there
  is no force-delete or force-kill recovery command. Do not remove the registry
  to make an ambiguous resource appear clean.
- A crash between workspace creation and its identity checkpoint leaves an
  unproven directory. Cleanup retains the registry and refuses to delete it.
- Run Retention is separate from disposable workspace cleanup.
- This implementation uses Linux `/proc` and process groups. Other operating
  systems need their own ownership and signaling adapter.
