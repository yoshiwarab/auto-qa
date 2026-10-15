import { Effect } from "effect";
import { makeNodeBrowserResources } from "./nodeBrowserResources.js";
import { ScenarioRuntimeError } from "./scenarioRuntime.js";

// Internal executable, launched by Playwright through a per-launch shell shim.
// It owns only its browser process group, never a Target Application.
const main = Effect.gen(function* () {
  const stateDirectory = process.argv[2];
  if (stateDirectory === undefined)
    return yield* Effect.fail(
      new ScenarioRuntimeError({
        operation: "launch browser",
        cause: new Error("Missing browser state directory"),
      })
    );
  yield* makeNodeBrowserResources(stateDirectory).runLauncher(
    process.argv.slice(3)
  );
});

void Effect.runPromise(main).catch(() => {
  process.exitCode = 1;
});
