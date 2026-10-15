# Auto-QA compared with Expect

## Scope and source snapshot

This report compares:

- Auto-QA at local commit `afb74c546c4c68448ae46a1c6e26a80f30be8b3d`;
- Auto-QA's documented V1 architecture and implementation plan; and
- Expect's `main` branch at commit
  [`39e97500725783490136a8fc7040e6e4dbaafa44`](https://github.com/millionco/expect/tree/39e97500725783490136a8fc7040e6e4dbaafa44),
  committed 2026-04-10.

All Expect links below are pinned to that commit. Auto-QA has no configured Git
remote in this checkout, so its sources are linked within this repository.

## Executive summary

Expect and Auto-QA start from the same product insight—give a coding agent Git
context and a real Playwright browser—but they put the trust boundary in
opposite places.

**Expect is primarily agent guidance plus a browser toolbox.** Its recommended
surface is now an installed `/expect` skill used by the developer's existing
coding agent together with a standalone browser MCP server. The repository also
retains an older integrated CLI/SDK supervisor that starts a selected
coding-agent provider and lets it plan and execute adaptively in one streaming
interaction. In that integrated path, the agent invents steps while it works
and reports their status through text markers.

**Auto-QA is a durable workflow coordinator.** It leaves model hosting outside
the process, asks an external coding agent for typed inputs at explicit Jobs,
atomically accepts a complete Scenario plan, freezes each Playwright Scenario
Script, and executes it behind a narrow runtime boundary. The planned system
persists every workflow decision and side-effect checkpoint, classifies
nonpassing Attempts before remediation, and can recover honestly after a
process crash.

The concise version is:

| | Expect | Auto-QA |
| --- | --- | --- |
| Primary optimization | Reach and immediate autonomous QA | Enforcement, auditability, and crash consistency |
| Agent relationship | Preferred skill uses the host agent; integrated supervisor launches a chosen provider | External agent answers typed Jobs |
| Planning | Adaptive, in-band, during execution | Up-front, atomic, validated, and frozen |
| Browser authority | Agent receives `page`, `context`, `browser`, and arbitrary Playwright execution | Workflow sees only a `ScenarioRuntime`; accepted local code is the browser program |
| Run state | Mostly an in-memory stream plus final artifacts/saved flows | SQLite-backed durable state, operation journal, and Turn ownership |
| Failure meaning | Agent directly marks a step passed/failed/skipped | A failed/interrupted Attempt becomes a Finding that must be classified |
| Product surface | Skill, MCP server, deprecated TUI, headless CLI, watch mode, SDK, GitHub integration | Machine-oriented CLI now; provider-neutral workflow and bundles planned |

Expect currently has much more product surface and richer browser inspection.
Auto-QA's planned differentiators are not more browser tools; they are stronger
workflow semantics, failure provenance, permissions, recovery, and evidence
integrity.

## What is actually implemented in Auto-QA today

The V1 documents are a destination, not a description of the whole current
binary. The current code is roughly the protocol/durability foundation plus the
passing Slice 2 path:

- The CLI implements `start`, `job`, `status`, `submit`, and `runs abandon`
  with versioned JSON envelopes
  ([`src/cli.ts`](../../src/cli.ts),
  [`src/cliProtocol.ts`](../../src/cliProtocol.ts)).
- A required Base URL is checked for reachability, Git changes are inspected,
  and a durable `generate-plan` Job is stored
  ([`src/cliApplication.ts`](../../src/cliApplication.ts),
  [`src/gitChangeInspector.ts`](../../src/gitChangeInspector.ts)).
- SQLite stores Runs, operations, Jobs, events, Scenarios, Script Version 0,
  Attempts, a fenced Turn lock, and active-work limits
  ([`src/sqliteRunStoreSchema.ts`](../../src/sqliteRunStoreSchema.ts)).
- Plan submission is atomic, bounded, and idempotent by canonical payload hash.
  Mutating Scenarios are currently rejected unconditionally
  ([`src/planValidation.ts`](../../src/planValidation.ts),
  [`src/workflowEngine.ts`](../../src/workflowEngine.ts)).
- Accepted scripts run sequentially in managed Chromium through
  `ScenarioRuntime`; the current real adapter creates a temporary evidence
  directory, writes only `result.json` and `manifest.json` for a passing
  Attempt, promotes it atomically, and performs normal browser cleanup
  ([`src/scenarioRuntime.ts`](../../src/scenarioRuntime.ts),
  [`src/playwrightScenarioRuntime.ts`](../../src/playwrightScenarioRuntime.ts)).
- The current state machine has only the straight path
  `inspectingChanges -> awaitingAgent -> executingScenarios -> reporting ->
  completed`, plus abandonment
  ([`src/workflowMachine.ts`](../../src/workflowMachine.ts)). A Scenario runtime
  error still leaves the dispatch as an error; it does not yet become a
  persisted Finding or enter a classification/retry loop.
- The current reporter writes a minimal passing report only
  ([`src/fileRunReporter.ts`](../../src/fileRunReporter.ts)).

Consequently, Auto-QA does **not yet implement** the planned failure and
reliability loop, full checkpoint crash reconciliation, authentication,
application remediation, source-drift fencing, rich evidence, Review Bundles,
retention commands, or CI packaging. Those are explicitly sequenced as Slices
3–7 in [`implementation-slices.md`](../implementation-slices.md).

This matters throughout the rest of the comparison: “Auto-QA current” and
“Auto-QA V1” are different columns.

At this snapshot the local verification gates pass: the fast suite is 77/77,
the dedicated browser gate is 2/2, and typecheck and lint complete
successfully. That establishes the narrow tracer bullet; it does not make the
later slices present.

## The two control loops

### Expect's preferred path: skill plus browser MCP

Expect is in an architectural transition. Its integrated Ink UI explicitly
warns that the TUI is deprecated in favor of `/expect`
([TUI warning](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/apps/cli/src/components/app.tsx#L158-L166)).
In the preferred path, the installed skill governs the already-running host
agent, recommends delegating browser verification to a subagent, and gives that
subagent the full `open -> interact -> audit -> close` lifecycle
([skill workflow](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/expect-skill/README.md#L20-L38)).
Expect supplies the browser capabilities and guidance; the host agent's task
machinery owns the overall workflow.

### Expect's integrated path: one autonomous streaming agent turn

Expect's public description says it reads Git changes, generates a test plan,
runs a real browser, and lets the surrounding agent fix and rerun
([README](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/apps/cli/README.md#L10-L33)).
At the pinned commit, its actual supervisor is even more direct:

1. Gather the current branch, main branch, changed files, a diff preview, and
   recent commits.
2. Build a large QA system prompt and execution prompt.
3. Create an initially empty synthetic `TestPlan`.
4. Start a selected coding-agent process through its ACP adapter, injecting the
   Expect browser MCP environment.
5. Fold agent text and tool updates into an in-memory `ExecutedTestPlan` until
   the agent reports completion.

That flow is visible in
[`Executor.execute`](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/executor.ts#L83-L248).
The initial plan has no steps and is explicitly labeled “Direct execution”
([lines 155–175](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/executor.ts#L155-L175)).
Steps appear when the agent emits `STEP_START`, `STEP_DONE`,
`ASSERTION_FAILED`, and related marker lines; Expect parses those strings into
events
([marker parser](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/models.ts#L632-L683))
and mutates the in-memory step list
([event folding](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/models.ts#L895-L1005)).

So, at this commit, “test plan” does not mean an accepted, complete pre-run
artifact. It means the structured view reconstructed while the agent explores.
The README's statement that CI “auto-approves the plan” appears to describe an
older or intended flow, not the current executor.

This architecture gives the agent excellent feedback bandwidth. It can inspect
the current ARIA tree, try an interaction, discover a missing prerequisite,
seed data, change its plan, run a shell healthcheck, and add a newly discovered
step without a separate protocol round trip. Expect's prompt deliberately asks
for adjacent flows, negative cases, data seeding, responsive checks, and
cross-cutting coverage
([coverage and execution rules](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L119-L189)).

The cost is that plan shape, execution, evidence interpretation, and verdict
are all produced by the same agent turn. The structured status protocol is
still in-band text, and the full evolving Run is not an authoritative
restartable journal. In the preferred skill path, these concerns live in the
host agent's conversation and delegated task instead, but they remain
non-durable from Expect's perspective.

### Auto-QA: multiple durable Turns around frozen work

Auto-QA's intended loop is split across explicit input boundaries:

1. `start` persists Run policy and Git context.
2. Auto-QA publishes a typed `generate-plan` Job.
3. An external agent submits the whole plan.
4. Auto-QA validates it atomically and freezes Scenario Script Version 0.
5. The runtime executes Scenarios sequentially and stores an Attempt for the
   exact Script Version.
6. New nonpassing Attempts become Findings in one atomic
   `classify-findings` Job.
7. Classification routes bounded test-script revision, explicit rerun,
   reporting, or opt-in application remediation.
8. A completed Run receives a separate outcome and becomes immutable.

The intended loop and boundaries are documented in
[`system-overview.md`](../system-overview.md). Its public workflow interface is
only `dispatch`, `getPendingJob`, and `getStatus`; Commander, stdout, and any
specific agent remain outside the engine.

This is slower to adapt than Expect's single live agent loop. In exchange,
Auto-QA can answer questions Expect generally cannot after a crash or a later
review: Which exact script bytes ran? Was this a new script or another Attempt?
Was a rerun explicitly approved? Which failure authorized source edits? Had the
active-work budget already been partly consumed? Did a side effect begin before
the process died?

## Major architectural differences

### 1. Provider-neutral workflow versus skill-hosted or embedded agent

Expect supports a useful set of agent backends—Claude, Codex, Copilot, Gemini,
Cursor, OpenCode, Droid, and Pi—through one `Agent` stream interface and ACP
layers
([agent service and layers](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/agent/src/agent.ts#L28-L112)).
That integrated path is **multi-provider**, but it is not neutral in the same
sense as Auto-QA: Expect owns starting the provider, its session, its prompt,
and its tool environment. The newer skill path delegates those details to the
already-running host agent, which is simpler but also leaves workflow semantics
to that agent.

Auto-QA is host-neutral. The host can be a coding agent, a human-operated
adapter, or a future service, provided it reads Jobs and sends schema-valid
events. V1 intentionally excludes an autonomous provider. This keeps provider
failure, credentials, token use, and prompt execution outside the durable
workflow core, but means V1 cannot independently complete a normal unattended
CI run.

### 2. Live browser REPL versus compiled Scenario Script

Expect exposes a browser REPL to the agent. Its `playwright` MCP tool dynamically
executes code with `page`, `context`, `browser`, and `ref`; its `open` tool can
launch Chromium, WebKit, or Firefox, connect to CDP, show the browser, or sync
local cookies
([tool schemas](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L199-L268)).
Snapshots create ARIA-tree references that the next arbitrary Playwright call
can resolve.

Auto-QA also runs trusted agent-authored local code, not a security sandbox.
The difference is timing and identity: the accepted source is frozen before
execution, assigned a Script Version, and hidden behind the narrow
`ScenarioRuntime` attempt contract. The workflow engine never receives browser
objects. This makes reruns and evidence attribution more reproducible, but it
cannot improvise halfway through an Attempt.

### 3. Ephemeral execution state versus crash-consistent workflow state

Expect's executor folds a stream into immutable `ExecutedTestPlan` values in
process
([stream accumulation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/executor.ts#L214-L242)).
It persists selected outputs such as screenshots/video, a tested Git
fingerprint, and optionally a reusable saved flow. It does not implement an
authoritative Run database, operation journal, exclusive Run turn, or
phase-specific restart recovery. Therefore, the conclusion that an interrupted
Expect execution must generally be rerun is an inference from its execution
source, not an explicit product guarantee.

Auto-QA's core architecture is the opposite. SQLite is authoritative; every
side effect gets a durable started operation first; automatic phases declare
recovery policies; a fenced Turn lock extends beyond short transactions; and
read-only status remains available during long browser work. The full plan is
specified in
[`system-overview.md`](../system-overview.md) and
[`testing-strategy.md`](../testing-strategy.md). The current implementation has
the schema, Turn lock, operation records, and some normal cleanup, but Slice 3's
stale-owner and interrupted-Attempt reconciliation is still pending.

### 4. Direct verdict versus classified Finding

In Expect, the same testing agent emits a pass, failure, or skip marker.
Prompts ask it to put an `app-bug`, `env-issue`, `auth-blocked`,
`missing-test-data`, `selector-drift`, or `agent-misread` category inside the
failure string
([status and failure protocol](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L256-L286)).
The report reduces step statuses to overall `passed` or `failed`.

Auto-QA refuses to equate a nonpassing browser execution with an application
defect. The Attempt produces a Finding; a later agent Job must classify every
new Finding atomically as application defect, likely defect, observation, test
issue, or infrastructure issue. Only a Confirmed Defect can authorize
application remediation. Auto-QA also keeps workflow phase separate from QA
outcome (`passed`, `defects-found`, or `inconclusive`). Those semantics are
documented in ADRs
[`0009`](../adr/0009-require-agent-classification-of-nonpassing-attempts.md),
[`0010`](../adr/0010-separate-workflow-lifecycle-from-qa-outcome.md), and
[`0024`](../adr/0024-classify-findings-as-an-atomic-batch.md), but they are not
implemented yet.

### 5. Prompt-level mutation versus persisted permission

Expect's QA prompt actively tells the agent to create at least three real
records, use adversarial values, and even use application APIs for faster setup.
Its installed skill tells the outer coding agent to fix any failure and
immediately re-verify
([fix/reverify rule](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/expect-skill/README.md#L167-L176)).
The integrated ACP client also automatically chooses an available allow
permission response
([permission handling](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/agent/src/acp-client.ts#L596-L606)).
This is productive for a developer environment, but it is behavioral guidance,
not a Run-level authorization ledger. The CLI supervisor itself is not a
durable application-fix state machine; the outer agent owns that loop.

Auto-QA plans to reject a mutating Scenario unless the Run was explicitly
started with mutation permission. Application source changes are separately
default-denied under `report-only`; `agent-fix` allows them only while a
`fix-application` Job for Confirmed Defects is pending. Git fingerprints fence
unexpected source drift, and affected Scenarios are selected explicitly.
See ADRs
[`0015`](../adr/0015-require-explicit-permission-for-mutating-scenarios.md),
[`0008`](../adr/0008-make-application-remediation-opt-in.md), and
[`0026`](../adr/0026-block-unexpected-source-drift.md).

### 6. Developer-workstation authentication versus application-owned CI auth

Expect has much richer workstation convenience today. It can sync cookies from
installed browsers, launch a named system Chrome profile, or attach to existing
Chrome through CDP; it can also launch Chromium, WebKit, or Firefox
([browser opening modes](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/mcp-session.ts#L285-L382)).
Its CLI intentionally disables cookie extraction in CI
([README](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/apps/cli/README.md#L31-L33)).

Auto-QA V1 plans two explicit paths: an origin-bound local Auth Profile captured
without storing credentials, and application-owned Auth Setup for fresh
unattended state, both independently checked by a project verifier. An
interrupted Auth Setup blocks for an explicit fresh attempt or abandonment
rather than silently retrying. That model is less convenient locally but more
principled for CI and secret boundaries. It is planned in Slices 5 and the auth
ADRs, not implemented now.

### 7. Presentation-rich artifacts versus evidence provenance

Expect currently has the richer inspection instruments:

- PNG, annotated, and ARIA-tree screenshots;
- browser console capture;
- network request capture with detection of HTTP failures, duplicate requests,
  and mixed content;
- Core Web Vitals, TTFB, Long Animation Frames with script attribution, and
  resource analysis; and
- a dual-engine axe-core/IBM accessibility audit.

These are first-class MCP tools
([tool list](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L192-L204),
[performance and accessibility implementation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L559-L660)).
Closing a session flushes video and saved screenshots
([close implementation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L664-L700)).

Auto-QA's current passing bundle has only its result and manifest. V1 plans
screenshots, trace, video, console, network, actions, and structured result per
Attempt, followed by a curated provider-neutral Review Bundle. Auto-QA's
distinctive feature is the chain of custody: deterministic paths, temporary
staging, atomic promotion, exact Scenario/Script/Attempt references, sensitive
raw traces kept separate, versioned manifests, and retention rules. It does not
currently plan Expect-equivalent Web Vitals or accessibility audit primitives.

## Capabilities Expect provides that Auto-QA does not

The following are implemented in Expect at the pinned commit and absent from
both Auto-QA's current code and, unless noted, its V1 plan:

1. **A standalone browser MCP server and installable agent skill.** Agents can
   use Expect's browser without running the Expect supervisor. The skill
   explicitly supports delegated background verification
   ([skill delegation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/expect-skill/README.md#L20-L38)).
   Auto-QA explicitly excludes MCP in V1.
2. **Rich, agent-friendly browser observation.** ARIA snapshots with stable
   short-lived refs, annotated screenshots, arbitrary Playwright evaluation,
   automatic console/network diagnostics, performance metrics, and
   accessibility auditing.
3. **Cross-browser and existing-browser execution.** Chromium, WebKit, Firefox,
   CDP attachment, named Chrome profiles, headed overlays, and local-cookie
   reuse are supported. Auto-QA V1 directly manages Chromium; an existing
   browser transport is only a possible future adapter.
4. **An embedded multi-provider agent layer in the integrated path.** Expect
   detects and launches eight coding-agent backends. Auto-QA deliberately has
   no autonomous provider in V1.
5. **Interactive TUI and live progress in the integrated path.** Expect
   presents planning/tool activity and steps as they stream, although the TUI
   is now explicitly deprecated in favor of the skill. Auto-QA's current CLI
   is a JSON protocol; its long-Turn progress format remains an open
   experiment.
6. **Watch mode.** Expect fingerprints changes, waits for them to settle, uses
   deterministic filters plus an agent assessment, and automatically starts a
   new test execution
   ([watch loop](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/watch.ts#L175-L305)).
7. **Reusable saved flows.** A completed dynamic plan can be stored as a
   Markdown flow and listed/replayed later
   ([flow storage](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/flow-storage.ts#L49-L113)).
   Auto-QA V1 explicitly excludes a promoted durable test suite.
8. **A published TypeScript SDK.** It exposes promise-like and async-iterable
   test runs around plain-English requirements. Auto-QA exposes TypeScript
   interfaces internally but has no planned public high-level SDK.
9. **Direct GitHub Actions presentation.** Expect writes step summaries,
   outputs, annotations, and upserts a PR comment
   ([CI integration](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/apps/cli/src/utils/run-test.ts#L249-L327)).
   Auto-QA V1 intentionally stops at a Review Bundle plus an external
   publication recipe.
10. **Adaptive scope expansion and data seeding.** Expect's agent may add
    adjacent flows, code-level checks, cross-browser checks, and setup work
    during the same execution. Auto-QA can execute only the accepted Scenarios;
    new coverage requires a new Run.
11. **Heuristic existing-test coverage analysis.** Expect builds a TypeScript/
    JavaScript import graph from repository test files and uses it to prioritize
    changed source files without apparent coverage
    ([coverage analysis](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/test-coverage.ts#L192-L250)).
    Auto-QA's Git context does not currently provide that signal.
12. **Optional dev-server startup by the agent.** Expect can put detected
    not-yet-running server commands in the agent prompt
    ([prompt construction](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L311-L329)).
    Auto-QA deliberately requires an externally started and externally owned
    Target Application.

### Important SDK caveat

Expect's SDK README describes persistent sessions, external Playwright objects,
and custom tools. The pinned source is still alpha and does not fully deliver
those claims: it rejects custom tools and external browser contexts
([validation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/typescript-sdk/src/expect.ts#L55-L99)),
and `session.close()` is currently a no-op because browser lifecycle is still
owned internally
([session implementation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/typescript-sdk/src/expect.ts#L374-L410)).
Those advertised items should not be counted as mature advantages yet.

## Capabilities Auto-QA provides or plans that Expect does not

### Already present in the Auto-QA implementation

1. **Authoritative SQLite workflow state** rather than only streamed in-memory
   execution state.
2. **Idempotent typed Job submission** with canonical payload hashes and
   conflict detection.
3. **Fenced exclusive Turn ownership** while allowing concurrent read-only
   `job` and `status`.
4. **Atomic plan acceptance and immutable Script Version 0.**
5. **A host-neutral `WorkflowEngine` and deterministic `ScenarioRuntime`
   adapter**, allowing most workflow tests to run without an agent or browser.
6. **Cumulative active-work budgeting across phases**, not just a wall-clock
   timeout around one agent process.
7. **A real-browser happy path with evidence staging and atomic promotion.**

### Planned for Auto-QA V1

1. **Phase-specific crash recovery.** Deterministic work may rerun; interrupted
   Scenario execution becomes a Finding; interrupted Auth Setup blocks. Expect
   has no comparable persisted recovery matrix.
2. **Exact provenance across Scenario, immutable Script Version, and Attempt.**
   Expect's step is a mutable status record assembled during one agent stream.
3. **Atomic Finding classification and reliability-first routing.** Test issue,
   infrastructure issue, interruption, and application defect have distinct
   bounded paths.
4. **Explicit rerun approval and idempotent correction history.** Auto-QA
   preserves previous Attempts and permits at most two accepted replacement
   Scripts rather than treating a fresh execution as a replacement for history.
5. **Policy-gated mutation and remediation.** Browser mutation permission,
   application editing permission, and source-fingerprint drift are separate
   enforced concerns.
6. **Semantically honest terminal outcomes.** `completed` does not mean
   “passed”; `defects-found` and `inconclusive` remain successful workflow
   completion states, with explicit incomplete coverage.
7. **Immutable completed Runs.** Later verification creates a new Run instead
   of reopening and rewriting history.
8. **Application-owned unattended authentication with a project verifier** and
   explicit interrupted-setup handling.
9. **Evidence privacy, Review Bundle separation, and retention.** Raw forensic
   evidence and share-ready publication material have different contracts and
   lifecycles.
10. **Crash, fault-injection, mutation, and machine-model quality gates.**
    Auto-QA's testing strategy treats the transition table and recovery matrix
    as generated specifications, includes kill-between-checkpoint tests, and
    requires leak/secret invariants
    ([`testing-strategy.md`](../testing-strategy.md)).

## Similar-looking terms that mean different things

| Term | Expect | Auto-QA |
| --- | --- | --- |
| **Run** | One live agent execution, reconstructed from its stream and ending `passed`/`failed` | A durable workflow spanning multiple processes and external Turns; its lifecycle and QA outcome are separate |
| **Plan** | At this commit, an initially empty synthetic object populated as marker events arrive; a saved flow may guide later execution | One complete agent submission accepted atomically before browser execution |
| **Step** | A dynamically invented unit of the agent's procedure, with mutable status | No direct equivalent. A Scenario is stable intent; a Script is implementation; an Attempt is one execution |
| **Test** | Generic plain-English requirement or dynamically executed step | Deliberately avoided as a domain entity; “Scenario” prevents confusion with repository tests and script executions |
| **Failure** | Agent-declared failed step, often containing a category string | A nonpassing Attempt creates a Finding; only later classification may establish a Confirmed Defect |
| **Flow** | A reusable natural-language sequence saved after execution | No V1 promoted suite; an accepted Scenario plan belongs to one Run |
| **Session** | Depending on surface, an agent session, browser session, or SDK grouping | Avoided in favor of durable Run and exclusive Turn |
| **CI mode** | Internally launches an agent, runs headless, omits cookie sync, times out, and can comment on a PR | Changes browser/evidence/exit behavior, but still waits for an external agent to answer Jobs |
| **Agent-neutral / multi-agent** | The skill relies on its host agent; the integrated path is multi-provider because it has explicit adapters | Auto-QA is agent-neutral because the workflow does not host or identify the agent provider |
| **Fix loop** | Primarily skill instructions to the surrounding agent: fix, launch another verification, repeat | A persisted remediation policy and `fix-application` Job authorized only by classified defects |
| **Evidence** | Tool results plus convenient screenshots/video and report summaries | A versioned per-Attempt bundle with explicit provenance, atomic finalization, privacy boundary, and retention policy |

Expect's own `RUN_COMPLETED` marker contains a “session summary”
([protocol](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L256-L272)),
which is a useful illustration of how loosely those concepts are coupled there.
Auto-QA's ubiquitous language intentionally makes those distinctions rigid
([`UBIQUITOUS_LANGUAGE.md`](../../UBIQUITOUS_LANGUAGE.md)).

## What Auto-QA should consider borrowing

These are complementary to Auto-QA's architecture and do not require adopting
Expect's trust model:

1. **Browser diagnostics as runtime capabilities.** Add optional accessibility,
   performance, network-issue, ARIA-snapshot, and annotated-screenshot
   collectors behind `ScenarioRuntime` and record their outputs in the Evidence
   Bundle. Do not expose raw browser objects to `WorkflowEngine`.
2. **A host adapter over the existing engine.** An MCP or SDK surface could map
   cleanly to `dispatch`, `getPendingJob`, and `getStatus` after V1. It should
   remain a host, not become an embedded model provider.
3. **Watch as a Run creator.** A watch service could fingerprint settled
   changes and start a fresh Run. It should never silently resume or rewrite a
   completed Run.
4. **Saved flows as a future, stricter domain.** Expect demonstrates demand for
   reusable QA intent. Auto-QA could eventually promote Scenario goals and
   preconditions into reviewable project assets while excluding Base URLs,
   secrets, Attempts, and mutable runtime state.
5. **Presentation adapters.** Expect's TUI, streamed progress, inline images,
   and PR summary are strong product affordances. They can consume Auto-QA Jobs,
   status, and Review Bundles without changing the workflow core.
6. **Multiple browser engines through the runtime seam.** Add engine identity
   to accepted Run policy and Attempt evidence, then implement Playwright
   adapters. Cross-browser work should remain explicit and reproducible rather
   than an agent deciding to switch engines in the middle of an unrecorded
   plan.
7. **Use ARIA refs during planning, then compile.** A future planning assistant
   could use Expect-like snapshots to discover robust locators, but its output
   should still become accepted frozen Script bytes before the Attempt.

## What Auto-QA should not copy without changing its goals

1. **In-band text markers as the authoritative control protocol.** They are
   easy to integrate but weaker than typed Jobs and validated events.
2. **The testing agent as sole planner, executor, classifier, and verdict
   authority.** Auto-QA's separate classification step is slower but materially
   reduces false attribution.
3. **Implicit mutation through testing guidance.** Data seeding is valuable,
   but it should remain covered by explicit Mutating Scenario permission and
   evidence.
4. **Local cookie extraction as the CI authentication story.** It is excellent
   workstation UX, but Auto-QA's application-owned setup and verifier are the
   safer unattended contract.
5. **Having the QA agent own the Target Application process.** Auto-QA's
   externally owned server makes crash cleanup, URL identity, and side-effect
   responsibility much clearer.
6. **Direct publication inside the workflow core.** Expect's PR comment is
   convenient; Auto-QA's provider-neutral Review Bundle and separate publisher
   preserve credential and forge boundaries.

## Bottom line

Expect is currently the more capable **browser QA product**: it has better
browser perception, more ways to run, multiple agent providers, existing
browser and cookie integration, watch mode, reusable flows, an SDK, and direct
CI presentation.

Auto-QA is becoming the more rigorous **QA workflow system**: it is designed to
make plans, code versions, attempts, classifications, permissions, recovery,
and publication provenance inspectable and enforceable across process
boundaries. Much of that advantage is still planned rather than shipped, while
its current browser feature set is much narrower than Expect's.

The strongest direction is therefore not to recreate Expect wholesale.
Preserve Auto-QA's durable state machine and typed boundaries, then selectively
adopt Expect's browser instrumentation and user-facing adapters. That would
combine Expect's observational reach with Auto-QA's stronger answer to “what
exactly happened, who authorized it, and can we trust the result after a
failure?”
