import { Data, Either } from "effect";
import { compileScenarioScript } from "./scenarioScript.js";

export type PlanLimits = {
  readonly maxScenarios: number;
  readonly scenarioTimeoutMs: number;
  readonly activeWorkBudgetMs: number;
};

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxScenarios: 20,
  scenarioTimeoutMs: 30_000,
  activeWorkBudgetMs: 300_000,
};

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

export type PlanValidationField =
  | keyof ScenarioSubmission
  | "schemaVersion"
  | "scenarios";

export class PlanValidationError extends Data.TaggedError(
  "PlanValidationError",
)<{
  readonly scenarioId: string;
  readonly field: PlanValidationField;
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
  submission: unknown,
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
): Either.Either<
  readonly ScenarioSubmission[],
  PlanValidationError
> => {
  const record = asRecord(submission);
  if (record["schemaVersion"] !== 1) {
    return Either.left(
      new PlanValidationError({
        scenarioId: "<submission>",
        field: "schemaVersion",
        message:
          "generate-plan submission requires schemaVersion 1",
      }),
    );
  }
  const submittedScenarios = record["scenarios"];
  if (!Array.isArray(submittedScenarios)) {
    return Either.left(
      new PlanValidationError({
        scenarioId: "<submission>",
        field: "scenarios",
        message:
          "generate-plan submission requires a scenarios array",
      }),
    );
  }
  if (submittedScenarios.length === 0) {
    return Either.left(
      new PlanValidationError({
        scenarioId: "<unknown>",
        field: "id",
        message: "A generate-plan submission requires a Scenario",
      }),
    );
  }
  if (submittedScenarios.length > limits.maxScenarios) {
    return Either.left(
      new PlanValidationError({
        scenarioId: "<submission>",
        field: "scenarios",
        message: `generate-plan submission exceeds the Scenario limit of ${limits.maxScenarios}`,
      }),
    );
  }
  const scenarios: ScenarioSubmission[] = [];
  const scenarioIds = new Set<string>();
  for (const scenario of submittedScenarios) {
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
      compileScenarioScript(candidate["script"]);
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
