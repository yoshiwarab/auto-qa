import { randomUUID } from "node:crypto";
import { Effect, Scope } from "effect";
import { openSqliteRunStore } from "./sqliteRunStore.js";
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
}: {
  readonly databasePath: string;
  readonly changeInspector: ChangeInspector;
  readonly turnOwnerFactory?: () => TurnOwner;
}): Effect.Effect<
  WorkflowEngine,
  WorkflowStoreError,
  Scope.Scope
> =>
  Effect.map(openSqliteRunStore(databasePath), (runStore) =>
    makeWorkflowEngine({
      runStore,
      changeInspector,
      makeTurnOwner: turnOwnerFactory,
    }),
  );
