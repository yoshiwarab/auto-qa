// Exploratory dogfooding, deliberately separate from deterministic test gates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { Data, Effect } from "effect";
import { makeQaLab } from "../../dist/acceptance/qaLabHarness.js";

const exec = promisify(execFile);
const project = process.cwd();
const planPath = resolve(
  process.argv[2] ?? "experiments/plan-details/plan.json"
);
class TrialError extends Data.TaggedError("TrialError") {}
const work = (operation, fn) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new TrialError({ operation, cause }),
  });
const command = (file, args, cwd) =>
  exec(file, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });

const details = `
        <details className="plan-details">
          <summary>View plan details</summary>
          <div className="plan-details-content">
            <h3>Plan details</h3>
            <p>Billing cycle: Monthly</p>
            <p>Price: $48 per month</p>
            <p>Included seats: 20</p>
          </div>
        </details>`;
const styling = `
.plan-details { margin-top: 20px; }
.plan-details summary { cursor: pointer; color: #2d6845; font-weight: 750; }
.plan-details-content { margin-top: 16px; padding: 16px; color: #17211b; background: #fff; border: 1px solid #d6ded8; border-radius: 8px; }
.plan-details-content p:last-child { margin-bottom: 0; }
`;

await Effect.runPromise(
  Effect.gen(function* () {
    const output = yield* work("prepare trial", async () => {
      await mkdir(join(project, "reports"), { recursive: true });
      return mkdtemp(join(project, "reports", "dogfood-plan-details-"));
    });
    console.log(`Trial output: ${output}`);
    const plan = yield* work("freeze plan and pack CLI", async () => {
      const source = await readFile(planPath, "utf8");
      JSON.parse(source);
      await writeFile(join(output, "plan.json"), source);
      await writeFile(
        join(output, "plan.sha256"),
        createHash("sha256").update(source).digest("hex") + "\n"
      );
      await command(
        "pnpm",
        ["pack", "--pack-destination", output, "--silent"],
        project
      );
      await command(
        "tar",
        ["-xzf", join(output, "auto-qa-0.0.0.tgz"), "-C", output],
        project
      );
      return join(output, "plan.json");
    });
    const cli = join(output, "package", "dist", "src", "cli.js");
    const cliCall = async (cwd, args) => {
      const started = Date.now();
      try {
        const result = await exec(process.execPath, [cli, ...args], {
          cwd,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: join(
              project,
              "tmp",
              "playwright-browsers"
            ),
          },
        });
        return {
          args,
          exitCode: 0,
          durationMs: Date.now() - started,
          ...result,
        };
      } catch (cause) {
        if (!(cause instanceof Error) || !("stdout" in cause)) throw cause;
        return {
          args,
          exitCode: cause.code,
          durationMs: Date.now() - started,
          stdout: cause.stdout,
          stderr: cause.stderr,
        };
      }
    };
    // Stable case labels allow blind assessment before consulting this seed map.
    for (const [name, fault] of [
      ["case-a", "visual"],
      ["case-b", "clean"],
      ["case-c", "interaction"],
    ]) {
      const root = join(output, name);
      yield* work(`prepare ${name}`, async () => {
        const app = join(root, "apps", "qa-lab");
        await mkdir(app, { recursive: true });
        for (const path of [
          "src",
          "public",
          "index.html",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
        ])
          await cp(join(project, "apps", "qa-lab", path), join(app, path), {
            recursive: true,
          });
        await symlink(
          join(project, "apps", "qa-lab", "node_modules"),
          join(app, "node_modules")
        );
        await writeFile(
          join(root, ".gitignore"),
          "node_modules/\ndist/\n.auto-qa/\n"
        );
        await command("git", ["init", "--quiet"], root);
        await command("git", ["add", "."], root);
        await command(
          "git",
          [
            "-c",
            "user.name=Auto-QA Trial",
            "-c",
            "user.email=trial@example.test",
            "commit",
            "--quiet",
            "-m",
            "QA Lab baseline",
          ],
          root
        );
        const sourcePath = join(app, "src", "main.tsx");
        const source = await readFile(sourcePath, "utf8");
        const marker = '<p className="muted">Renews on September 18, 2026</p>';
        if (!source.includes(marker))
          throw new Error("QA Lab baseline changed; review trial fixture");
        const implementation =
          fault === "interaction"
            ? details.replace(
                "<summary>",
                "<summary onClick={(event) => event.preventDefault()}>"
              )
            : details;
        await writeFile(
          sourcePath,
          source.replace(marker, marker + implementation)
        );
        const cssPath = join(app, "src", "styles.css");
        const css = await readFile(cssPath, "utf8");
        await writeFile(
          cssPath,
          css +
            styling +
            (fault === "visual"
              ? "\n.plan-details-content, .plan-details-content * { color: #fff; }\n"
              : "")
        );
        const diff = await command(
          "git",
          ["diff", "--", "apps/qa-lab/src"],
          root
        );
        await writeFile(join(output, `${name}.patch`), diff.stdout);
        await command(
          process.execPath,
          [
            join(
              project,
              "apps",
              "qa-lab",
              "node_modules",
              "typescript",
              "bin",
              "tsc"
            ),
            "--noEmit",
          ],
          app
        );
        await command(
          process.execPath,
          [join(app, "node_modules", "vite", "bin", "vite.js"), "build"],
          app
        );
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const target = yield* makeQaLab(root);
          yield* work(`exercise ${name}`, async () => {
            const transcript = [];
            const record = async (args) => {
              const response = await cliCall(root, args);
              transcript.push(response);
              await writeFile(
                join(output, `${name}.json`),
                JSON.stringify(transcript, null, 2) + "\n"
              );
              return JSON.parse(response.stdout);
            };
            try {
              const started = await record([
                "start",
                "--base-url",
                target.baseUrl.href,
              ]);
              if (!started.ok) throw new Error(`start failed for ${name}`);
              const { runId, job } = started.result;
              await record(["job", runId]);
              const submission = [
                "submit",
                runId,
                "--job-id",
                job.id,
                "--file",
                plan,
              ];
              const submitted = await record(submission);
              await record(["status", runId]);
              await record(["job", runId]);
              if (!submitted.ok) {
                // An explicit repeated submission probes recovery; it is not a
                // hidden browser retry or a changed plan.
                await record(submission);
                await record(["status", runId]);
                await record(["job", runId]);
              }
            } finally {
              await record(["cleanup"]);
              const state = join(root, ".auto-qa");
              const facts = {
                targetStillRunning: target.isRunning(),
                targetReachable: (await globalThis.fetch(target.baseUrl)).ok,
                runtimeEntries: await readdir(join(state, "runtime")).catch(
                  (cause) => {
                    if (cause.code === "ENOENT") return [];
                    throw cause;
                  }
                ),
                registryPresent: (await readdir(state)).includes(
                  "registry.json"
                ),
              };
              await writeFile(
                join(output, `${name}-resources.json`),
                JSON.stringify(facts, null, 2) + "\n"
              );
              console.log(name, JSON.stringify(facts));
            }
          });
        })
      );
    }
  })
);
