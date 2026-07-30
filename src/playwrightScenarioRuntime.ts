import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { Effect } from "effect";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { expect } from "playwright/test";
import {
  ScenarioRuntimeError,
  type FrozenScenarioAttempt,
  type ScenarioEnvironment,
  type ScenarioRuntime,
} from "./scenarioRuntime.js";
import {
  syncDirectory,
  writeFileDurably,
} from "./durableFile.js";

type ScenarioScript = (context: {
  readonly page: Page;
  readonly baseUrl: URL;
  readonly expect: typeof expect;
}) => Promise<void>;

const runtimeEffect = <Result>(
  operation: string,
  work: () => Promise<Result>,
): Effect.Effect<Result, ScenarioRuntimeError> =>
  Effect.tryPromise({
    try: work,
    catch: (cause) =>
      new ScenarioRuntimeError({ operation, cause }),
  });

const compileScenarioScript = (
  source: string,
): Effect.Effect<ScenarioScript, ScenarioRuntimeError> =>
  Effect.try({
    try: () => {
      const candidate = Function(`"use strict"; return (${source});`)();
      if (typeof candidate !== "function") {
        throw new Error("Scenario Script must evaluate to a function");
      }
      return candidate as ScenarioScript;
    },
    catch: (cause) =>
      new ScenarioRuntimeError({
        operation: "compile Scenario Script",
        cause,
      }),
  });

export const makePlaywrightScenarioRuntime = (
  stateDirectory: string,
): ScenarioRuntime => ({
  execute: (
    attempt: FrozenScenarioAttempt,
    environment: ScenarioEnvironment,
  ) => {
    const activeWorkStartedAt = Date.now();
    const launchToken = randomUUID();
    const executablePath = chromium.executablePath();
    let browserAcquired = false;
    let browserReleased = false;
    const registryPath = join(stateDirectory, "registry.json");
    const scenarioDirectory = join(
      stateDirectory,
      "runs",
      attempt.runId,
      "scenarios",
      attempt.scenario.id,
    );
    const finalDirectory = join(
      scenarioDirectory,
      `attempt-${attempt.attemptNumber}`,
    );
    const stagingDirectory = join(
      scenarioDirectory,
      `.attempt-${attempt.attemptNumber}-${launchToken}.tmp`,
    );

    return Effect.ensuring(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runtimeEffect("stage Evidence Bundle", async () => {
            await mkdir(stagingDirectory, { recursive: true });
            await writeFileDurably(
              registryPath,
              `${JSON.stringify({
                schemaVersion: 1,
                resources: [
                  {
                    type: "browser",
                    launchToken,
                    runId: attempt.runId,
                    executablePath,
                  },
                ],
              })}\n`,
            );
            await syncDirectory(stateDirectory);
          });
          const browser = yield* Effect.acquireRelease(
            Effect.uninterruptible(
              runtimeEffect("launch browser", () =>
                chromium.launch({
                  headless: true,
                  args: [
                    `--auto-qa-launch-token=${launchToken}`,
                  ],
                }),
              ),
            ),
            (acquired: Browser) =>
              runtimeEffect("close browser", () =>
                acquired.close(),
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    browserReleased = true;
                  }),
                ),
                Effect.orDie,
              ),
          );
          browserAcquired = true;
          const context = yield* Effect.acquireRelease(
            runtimeEffect("create browser context", () =>
              browser.newContext(),
            ),
            (acquired: BrowserContext) =>
              runtimeEffect("close browser context", () =>
                acquired.close(),
              ).pipe(Effect.orDie),
          );
          const page = yield* runtimeEffect(
            "create browser page",
            () => context.newPage(),
          );
          const script = yield* compileScenarioScript(
            attempt.scenario.script,
          );
          yield* runtimeEffect("execute Scenario Script", () =>
            script({
              page,
              baseUrl: environment.baseUrl,
              expect,
            }),
          ).pipe(
            Effect.timeoutFail({
              duration: environment.timeoutMs,
              onTimeout: () =>
                new ScenarioRuntimeError({
                  operation: "execute Scenario Script",
                  cause: new Error(
                    `Scenario timed out after ${environment.timeoutMs}ms`,
                  ),
                }),
            }),
          );

          const evidencePath = relative(
            stateDirectory,
            finalDirectory,
          ).replaceAll("\\", "/");
          yield* runtimeEffect("finalize Evidence Bundle", async () => {
            await writeFileDurably(
              join(stagingDirectory, "result.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                scenarioId: attempt.scenario.id,
                attemptNumber: attempt.attemptNumber,
                scriptVersion: attempt.scriptVersion,
                status: "passed",
              })}\n`,
            );
            await writeFileDurably(
              join(stagingDirectory, "manifest.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                files: ["result.json"],
              })}\n`,
            );
            await syncDirectory(stagingDirectory);
            await rename(stagingDirectory, finalDirectory);
            await syncDirectory(scenarioDirectory);
          });

          return {
            attempt: {
              scenarioId: attempt.scenario.id,
              attemptNumber: attempt.attemptNumber,
              scriptVersion: attempt.scriptVersion,
              status: "passed",
              evidencePath,
            },
          } as const;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              environment.checkpointActiveWork(
                Date.now() - activeWorkStartedAt,
              );
            }),
          ),
        ),
      ),
      Effect.suspend(() =>
        !browserAcquired || browserReleased
          ? runtimeEffect("clear browser registry", async () => {
              await rm(registryPath).catch(
                (cause: NodeJS.ErrnoException) => {
                  if (cause.code !== "ENOENT") throw cause;
                },
              );
              await syncDirectory(stateDirectory);
            }).pipe(Effect.orDie)
          : Effect.void,
      ),
    );
  },
});
