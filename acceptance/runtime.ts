import { readFileSync } from "node:fs";
import { Effect, Scope } from "effect";
import { describe, test } from "vitest";
import type {
  GherkinFeature,
  GherkinStep,
} from "./types.js";

export type StepHandler<World> = {
  readonly pattern: RegExp;
  readonly run: (
    world: World,
    example: Readonly<Record<string, string>>,
    captures: readonly string[],
  ) => Effect.Effect<void, unknown>;
};

export type FeatureBindings<World> = {
  readonly makeWorld: Effect.Effect<World, unknown, Scope.Scope>;
  readonly handlers: readonly StepHandler<World>[];
};

export const exampleValue = (
  example: Readonly<Record<string, string>>,
  name: string | undefined,
): string => {
  const value = name === undefined ? undefined : example[name];
  if (value === undefined) {
    throw new Error(`Missing example: ${name}`);
  }
  return value;
};

const featureForCurrentRun = (
  generatedFeature: GherkinFeature,
): GherkinFeature => {
  const mutationFeaturePath =
    process.env["AUTO_QA_ACCEPTANCE_FEATURE_JSON"];
  if (mutationFeaturePath === undefined) {
    return generatedFeature;
  }

  return JSON.parse(
    readFileSync(mutationFeaturePath, "utf8"),
  ) as GherkinFeature;
};

const executeStep = <World>(
  step: GherkinStep,
  example: Readonly<Record<string, string>>,
  world: World,
  handlers: readonly StepHandler<World>[],
): Effect.Effect<void, unknown> => {
  const matches = handlers.flatMap((handler) => {
    const match = handler.pattern.exec(step.text);
    return match === null
      ? []
      : [{ handler, captures: match.slice(1) }];
  });

  if (matches.length !== 1) {
    return Effect.fail(
      new Error(
        matches.length === 0
          ? `Unsupported acceptance step: ${step.text}`
          : `Ambiguous acceptance step: ${step.text}`,
      ),
    );
  }

  const match = matches[0];
  return match === undefined
    ? Effect.fail(new Error(`Unsupported acceptance step: ${step.text}`))
    : match.handler.run(world, example, match.captures);
};

export const registerFeature = <World>(
  generatedFeature: GherkinFeature,
  bindings: FeatureBindings<World>,
): void => {
  const feature = featureForCurrentRun(generatedFeature);
  describe(feature.name, () => {
    for (const scenario of feature.scenarios) {
      const examples =
        scenario.examples.length === 0 ? [{}] : scenario.examples;

      examples.forEach((example, exampleIndex) => {
        test(`${scenario.name}/example_${exampleIndex + 1}`, async () => {
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const world = yield* bindings.makeWorld;
                const steps = [
                  ...(feature.background ?? []),
                  ...scenario.steps,
                ];

                for (const step of steps) {
                  yield* executeStep(
                    step,
                    example,
                    world,
                    bindings.handlers,
                  );
                }
              }),
            ),
          );
        });
      });
    }
  });
};
