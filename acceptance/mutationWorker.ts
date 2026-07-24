import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type MutationJob = {
  readonly id: string;
  readonly feature_json: string;
  readonly generated_dir: string;
  readonly work_dir: string;
  readonly timeout: string;
};

type MutationOutcome =
  | "test_success"
  | "test_failure"
  | "infrastructure_error";

type MutationResponse = {
  readonly id: string;
  readonly outcome: MutationOutcome;
  readonly output: string;
  readonly error: string;
  readonly duration: number;
};

const durationMilliseconds = (duration: string): number | undefined => {
  const match = /^([0-9]+)(ms|s|m)$/.exec(duration);
  if (match === null) {
    return undefined;
  }

  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
  }
  return undefined;
};

const runMutation = (
  job: MutationJob,
  featureStem: string,
): Promise<MutationResponse> => {
  const startedAt = process.hrtime.bigint();
  const projectRoot = process.cwd();
  const vitestEntrypoint = resolve(
    projectRoot,
    "node_modules/vitest/vitest.mjs",
  );
  const vitestConfig = resolve(
    projectRoot,
    "vitest.acceptance.config.ts",
  );

  return new Promise((complete) => {
    const child = spawn(
      process.execPath,
      [
        vitestEntrypoint,
        "run",
        "--config",
        vitestConfig,
        resolve(
          projectRoot,
          job.generated_dir,
          `${featureStem}.acceptance.test.ts`,
        ),
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          AUTO_QA_ACCEPTANCE_FEATURE_JSON: resolve(
            projectRoot,
            job.feature_json,
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let error = "";
    let timedOut = false;
    let settled = false;
    const timeout = durationMilliseconds(job.timeout);
    const timeoutHandle =
      timeout === undefined || timeout === 0
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      error += chunk;
    });

    const finish = (
      outcome: MutationOutcome,
      infrastructureError = error,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      complete({
        id: job.id,
        outcome,
        output,
        error: infrastructureError,
        duration: Number(process.hrtime.bigint() - startedAt),
      });
    };

    child.once("error", (cause) => {
      finish("infrastructure_error", String(cause));
    });
    child.once("close", (exitCode, signal) => {
      if (timedOut) {
        finish(
          "infrastructure_error",
          `Acceptance mutation timed out after ${job.timeout}`,
        );
      } else if (signal !== null) {
        finish(
          "infrastructure_error",
          `Acceptance runner exited from signal ${signal}`,
        );
      } else {
        finish(exitCode === 0 ? "test_success" : "test_failure");
      }
    });
  });
};

const parseJob = (line: string): MutationJob =>
  JSON.parse(line) as MutationJob;

const writeResponse = (response: MutationResponse): void => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

const main = async (): Promise<void> => {
  const featureStem = process.argv[2];
  if (featureStem === undefined) {
    process.stderr.write(
      "Usage: acceptance-mutation-worker <feature-stem>\n",
    );
    process.exitCode = 2;
    return;
  }

  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.trim() === "") {
      continue;
    }

    try {
      writeResponse(
        await runMutation(parseJob(line), featureStem),
      );
    } catch (cause) {
      const id = (() => {
        try {
          return parseJob(line).id;
        } catch {
          return "unknown";
        }
      })();
      writeResponse({
        id,
        outcome: "infrastructure_error",
        output: "",
        error: cause instanceof Error ? cause.message : String(cause),
        duration: 0,
      });
    }
  }
};

await main();
