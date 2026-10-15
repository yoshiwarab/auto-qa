import { Data, Either } from "effect";

declare const RunIdType: unique symbol;

export type RunId = string & {
  readonly [RunIdType]: "RunId";
};

export const RunId = (value: string): RunId => value as RunId;

export type StartEvent = {
  readonly type: "start";
  readonly baseUrl: URL;
};

export type AbandonEvent = {
  readonly type: "abandon";
  readonly reason: string;
};

export type SubmitJobEvent = {
  readonly type: "submitJob";
  readonly jobId: string;
  readonly payload: unknown;
};

export type ExternalEvent =
  | StartEvent
  | AbandonEvent
  | SubmitJobEvent;

export type ChangesInspectedEvent = {
  readonly type: "changesInspected";
};

export type ScenarioBatchCompletedEvent = {
  readonly type: "scenarioBatchCompleted";
};

export type ScenarioExecutionInterruptedEvent = {
  readonly type: "scenarioExecutionInterrupted";
};

export type ReportCompletedEvent = {
  readonly type: "reportCompleted";
};

export type MachineEvent =
  | ExternalEvent
  | ChangesInspectedEvent
  | ScenarioExecutionInterruptedEvent
  | ScenarioBatchCompletedEvent
  | { readonly type: "findingsClassified" }
  | ReportCompletedEvent;
export type MachineEventType = MachineEvent["type"];

export type RunPhase =
  | "inspectingChanges"
  | "awaitingAgent"
  | "executingScenarios"
  | "reporting"
  | "completed"
  | "abandoned";
export type MachinePhase = "idle" | RunPhase;

export type MachineSnapshot = {
  readonly runId: RunId;
  readonly phase: MachinePhase;
  readonly baseUrl: URL;
};

export class InvalidTransitionError extends Data.TaggedError(
  "InvalidTransitionError",
)<{
  readonly phase: MachinePhase;
  readonly event: MachineEvent["type"];
  readonly allowedEvents: readonly MachineEvent["type"][];
}> {}

export const TRANSITIONS = {
  idle: {
    start: "inspectingChanges",
  },
  inspectingChanges: {
    changesInspected: "awaitingAgent",
    abandon: "abandoned",
  },
  awaitingAgent: {
    findingsClassified: "reporting",
    submitJob: "executingScenarios",
    abandon: "abandoned",
  },
  executingScenarios: {
    scenarioExecutionInterrupted: "awaitingAgent",
    scenarioBatchCompleted: "awaitingAgent",
  },
  reporting: {
    reportCompleted: "completed",
  },
  completed: {},
  abandoned: {},
} as const satisfies Record<
  MachinePhase,
  Partial<Record<MachineEvent["type"], MachinePhase>>
>;

export const allowedEvents = (
  phase: MachinePhase,
): readonly MachineEvent["type"][] =>
  Object.keys(TRANSITIONS[phase]) as MachineEvent["type"][];

export const step = (
  snapshot: MachineSnapshot,
  event: MachineEvent,
): Either.Either<MachineSnapshot, InvalidTransitionError> => {
  const phaseTransitions = TRANSITIONS[
    snapshot.phase
  ] as Partial<Record<MachineEvent["type"], MachinePhase>>;
  const nextPhase = phaseTransitions[event.type];

  if (nextPhase === undefined) {
    return Either.left(
      new InvalidTransitionError({
        phase: snapshot.phase,
        event: event.type,
        allowedEvents: allowedEvents(snapshot.phase),
      }),
    );
  }

  return Either.right({
    ...snapshot,
    phase: nextPhase,
  });
};
