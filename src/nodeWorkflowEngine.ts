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
import type { ProcessIdentity } from "./processIdentity.js";
import {
  readCurrentProcessIdentity,
  type ProcessIdentityError,
} from "./processIdentity.js";

const makeTurnOwner = (): Effect.Effect<
  TurnOwner,
  ProcessIdentityError
> =>
  Effect.map(readCurrentProcessIdentity(), (identity) => ({
    ...identity,
    ownershipToken: randomUUID(),
  }));

export const createWorkflowEngine = ({
  databasePath,
  changeInspector,
  turnOwnerFactory,
  processIdentity,
  readOnly = false,
  scenarioRuntime,
  runReporter,
  planLimits = DEFAULT_PLAN_LIMITS,
}: {
  readonly databasePath: string;
  readonly changeInspector: ChangeInspector;
  readonly turnOwnerFactory?: () => TurnOwner;
  readonly processIdentity?: ProcessIdentity;
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
    openSqliteRunStore(databasePath, {
      readOnly,
      ...(processIdentity === undefined
        ? {}
        : { processIdentity }),
    }),
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
        makeTurnOwner:
          turnOwnerFactory === undefined
            ? makeTurnOwner
            : () => Effect.sync(turnOwnerFactory),
      }),
  );
};
