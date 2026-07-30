import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Effect, Scope } from "effect";
import { openSqliteRunStore } from "./sqliteRunStore.js";
import { makeFileRunReporter } from "./fileRunReporter.js";
import { makePlaywrightScenarioRuntime } from "./playwrightScenarioRuntime.js";
import {
  DEFAULT_PLAN_LIMITS,
  type PlanLimits,
} from "./planValidation.js";
import type { RunReporter } from "./runReporter.js";
import type { ScenarioRuntime } from "./scenarioRuntime.js";
import {
  makeWorkflowEngine,
  type ChangeInspector,
  type WorkflowEngine,
} from "./workflowEngine.js";
import type {
  TurnOwner,
  WorkflowStoreError,
} from "./runStore.js";

const makeTurnOwner = (): TurnOwner => ({
  processId: process.pid,
  processStartedAt: new Date(
    Date.now() - process.uptime() * 1_000,
  ).toISOString(),
  ownershipToken: randomUUID(),
});

export const createWorkflowEngine = ({
  databasePath,
  changeInspector,
  turnOwnerFactory = makeTurnOwner,
  readOnly = false,
  scenarioRuntime,
  runReporter,
  planLimits = DEFAULT_PLAN_LIMITS,
}: {
  readonly databasePath: string;
  readonly changeInspector: ChangeInspector;
  readonly turnOwnerFactory?: () => TurnOwner;
  readonly readOnly?: boolean;
  readonly scenarioRuntime?: ScenarioRuntime;
  readonly runReporter?: RunReporter;
  readonly planLimits?: PlanLimits;
}): Effect.Effect<
  WorkflowEngine,
  WorkflowStoreError,
  Scope.Scope
> => {
  const stateDirectory = dirname(databasePath);
  return Effect.map(
    openSqliteRunStore(databasePath, { readOnly }),
    (runStore) =>
      makeWorkflowEngine({
        runStore,
        changeInspector,
        scenarioRuntime:
          scenarioRuntime ??
          makePlaywrightScenarioRuntime(stateDirectory),
        runReporter:
          runReporter ?? makeFileRunReporter(stateDirectory),
        planLimits,
        makeTurnOwner: turnOwnerFactory,
      }),
  );
};
