import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  RunReportError,
  type RunReporter,
} from "./runReporter.js";
import {
  syncDirectory,
  writeFileDurably,
} from "./durableFile.js";

export const makeFileRunReporter = (
  stateDirectory: string,
): RunReporter => ({
  writePassingReport: (runId, attempts) =>
    Effect.tryPromise({
      try: async () => {
        const runDirectory = join(
          stateDirectory,
          "runs",
          runId,
        );
        await mkdir(runDirectory, { recursive: true });
        const attemptLines = attempts.map(
          (attempt) =>
            `- ${attempt.scenarioId}: Attempt ${attempt.attemptNumber}, Script Version ${attempt.scriptVersion}, ${attempt.status}`,
        );
        await writeFileDurably(
          join(runDirectory, "report.md"),
          `# Auto-QA Run ${runId}\n\nRun Outcome: passed\n\n${attemptLines.join("\n")}\n`,
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
