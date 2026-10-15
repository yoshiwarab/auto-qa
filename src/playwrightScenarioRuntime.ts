import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { chromium, type BrowserContext, type Page } from "playwright";
import { expect } from "playwright/test";
import {
  ScenarioRuntimeError,
  type FrozenScenarioAttempt,
  type ScenarioEnvironment,
  type ScenarioRuntime,
  type AttemptDiagnostic,
} from "./scenarioRuntime.js";
import { compileScenarioScript as compileTrustedScenarioScript } from "./scenarioScript.js";
import { makeNodeBrowserResources } from "./nodeBrowserResources.js";
import { syncDirectory, writeFileDurably } from "./durableFile.js";
import type { EvidenceBundle } from "./workflowProtocol.js";

type ScenarioScript = (context: {
  readonly page: Page;
  readonly baseUrl: URL;
  readonly expect: typeof expect;
}) => Promise<void>;

const runtimeEffect = <Result>(
  operation: string,
  work: () => Promise<Result>
): Effect.Effect<Result, ScenarioRuntimeError> =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new ScenarioRuntimeError({ operation, cause }),
  });

const compileScenarioScript = (
  source: string
): Effect.Effect<ScenarioScript, ScenarioRuntimeError> =>
  Effect.try({
    try: () => compileTrustedScenarioScript<ScenarioScript>(source),
    catch: (cause) =>
      new ScenarioRuntimeError({
        operation: "compile Scenario Script",
        cause,
      }),
  });

const scriptDiagnostic = (error: ScenarioRuntimeError): AttemptDiagnostic => {
  const cause = error.cause;
  return {
    kind:
      cause instanceof Error && "matcherResult" in cause
        ? "assertion"
        : cause instanceof Error && cause.name === "TimeoutError"
          ? "timeout"
          : "script",
    message: (cause instanceof Error ? cause.message : String(cause)).slice(
      0,
      8000
    ),
  };
};

