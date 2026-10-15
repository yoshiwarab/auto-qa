// Supplemental observations, NOT Auto-QA evidence or credit for its pipeline.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { Data, Effect } from "effect";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { makeQaLab } from "../../dist/acceptance/qaLabHarness.js";

class DiagnosticError extends Data.TaggedError("DiagnosticError") {}
const work = (operation, fn) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new DiagnosticError({ operation, cause }),
  });
if (!process.argv[2]) throw new Error("Pass the trial output directory");
const output = resolve(process.argv[2]);
const plan = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(
  process.cwd(),
  "tmp",
  "playwright-browsers"
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        work("launch supplemental browser", () => chromium.launch()),
        (owned) =>
          work("close supplemental browser", () => owned.close()).pipe(
            Effect.orDie
          )
      );
      for (const name of ["case-a", "case-b", "case-c"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const target = yield* makeQaLab(join(output, name));
            for (const scenario of plan.scenarios) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* Effect.acquireRelease(
                    work("open supplemental context", () =>
                      browser.newContext()
                    ),
                    (owned) =>
                      work("close supplemental context", () =>
                        owned.close()
                      ).pipe(Effect.orDie)
                  );
                  yield* work(
                    "observe frozen Scenario independently",
                    async () => {
                      const folder = join(
                        output,
                        "supplemental",
                        name,
                        scenario.id
                      );
                      await mkdir(folder, { recursive: true });
                      const page = await context.newPage();
                      page.setDefaultTimeout(8000);
                      let result;
                      try {
                        const script = Function(
                          `"use strict"; return (${scenario.script});`
                        )();
                        await script({ page, baseUrl: target.baseUrl, expect });
                        result = { status: "passed" };
                      } catch (cause) {
                        result = {
                          status: "failed",
                          name: cause.name,
                          message: cause.message,
                        };
                      }
                      await page.screenshot({
                        path: join(folder, "page.png"),
                        fullPage: true,
                      });
                      await writeFile(
                        join(folder, "accessibility.yaml"),
                        await page.locator("body").ariaSnapshot()
                      );
                      await writeFile(
                        join(folder, "result.json"),
                        JSON.stringify(
                          {
                            provenance:
                              "Supplemental Playwright observation, outside Auto-QA",
                            viewport: page.viewportSize(),
                            ...result,
                          },
                          null,
                          2
                        ) + "\n"
                      );
                      console.log(name, scenario.id, result.status);
                    }
                  );
                })
              );
            }
          })
        );
      }
    })
  )
);
