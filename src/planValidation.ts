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

    if (!("id" in candidate)) {
      return Either.left(
        new PlanValidationError({
          scenarioId: "<unknown>",
          field: "id",
          message: "Scenario <unknown> is missing required field id",
        }),
      );
    }

    const id = candidate["id"];
    if (typeof id !== "string" || id.length === 0) {
      return Either.left(
        new PlanValidationError({
          scenarioId: "<unknown>",
          field: "id",
          message: "Scenario <unknown> has invalid required field id",
        }),
      );
    }

    for (const field of requiredScenarioFields) {
      if (!(field in candidate)) {
        return Either.left(
          new PlanValidationError({
            scenarioId: id,
            field,
            message: `Scenario ${id} is missing required field ${field}`,
          }),
        );
      }
    }
  }

  return Either.right(undefined);
};
