export type GherkinStep = {
  readonly keyword: "Given" | "When" | "Then" | "And";
  readonly text: string;
  readonly parameters?: readonly string[];
};

export type GherkinScenario = {
  readonly name: string;
  readonly steps: readonly GherkinStep[];
  readonly examples: readonly Readonly<Record<string, string>>[];
};

export type GherkinFeature = {
  readonly name: string;
  readonly background?: readonly GherkinStep[];
  readonly scenarios: readonly GherkinScenario[];
};
