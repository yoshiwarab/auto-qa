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
): Either.Either<
  readonly ScenarioSubmission[],
  PlanValidationError
> => {
  if (submission.scenarios.length === 0) {
    return Either.left(
      new PlanValidationError({
        scenarioId: "<unknown>",
        field: "id",
        message: "A generate-plan submission requires a Scenario",
      }),
    );
  }
  const scenarios: ScenarioSubmission[] = [];
  const scenarioIds = new Set<string>();
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
    if (scenarioIds.has(id)) {
      return Either.left(
        new PlanValidationError({
          scenarioId: id,
          field: "id",
          message: `Scenario ${id} has a duplicate required field id`,
        }),
      );
    }
    scenarioIds.add(id);

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
    if (
      typeof candidate["goal"] !== "string" ||
      !Array.isArray(candidate["preconditions"]) ||
      !candidate["preconditions"].every(
        (value) => typeof value === "string",
      ) ||
      typeof candidate["mutates"] !== "boolean" ||
      typeof candidate["script"] !== "string"
    ) {
      const field = requiredScenarioFields.find((required) => {
        const value = candidate[required];
        return required === "goal" || required === "script"
          ? typeof value !== "string"
          : required === "mutates"
          ? typeof value !== "boolean"
          : !Array.isArray(value) ||
              !value.every((entry) => typeof entry === "string");
      });
      return Either.left(
        new PlanValidationError({
          scenarioId: id,
          field: field ?? "goal",
          message: `Scenario ${id} has invalid required field ${field ?? "goal"}`,
        }),
      );
    }
    scenarios.push({
      id,
      goal: candidate["goal"],
      preconditions: candidate["preconditions"],
      mutates: candidate["mutates"],
      script: candidate["script"],
    });
    if (candidate["mutates"]) {
      return Either.left(
        new PlanValidationError({
          scenarioId: id,
          field: "mutates",
          message: `Scenario ${id} requires mutation permission`,
        }),
      );
    }
    try {
      const compiled = Function(
        `"use strict"; return (${candidate["script"]});`,
      )();
      if (typeof compiled !== "function") {
        throw new Error("Scenario Script is not a function");
      }
    } catch {
      return Either.left(
        new PlanValidationError({
          scenarioId: id,
          field: "script",
          message: `Scenario ${id} has invalid required field script`,
        }),
      );
    }
  }

  return Either.right(scenarios);
};
