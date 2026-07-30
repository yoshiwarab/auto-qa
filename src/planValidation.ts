import { Data, Either } from "effect";

export type ScenarioSubmission = {
  readonly id: string;
  readonly goal: string;
  readonly preconditions: readonly string[];
  readonly mutates: boolean;
  readonly script: string;
};

export type GeneratePlanSubmission = {
  readonly schemaVersion: 1;
  readonly scenarios: readonly unknown[];
};

export class PlanValidationError extends Data.TaggedError(
  "PlanValidationError",
)<{
  readonly scenarioId: string;
  readonly field: keyof ScenarioSubmission;
  readonly message: string;
}> {}

const requiredScenarioFields = [
  "id",
  "goal",
  "preconditions",
  "mutates",
  "script",
] as const satisfies readonly (keyof ScenarioSubmission)[];

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};

export const validateGeneratePlan = (
  submission: GeneratePlanSubmission,
): Either.Either<void, PlanValidationError> => {
  for (const scenario of submission.scenarios) {
    const candidate = asRecord(scenario);
    const scenarioId =
      typeof candidate["id"] === "string" &&
      candidate["id"].length > 0
        ? candidate["id"]
        : "<unknown>";

    for (const field of requiredScenarioFields) {
      if (!(field in candidate)) {
        return Either.left(
          new PlanValidationError({
            scenarioId,
            field,
            message: `Scenario ${scenarioId} is missing required field ${field}`,
          }),
        );
      }
    }
  }

  return Either.right(undefined);
};
