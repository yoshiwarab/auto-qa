import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ChangeInspector,
  RunId,
  createWorkflowEngine,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const parent = join(process.cwd(), "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "workflow-engine-"));
  temporaryDirectories.push(directory);
  return directory;
};

const withHarnessBaseUrl = async <Result>(
  use: (baseUrl: URL) => Promise<Result>,
): Promise<Result> => {
  const targetApplication = createServer((_request, response) => {
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    targetApplication.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = targetApplication.address() as AddressInfo;
    return await use(new URL(`http://127.0.0.1:${address.port}`));
  } finally {
    await new Promise<void>((resolve, reject) => {
      targetApplication.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true }),
    ),
  );
});

describe("WorkflowEngine durable generate-plan handoff", () => {
  test("a restarted engine returns the generate-plan Job created by start", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "state.db");
    const runId = RunId("run-001");
    const changeInspector: ChangeInspector = {
      inspect: () =>
        Effect.succeed([
          { kind: "modified", path: "src/dashboard.tsx" },
        ] as const),
    };

    await withHarnessBaseUrl(async (baseUrl) => {
      const expectedJob = {
        schemaVersion: 1,
        id: "run-001:generate-plan:1",
        type: "generate-plan",
        runId: "run-001",
        payload: {
          baseUrl: baseUrl.href,
          changes: [{ kind: "modified", path: "src/dashboard.tsx" }],
        },
      };

      const dispatchResult = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector,
            });
            return yield* engine.dispatch(runId, {
              type: "start",
              baseUrl,
            });
          }),
        ),
      );

      expect(dispatchResult).toEqual({
        phase: "awaitingAgent",
        pendingJob: expectedJob,
      });

      const restartedState = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* createWorkflowEngine({
              databasePath,
              changeInspector,
            });
            return {
              job: yield* engine.getPendingJob(runId),
              status: yield* engine.getStatus(runId),
            };
          }),
        ),
      );

      expect(restartedState).toEqual({
        job: expectedJob,
        status: {
          runId: "run-001",
          phase: "awaitingAgent",
        },
      });
    });
  });
});
