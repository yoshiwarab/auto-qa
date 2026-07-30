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
