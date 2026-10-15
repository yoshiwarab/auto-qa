# Expect screenshots and visual evidence

Observed 2026-09-22. Source review only, with no Expect installation or browser execution. Code links are pinned to upstream commit `39e97500725783490136a8fc7040e6e4dbaafa44`.

## Project identity

The relevant project is Million's [Expect](https://www.expect.dev/), distributed as `expect-cli` from [millionco/expect](https://github.com/millionco/expect). Its site describes a skill that connects an existing coding agent to Playwright. `expec.dev` could not be opened through the research browser. That failure does not establish anything about Expect's maintenance status.

## What the agent can observe

The official [MCP documentation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/docs/mcp.md#L7-L20) distinguishes three modes of the tool named `screenshot`:

| Mode | Output |
| --- | --- |
| `snapshot` | ARIA accessibility tree, element refs, and statistics |
| `screenshot` | Real rendered PNG |
| `annotated` | Rendered PNG with numbered interactive-element labels |

The [implementation](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L360-L427) defaults to PNG when mode is omitted. Both image modes save a screenshot and return base64 PNG as MCP `image` content. The snapshot mode returns JSON text. Images therefore reach the agent client as images, although source inspection cannot prove that a particular model actually examined them.

The [Playwright tool](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L263-L356) dynamically executes agent-supplied JavaScript with `page`, `context`, `browser`, and `ref`. `ref` resolves an earlier snapshot's element identifier to a Playwright locator. `snapshotAfter=true` adds an ARIA snapshot, not a PNG. No automatic PNG capture appears in this execution path, including its error branch.

The [built-in interaction guide](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L143-L165) prefers ARIA snapshots and directs the agent to use image modes for visual checks. Tool availability does not itself enforce visual review.

## What the integrated runner asks for

The [execution prompt](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L180-L218) requires a UI quality pass for changes affecting visual output, including responsive layouts, dark mode, and layout stability. It recommends PNGs for layout, colors, and images, and specifically requests two screenshots when layout shift is high. These are agent instructions, not proof that every step captured or reviewed pixels. Failure-reporting instructions explicitly request an ARIA snapshot and diagnostics. They do not universally require a PNG. [Failure reporting and completion](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L254-L298).

This is a live agent loop. The [executor](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/supervisor/src/executor.ts#L134-L240) starts with an empty step list, supplies change context, and consumes the agent's streaming events. The [prompt](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L139-L149) asks the agent to invent steps while executing. Saved flows supply adaptable instructions and expected outcomes, rather than fixed executable scripts. [Saved-flow prompt](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/shared/src/prompts.ts#L38-L53).

## Evidence persistence and limits

Requested PNGs are written immediately as `screenshot-N.png` in `/tmp/expect-artifacts`. Closing returns the saved paths and, when available, a session video path. These are temporary filesystem artifacts, with write failures logged rather than made fatal. [Screenshot storage](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/mcp-session.ts#L164-L190), [close behavior](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/mcp-session.ts#L490-L580).

Playwright return values also get temporary JSON files; the MCP close handler deletes those result files. [Result-file cleanup](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/packages/browser/src/mcp/server.ts#L681-L700).

The headless CLI extracts artifact paths from the close result and includes screenshots and video in JSON output when present. This confirms report plumbing, not durable retention or universal screenshot coverage. [CLI output](https://github.com/millionco/expect/blob/39e97500725783490136a8fc7040e6e4dbaafa44/apps/cli/src/utils/run-test.ts#L233-L367).

The design lesson is an inference: a live agent can request and inspect rendered pixels between actions, but screenshot capability alone cannot prevent a false pass. Preventing that requires a policy that ties visual claims to captured images and an actual review of those images.
