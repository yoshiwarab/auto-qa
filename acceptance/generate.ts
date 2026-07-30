import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { GherkinFeature } from "./types.js";

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const metadataName = (featurePath: string): string =>
  `${featurePath
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")}.json`;

export const generateDurablePlanEntrypoint = async (
  irPath: string,
  outputDirectory: string,
): Promise<void> => {
  const feature = JSON.parse(
    await readFile(irPath, "utf8"),
  ) as GherkinFeature;
  const stem = basename(irPath, ".json");
  const generatedFile = join(
    outputDirectory,
    `${stem}.acceptance.test.ts`,
  );
  const featurePath = normalizePath(join("features", `${stem}.feature`));
  const binding =
    stem === "passing-scenario-completes-run"
      ? {
          module: "passingScenarioCompletesRun",
          name: "passingScenarioCompletesRun",
        }
      : stem === "atomic-generate-plan-rejection"
      ? {
          module: "atomicGeneratePlanRejection",
          name: "atomicGeneratePlanRejection",
        }
      : stem === "workflow-engine-fenced-turn"
      ? {
          module: "workflowFencedTurn",
          name: "workflowFencedTurn",
        }
      : stem === "cli-requires-git-worktree"
      ? {
          module: "cliRequiresGitWorktree",
          name: "cliRequiresGitWorktree",
        }
      : stem.startsWith("cli-")
      ? {
          module: "cliDurableGeneratePlanHandoff",
          name: "cliDurableGeneratePlanHandoff",
        }
      : {
          module: "durableGeneratePlanHandoff",
          name: "durableGeneratePlanHandoff",
        };
  const generatedSource = `import { registerFeature } from "../../../acceptance/runtime.js";
import { ${binding.name} } from "../../../acceptance/${binding.module}.js";

const feature = ${JSON.stringify(feature, null, 2)} as const;

registerFeature(feature, ${binding.name});
`;

  await mkdir(join(outputDirectory, "metadata"), { recursive: true });
  await writeFile(generatedFile, generatedSource, "utf8");

  const generatedPath = normalizePath(relative(process.cwd(), generatedFile));
  const metadata = {
    schema_version: 1,
    feature_path: featurePath,
    ir_path: normalizePath(relative(process.cwd(), irPath)),
    implementation_hash: `sha256:${createHash("sha256")
      .update(generatedSource)
      .digest("hex")}`,
    hash_scope: "generated_files",
    generated_files: [generatedPath],
  };

  await writeFile(
    join(outputDirectory, "metadata", metadataName(featurePath)),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
};

const main = async (): Promise<void> => {
  const [irPath, outputDirectory, ...unexpected] = process.argv.slice(2);
  if (
    irPath === undefined ||
    outputDirectory === undefined ||
    unexpected.length > 0
  ) {
    process.stderr.write(
      "Usage: acceptance-entrypoint-generator <json-ir> <generated-test-output>\n",
    );
    process.exitCode = 2;
    return;
  }

  try {
    await generateDurablePlanEntrypoint(irPath, outputDirectory);
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
