import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { join } from "node:path";
import {
  Data,
  Effect,
  Schedule,
  type Duration,
  type Scope,
} from "effect";

export type QaLabProcess = {
  readonly baseUrl: URL;
  readonly isRunning: () => boolean;
};

export type QaLabProcessLauncher = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type QaLabHarnessOptions = {
  readonly launchProcess?: QaLabProcessLauncher;
  readonly shutdownTimeout?: Duration.DurationInput;
};

export class QaLabHarnessError extends Data.TaggedError(
  "QaLabHarnessError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const hasStopped = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const signalAndAwaitExit = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): Effect.Effect<void, QaLabHarnessError> =>
  Effect.async<void, QaLabHarnessError>((resume) => {
    if (hasStopped(child)) {
      resume(Effect.void);
      return;
    }
    const removeListeners = (): void => {
      child.off("exit", finish);
      child.off("error", fail);
    };
    const finish = (): void => {
      removeListeners();
      resume(Effect.void);
    };
    const fail = (cause: Error): void => {
      removeListeners();
      resume(
        Effect.fail(
          new QaLabHarnessError({
            operation: "stop QA Lab",
            cause,
          }),
        ),
      );
    };
    child.once("exit", finish);
    child.once("error", fail);
    if (!child.kill(signal) && hasStopped(child)) {
      finish();
    }
    return Effect.sync(removeListeners);
  }).pipe(Effect.interruptible);

const stopChild = (
  child: ChildProcess,
  shutdownTimeout: Duration.DurationInput,
): Effect.Effect<void, QaLabHarnessError> =>
  signalAndAwaitExit(child, "SIGTERM").pipe(
    Effect.timeoutTo({
      duration: shutdownTimeout,
      onSuccess: () => true,
      onTimeout: () => false,
    }),
    Effect.flatMap((stopped) => {
      if (stopped) {
        return Effect.void;
      }
      return signalAndAwaitExit(child, "SIGKILL").pipe(
        Effect.timeoutFail({
          duration: shutdownTimeout,
          onTimeout: () =>
            new QaLabHarnessError({
              operation: "stop QA Lab",
              cause: new Error(
                "QA Lab did not stop after forced termination",
              ),
            }),
        }),
      );
    }),
  );

const waitForBoundAddress = (
  child: ChildProcess,
): Effect.Effect<URL, QaLabHarnessError> =>
  Effect.async<URL, QaLabHarnessError>((resume) => {
    let processOutput = "";
    const removeListeners = (): void => {
      child.stdout?.off("data", captureOutput);
      child.stderr?.off("data", captureOutput);
      child.off("error", fail);
      child.off("exit", exited);
    };
    const succeed = (baseUrl: URL): void => {
      removeListeners();
      resume(Effect.succeed(baseUrl));
    };
    const fail = (cause: unknown): void => {
      removeListeners();
      resume(
        Effect.fail(
          new QaLabHarnessError({
            operation: "start QA Lab",
            cause,
          }),
        ),
      );
    };
    const captureOutput = (chunk: Buffer): void => {
      processOutput += chunk.toString("utf8");
      const match = processOutput.match(
        /http:\/\/127\.0\.0\.1:\d+\//,
      );
      if (match?.[0] !== undefined) {
        succeed(new URL(match[0]));
      }
    };
    const exited = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      fail(
        new Error(
          `QA Lab exited before binding (code ${String(code)}, signal ${String(signal)})\n${processOutput}`,
        ),
      );
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);
    child.once("error", fail);
    child.once("exit", exited);

    return Effect.sync(removeListeners);
  }).pipe(
    Effect.timeoutFail({
      duration: "10 seconds",
      onTimeout: () =>
        new QaLabHarnessError({
          operation: "start QA Lab",
          cause: new Error(
            "QA Lab did not report a bound address before timeout",
          ),
        }),
    }),
  );

const waitUntilReachable = (
  baseUrl: URL,
): Effect.Effect<void, QaLabHarnessError> =>
  Effect.tryPromise({
    try: () => fetch(baseUrl),
    catch: (cause) =>
      new QaLabHarnessError({
        operation: "reach QA Lab",
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.void
        : Effect.fail(
            new QaLabHarnessError({
              operation: "reach QA Lab",
              cause: new Error(
                `QA Lab readiness returned HTTP ${response.status}`,
              ),
            }),
          ),
    ),
    Effect.retry(Schedule.spaced("50 millis")),
    Effect.timeoutFail({
      duration: "10 seconds",
      onTimeout: () =>
        new QaLabHarnessError({
          operation: "reach QA Lab",
          cause: new Error(
            "QA Lab did not become reachable before timeout",
          ),
        }),
    }),
  );

export const makeQaLab = (
  projectRoot: string,
  options: QaLabHarnessOptions = {},
): Effect.Effect<QaLabProcess, QaLabHarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          (options.launchProcess ?? spawn)(
            process.execPath,
            [
              join(
                projectRoot,
                "apps",
                "qa-lab",
                "node_modules",
                "vite",
                "bin",
                "vite.js",
              ),
              "preview",
              "--host",
              "127.0.0.1",
              "--port",
              "0",
              "--strictPort",
            ],
            {
              cwd: join(projectRoot, "apps", "qa-lab"),
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        catch: (cause) =>
          new QaLabHarnessError({
            operation: "start QA Lab",
            cause,
          }),
      }),
      (ownedChild) =>
        stopChild(
          ownedChild,
          options.shutdownTimeout ?? "2 seconds",
        ).pipe(Effect.orDie),
    );
    const baseUrl = yield* waitForBoundAddress(child);
    yield* waitUntilReachable(baseUrl);
    return {
      baseUrl,
      isRunning: () => !hasStopped(child),
    };
  });
