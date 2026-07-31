import { spawn } from "node:child_process";
import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  makeQaLab,
  type QaLabProcessLauncher,
} from "../acceptance/qaLabHarness.js";

const projectRoot = process.cwd();

test("QA Lab reports synchronous process launch failures as harness errors", async () => {
  const launchFailure = new Error("process launch failed");

  const result = await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        makeQaLab(projectRoot, {
          launchProcess: () => {
            throw launchFailure;
          },
        }),
      ),
    ),
  );

  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "QaLabHarnessError",
      operation: "start QA Lab",
      cause: launchFailure,
    },
  });
});

test("QA Lab forces a child to stop after graceful shutdown times out", async () => {
  const harnessSignals: Array<NodeJS.Signals> = [];
  const launchProcess: QaLabProcessLauncher = (
    command,
    args,
    options,
  ) => {
    const child = spawn(command, args, options);
    const kill = child.kill.bind(child);
    let safetyKill: NodeJS.Timeout | undefined;
    child.kill = (signal = "SIGTERM"): boolean => {
      if (typeof signal === "number") {
        return kill(signal);
      }
      harnessSignals.push(signal);
      if (signal === "SIGTERM") {
        safetyKill = setTimeout(() => {
          kill("SIGKILL");
        }, 500).unref();
        return true;
      }
      if (safetyKill !== undefined) {
        clearTimeout(safetyKill);
      }
      return kill(signal);
    };
    return child;
  };

  const releasedQaLab = await Effect.runPromise(
    Effect.scoped(
      makeQaLab(projectRoot, {
        launchProcess,
        shutdownTimeout: "50 millis",
      }),
    ),
  );

  expect(harnessSignals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(releasedQaLab.isRunning()).toBe(false);
});
