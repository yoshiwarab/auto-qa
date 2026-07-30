export const compileScenarioScript = <
  Script extends CallableFunction = CallableFunction,
>(
  source: string,
): Script => {
  const candidate = Function(
    `"use strict"; return (${source});`,
  )();
  if (typeof candidate !== "function") {
    throw new Error("Scenario Script must evaluate to a function");
  }
  return candidate as Script;
};

export const validateScenarioScriptSource = (
  source: unknown,
): string => {
  if (typeof source !== "string") {
    throw new Error("Scenario Script source must be a string");
  }
  compileScenarioScript(source);
  return source;
};