export const makePlaywrightScenarioRuntime = (
  stateDirectory: string
): ScenarioRuntime => {
  const resources = makeNodeBrowserResources(stateDirectory);
  return {
    executionOverheadMs: 15_000,
    reconcile: resources.reconcile,
    execute: (
      attempt: FrozenScenarioAttempt,
      environment: ScenarioEnvironment
    ) => {
      const activeWorkStartedAt = Date.now();
      const launchToken = randomUUID();
      const executablePath = chromium.executablePath();
      const scenarioDirectory = join(
        stateDirectory,
        "runs",
        attempt.runId,
        "scenarios",
        attempt.scenario.id
      );
      const finalDirectory = join(
        scenarioDirectory,
        `attempt-${attempt.attemptNumber}`
      );
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          resources.release(launchToken).pipe(Effect.orDie)
        );
        if (
          !/^[a-zA-Z0-9_-]+$/.test(attempt.runId) ||
          !/^[a-zA-Z0-9_-]+$/.test(attempt.scenario.id) ||
          !Number.isSafeInteger(attempt.attemptNumber) ||
          attempt.attemptNumber < 1
        ) {
          return yield* Effect.fail(
            new ScenarioRuntimeError({
              operation: "validate Attempt identity",
              cause: new Error("Attempt identities must be path-safe"),
            })
          );
        }
        const launch = yield* resources
          .register(attempt.runId, launchToken, executablePath)
          .pipe(Effect.uninterruptible);
        const stagingDirectory = join(
          launch.workspaceDirectory,
          `.attempt-${attempt.attemptNumber}-${launchToken}.tmp`
        );
        yield* runtimeEffect("stage Evidence Bundle", async () => {
          await mkdir(stagingDirectory, { mode: 0o700 });
          await syncDirectory(launch.workspaceDirectory);
        }).pipe(Effect.uninterruptible);
        let closing: Promise<void> | undefined;
        const requestClose = (acquired: BrowserContext) => {
          closing ??= acquired.close();
          // The Scope observes the original rejection and applies the fallback.
          // Attach a handler now because timeout handling starts close early.
          void closing.catch(() => {});
          return closing;
        };
        const closeContext = (acquired: BrowserContext) =>
          runtimeEffect("close browser context", () =>
            requestClose(acquired)
          ).pipe(
            Effect.timeout("2 seconds"),
            Effect.catchAll(() => resources.release(launchToken)),
            Effect.orDie
          );
        const context = yield* Effect.acquireRelease(
          Effect.uninterruptible(
            runtimeEffect("launch browser", () =>
              chromium.launchPersistentContext(launch.profileDirectory, {
                executablePath: launch.launcherPath,
                artifactsDir: launch.artifactsDirectory,
                headless: true,
                args: [`--auto-qa-launch-token=${launchToken}`],
              })
            )
          ),
          closeContext
        );
        yield* resources.capture().pipe(Effect.uninterruptible);
        const page = yield* runtimeEffect("create browser page", () =>
          context.newPage()
        );
        const script = yield* compileScenarioScript(attempt.scenario.script);
        const execution = yield* Effect.either(
          runtimeEffect("execute Scenario Script", () =>
            script({
              page,
              baseUrl: environment.baseUrl,
              expect,
            })
          ).pipe(
            Effect.timeoutFail({
              duration: environment.timeoutMs,
              onTimeout: () =>
                new ScenarioRuntimeError({
                  operation: "execute Scenario Script",
                  cause: Object.assign(
                    new Error(
                      `Scenario timed out after ${environment.timeoutMs}ms`
                    ),
                    { name: "TimeoutError" }
                  ),
                }),
            })
          )
        );
        const diagnostic =
          execution._tag === "Left"
            ? scriptDiagnostic(execution.left)
            : undefined;
        const status = diagnostic === undefined ? "passed" : "failed";

        // Interrupting the wait cannot cancel trusted JavaScript Promises.
        // Start closing immediately, without attempting visual capture. The
        // Scope awaits shutdown outside the active-work watchdog.
        if (diagnostic?.kind === "timeout") {
          yield* Effect.sync(() => {
            void requestClose(context);
          });
        }

        const evidencePath = relative(
          stateDirectory,
          finalDirectory
        ).replaceAll("\\", "/");
        const capture = <Result>(name: string, work: () => Promise<Result>) =>
          Effect.either(
            diagnostic?.kind === "timeout"
              ? Effect.fail(
                  new ScenarioRuntimeError({
                    operation: `capture ${name}`,
                    cause: new Error(
                      "Visual capture skipped after Script timeout; browser access was closed"
                    ),
                  })
                )
              : runtimeEffect(`capture ${name}`, work).pipe(
                  Effect.timeoutFail({
                    duration: "5 seconds",
                    onTimeout: () =>
                      new ScenarioRuntimeError({
                        operation: `capture ${name}`,
                        cause: new Error(`${name} capture exceeded 5 seconds`),
                      }),
                  })
                )
          );
        const screenshot = yield* capture("screenshot", async () => ({
          viewport:
            page.viewportSize() ??
            (await page.evaluate(() => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }))),
          screenshot: await page.screenshot({
            fullPage: true,
            animations: "disabled",
            timeout: 5000,
          }),
        }));
        const accessibility = yield* capture("accessibility", () =>
          page.locator("body").ariaSnapshot({ timeout: 5000 })
        );
        const evidence: EvidenceBundle = {
          path: evidencePath,
          files: [
            "result.json",
            ...(screenshot._tag === "Right" ? ["final.png"] : []),
            ...(accessibility._tag === "Right" ? ["final.aria.yaml"] : []),
          ],
          captures:
            screenshot._tag === "Right" && accessibility._tag === "Right"
              ? [
                  {
                    name: "final",
                    screenshot: "final.png",
                    accessibility: "final.aria.yaml",
                    viewport: screenshot.right.viewport,
                  },
                ]
              : [],
          captureErrors: [screenshot, accessibility].flatMap((result) =>
            result._tag === "Left"
              ? [
                  `${result.left.operation}: ${scriptDiagnostic(result.left).message}`,
                ]
              : []
          ),
        };
        yield* runtimeEffect("finalize Evidence Bundle", async () => {
          if (screenshot._tag === "Right") {
            await writeFileDurably(
              join(stagingDirectory, "final.png"),
              screenshot.right.screenshot
            );
          }
          if (accessibility._tag === "Right") {
            await writeFileDurably(
              join(stagingDirectory, "final.aria.yaml"),
              accessibility.right
            );
          }
          await writeFileDurably(
            join(stagingDirectory, "result.json"),
            `${JSON.stringify({
              schemaVersion: 1,
              scenarioId: attempt.scenario.id,
              attemptNumber: attempt.attemptNumber,
              scriptVersion: attempt.scriptVersion,
              status,
              ...(diagnostic === undefined ? {} : { diagnostic }),
            })}\n`
          );
          await writeFileDurably(
            join(stagingDirectory, "manifest.json"),
            `${JSON.stringify({
              schemaVersion: 1,
              files: evidence.files,
              captures: evidence.captures,
              captureErrors: evidence.captureErrors,
            })}\n`
          );
          await syncDirectory(stagingDirectory);
          await mkdir(scenarioDirectory, { recursive: true });
          await rename(stagingDirectory, finalDirectory);
          await syncDirectory(scenarioDirectory);
          await syncDirectory(launch.workspaceDirectory);
        }).pipe(Effect.uninterruptible);

        return {
          attempt: {
            scenarioId: attempt.scenario.id,
            attemptNumber: attempt.attemptNumber,
            scriptVersion: attempt.scriptVersion,
            status,
            evidencePath,
          },
          ...(diagnostic === undefined ? {} : { diagnostic }),
          evidence,
        } as const;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            environment.checkpointActiveWork(Date.now() - activeWorkStartedAt);
          })
        )
      );
    },
  };
};
