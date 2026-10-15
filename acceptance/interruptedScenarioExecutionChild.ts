import { Effect } from "effect";
import {
  createWorkflowEngine,
  RunId,
  type ScenarioRuntime,
} from "../src/index.js";

const [databasePath, baseUrlText, jobId, payloadText] =
  process.argv.slice(2);

if (
  databasePath === undefined ||
  baseUrlText === undefined ||
  jobId === undefined ||
  payloadText === undefined
) {
  throw new Error(
    "Interrupted execution child requires database path, Base URL, Job id, and payload",
  );
}

const heldRuntime: ScenarioRuntime = {
  reconcile: () => Effect.void,
  execute: (attempt) =>
    Effect.async(() => {
      process.send?.({
        type: "runtime-started",
        scenarioId: attempt.scenario.id,
        attemptNumber: attempt.attemptNumber,
        scriptVersion: attempt.scriptVersion,
      });
      return Effect.void;
    }),
};

const payload: unknown = JSON.parse(payloadText);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* createWorkflowEngine({
        databasePath,
        changeInspector: { inspect: () => Effect.succeed([]) },
        scenarioRuntime: heldRuntime,
        runReporter: { writeReport: () => Effect.void },
      });
      return yield* engine.dispatch(RunId("interrupted-execution"), {
        type: "submitJob",
        jobId,
        payload,
      });
    }),
  ),
);
