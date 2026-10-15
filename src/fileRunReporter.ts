import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { RunReportError, type RunReporter } from "./runReporter.js";
import { syncDirectory, writeFileDurably } from "./durableFile.js";

export const makeFileRunReporter = (stateDirectory: string): RunReporter => ({
  writeReport: (runId, result) =>
    Effect.tryPromise({
      try: async () => {
        const runDirectory = join(stateDirectory, "runs", runId);
        await mkdir(runDirectory, { recursive: true });
        const attemptLines = result.attempts.map(
          (attempt) =>
            `- ${attempt.scenarioId}: Attempt ${attempt.attemptNumber}, Script Version ${attempt.scriptVersion}, ${attempt.status}`
        );
        await writeFileDurably(
          join(runDirectory, "report.md"),
          `# Auto-QA Run ${runId}\n\nRun Outcome: ${result.outcome}\n\nCoverage incomplete: ${result.coverageIncomplete}\nIncomplete Scenarios: ${result.incompleteScenarios.join(", ") || "none"}\n\n${attemptLines.join("\n")}\n\n${result.classifications.map((item) => `- ${item.findingId}: ${item.classification}. ${item.reasoning}`).join("\n")}\n`
        );
        await writeFileDurably(
          join(runDirectory, "report.json"),
          `${JSON.stringify(result)}\n`
        );
        await syncDirectory(runDirectory);
      },
      catch: (cause) =>
        new RunReportError({
          operation: "write Run report",
          cause,
        }),
    }),
});
