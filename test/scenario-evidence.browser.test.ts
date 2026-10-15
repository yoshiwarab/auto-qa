import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeQaLab } from "../acceptance/qaLabHarness.js";

const exec = promisify(execFile);
const cliPath = process.env["AUTO_QA_PACKED_CLI"];
if (cliPath === undefined) throw new Error("Packed CLI is required");
const runtimeUrl = pathToFileURL(
  join(dirname(cliPath), "playwrightScenarioRuntime.js")
).href;
const engineUrl = pathToFileURL(
  join(dirname(cliPath), "nodeWorkflowEngine.js")
).href;
const machineUrl = pathToFileURL(
  join(dirname(cliPath), "workflowMachine.js")
).href;

test("a timed-out Script loses browser access before evidence capture can prolong it", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "auto-qa-late-script-"));
  const requests: string[] = [];
  const target = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/slow-font") {
      const timer = setTimeout(() => response.end("not a font"), 2000);
      response.on("close", () => clearTimeout(timer));
    } else {
      response.setHeader("content-type", "text/html");
      response.end(
        `<style>@font-face { font-family: Slow; src: url('/slow-font'); } body { font-family: Slow; }</style><h1>Before timeout</h1>`
      );
    }
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  try {
    const address = target.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing target address");
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    const attempt = {
      runId: "late-script",
      attemptNumber: 1,
      scriptVersion: 0,
      scenario: {
        id: "late-mutation",
        goal: "Close the browser when its Script times out",
        preconditions: [],
        mutates: false,
        script: `async ({ page, baseUrl }) => {
        await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded' });
        await new Promise(resolve => setTimeout(resolve, 800));
        await page.evaluate(() => { document.body.textContent = 'AFTER TIMEOUT'; return fetch('/late-mutation'); });
      }`,
      },
    };
    const child = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { Effect } from 'effect';
      import { makePlaywrightScenarioRuntime } from ${JSON.stringify(runtimeUrl)};
      const result = await Effect.runPromise(Effect.scoped(makePlaywrightScenarioRuntime(${JSON.stringify(stateDirectory)}).execute(
        ${JSON.stringify(attempt)}, { baseUrl: new URL(${JSON.stringify(baseUrl.href)}), timeoutMs: 500, checkpointActiveWork: () => {} }
      )));
      await new Promise(resolve => setTimeout(resolve, 1000));
      process.stdout.write(JSON.stringify(result));
    `,
      ],
      { cwd: process.cwd(), timeout: 15000 }
    );
    expect(requests).toContain("/slow-font");
    expect(requests).not.toContain("/late-mutation");
    expect(JSON.parse(child.stdout)).toMatchObject({
      attempt: { status: "failed" },
      diagnostic: { kind: "timeout" },
      evidence: { files: ["result.json"], captures: [] },
    });
  } finally {
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 20000);

test("a Script timeout through WorkflowEngine preserves its diagnostic and continues the batch", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "auto-qa-timeout-"));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const target = yield* makeQaLab(process.cwd());
          const child = yield* Effect.promise(() =>
            exec(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `
        import { Effect } from 'effect';
        import { createWorkflowEngine } from ${JSON.stringify(engineUrl)};
        import { RunId } from ${JSON.stringify(machineUrl)};
        const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const engine = yield* createWorkflowEngine({ databasePath: ${JSON.stringify(join(stateDirectory, "state.db"))}, changeInspector: { inspect: () => Effect.succeed([]) }, planLimits: { maxScenarios: 2, scenarioTimeoutMs: 1000, activeWorkBudgetMs: 30000 } });
          const runId = RunId('timeout-run');
          const start = yield* engine.dispatch(runId, { type: 'start', baseUrl: new URL(${JSON.stringify(target.baseUrl.href)}) });
          return yield* engine.dispatch(runId, { type: 'submitJob', jobId: start.pendingJob.id, payload: { schemaVersion: 1, scenarios: [
            { id: 'timeout', goal: 'Timeout diagnostic', preconditions: [], mutates: false, script: 'async ({ page, baseUrl }) => { await page.goto(baseUrl.href); await new Promise(() => {}); }' },
            { id: 'next', goal: 'Following Scenario executes', preconditions: [], mutates: false, script: 'async ({ page, baseUrl }) => { await page.goto(baseUrl.href); }' }
          ] } });
        })));
        process.stdout.write(JSON.stringify(result));
      `,
              ],
              { cwd: process.cwd(), timeout: 20_000 }
            )
          );
          expect(JSON.parse(child.stdout)).toMatchObject({
            phase: "awaitingAgent",
            pendingJob: {
              payload: {
                findings: [
                  {
                    mechanicalStatus: "failed",
                    diagnostic: { kind: "timeout" },
                    evidenceBundle: {
                      files: ["result.json"],
                      captures: [],
                      captureErrors: [
                        expect.stringContaining("timeout"),
                        expect.stringContaining("timeout"),
                      ],
                    },
                  },
                  { mechanicalStatus: "passed" },
                ],
              },
            },
          });
          expect(target.isRunning()).toBe(true);
        })
      )
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 25_000);

test.each([
  {
    name: "accessibility capture fails",
    script:
      "async ({ page, baseUrl }) => { await page.goto(baseUrl.href); await page.evaluate(() => document.body.replaceWith(document.createElement('frameset'))); }",
    file: "final.png",
    error: "accessibility",
  },
  {
    name: "screenshot capture fails",
    script: `async ({ page, baseUrl }) => {
      await page.goto(baseUrl.href);
      await page.route('**/blocked-font', () => new Promise(() => {}));
      await page.addStyleTag({ content: '@font-face { font-family: Pending; src: url("/blocked-font"); } body { font-family: Pending; }' });
    }`,
    file: "final.aria.yaml",
    error: "screenshot",
  },
])(
  "retains partial visual evidence when $name",
  async (example) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "auto-qa-partial-evidence-")
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const target = yield* makeQaLab(process.cwd());
            const attempt = {
              runId: "partial-evidence",
              attemptNumber: 1,
              scriptVersion: 0,
              scenario: {
                id: "partial",
                goal: "Preserve every available artifact",
                preconditions: [],
                mutates: false,
                script: example.script,
              },
            };
            const child = yield* Effect.promise(() =>
              exec(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `
        import { Effect } from 'effect';
        import { makePlaywrightScenarioRuntime } from ${JSON.stringify(runtimeUrl)};
        const result = await Effect.runPromise(Effect.scoped(makePlaywrightScenarioRuntime(${JSON.stringify(stateDirectory)}).execute(
          ${JSON.stringify(attempt)}, { baseUrl: new URL(${JSON.stringify(target.baseUrl.href)}), timeoutMs: 2000, checkpointActiveWork: () => {} }
        )));
        process.stdout.write(JSON.stringify(result));
      `,
                ],
                { cwd: process.cwd(), timeout: 15000 }
              )
            );
            const expected = {
              files: ["result.json", example.file],
              captures: [],
              captureErrors: [expect.stringContaining(example.error)],
            };
            expect(JSON.parse(child.stdout), child.stdout).toMatchObject({
              attempt: { status: "passed" },
              evidence: expected,
            });
            const evidenceDirectory = join(
              stateDirectory,
              "runs/partial-evidence/scenarios/partial/attempt-1"
            );
            const manifest = yield* Effect.promise(() =>
              readFile(join(evidenceDirectory, "manifest.json"), "utf8")
            );
            expect(JSON.parse(manifest)).toMatchObject(expected);
            const artifact = yield* Effect.promise(() =>
              readFile(join(evidenceDirectory, example.file))
            );
            if (example.file === "final.png") {
              expect([...artifact.subarray(0, 8)]).toEqual([
                137, 80, 78, 71, 13, 10, 26, 10,
              ]);
            } else {
              expect(artifact.toString()).toContain('heading "Account"');
            }
            expect(target.isRunning()).toBe(true);
          })
        )
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  20000
);

test.each([
  {
    name: "assertion failure",
    script:
      "async ({ page, baseUrl, expect }) => { await page.goto(baseUrl.href); expect(await page.title()).toBe('Deliberately incorrect title'); }",
    kind: "assertion",
    message: "Deliberately incorrect title",
    captures: true,
  },
  {
    name: "closed-page script failure",
    script:
      "async ({ page }) => { await page.close(); throw new Error('Page deliberately closed'); }",
    kind: "script",
    message: "Page deliberately closed",
    captures: false,
  },
  {
    name: "script timeout",
    script:
      "async ({ page, baseUrl }) => { await page.goto(baseUrl.href); await new Promise(() => {}); }",
    kind: "timeout",
    message: "Scenario timed out",
    captures: false,
  },
])(
  "a $name is a failed Attempt with a durable diagnostic",
  async (example) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "auto-qa-evidence-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const target = yield* makeQaLab(process.cwd());
            const runId = randomUUID();
            const attempt = {
              runId,
              attemptNumber: 1,
              scriptVersion: 0,
              scenario: {
                id: "account-assertion",
                goal: "Account state matches the expected label",
                preconditions: [],
                mutates: false,
                script: example.script,
              },
            };
            const child = yield* Effect.promise(() =>
              exec(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `
        import { Effect } from 'effect';
        import { makePlaywrightScenarioRuntime } from ${JSON.stringify(runtimeUrl)};
        const result = await Effect.runPromise(Effect.scoped(makePlaywrightScenarioRuntime(${JSON.stringify(stateDirectory)}).execute(
          ${JSON.stringify(attempt)},
          { baseUrl: new URL(${JSON.stringify(target.baseUrl.href)}), timeoutMs: 1000, checkpointActiveWork: () => {} }
        )));
        process.stdout.write(JSON.stringify(result));
      `,
                ],
                { cwd: process.cwd(), timeout: 15_000 }
              )
            );
            expect(JSON.parse(child.stdout)).toMatchObject({
              attempt: { status: "failed" },
            });
            const evidencePath = `runs/${runId}/scenarios/account-assertion/attempt-1`;
            const evidence = yield* Effect.promise(() =>
              readFile(
                join(stateDirectory, evidencePath, "result.json"),
                "utf8"
              )
            );
            expect(JSON.parse(evidence)).toMatchObject({
              status: "failed",
              diagnostic: {
                kind: example.kind,
                message: expect.stringContaining(example.message),
              },
            });
            if (!example.captures) {
              expect(JSON.parse(child.stdout)).toMatchObject({
                evidence: {
                  files: ["result.json"],
                  captures: [],
                  captureErrors: [
                    expect.stringContaining("screenshot"),
                    expect.stringContaining("accessibility"),
                  ],
                },
              });
              return;
            }
            const screenshot = yield* Effect.promise(() =>
              readFile(join(stateDirectory, evidencePath, "final.png"))
            );
            expect([...screenshot.subarray(0, 8)]).toEqual([
              137, 80, 78, 71, 13, 10, 26, 10,
            ]);
            const snapshot = yield* Effect.promise(() =>
              readFile(
                join(stateDirectory, evidencePath, "final.aria.yaml"),
                "utf8"
              )
            );
            expect(snapshot).toContain('heading "Account"');
            const manifest = yield* Effect.promise(() =>
              readFile(
                join(stateDirectory, evidencePath, "manifest.json"),
                "utf8"
              )
            );
            expect(JSON.parse(manifest)).toMatchObject({
              files: ["result.json", "final.png", "final.aria.yaml"],
              captures: [
                {
                  name: "final",
                  screenshot: "final.png",
                  accessibility: "final.aria.yaml",
                  viewport: { width: 1280, height: 720 },
                },
              ],
            });
            expect(target.isRunning()).toBe(true);
          })
        )
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  20_000
);
