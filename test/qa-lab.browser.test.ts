import { chromium, type Browser } from "playwright";
import { expect as playwrightExpect } from "playwright/test";
import { Effect } from "effect";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "vitest";
import { makeQaLab } from "../acceptance/qaLabHarness.js";

const projectRoot = process.cwd();
let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
});

afterAll(async () => {
  await browser?.close();
});

test("QA Lab supports deterministic Account and not-found routes", async () => {
  const releasedQaLab = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const qaLab = yield* makeQaLab(projectRoot);
        yield* Effect.promise(async () => {
          const context = await browser?.newContext();
          if (context === undefined) {
            throw new Error("QA Lab browser harness did not start");
          }
          const requestedOrigins = new Set<string>();
          const browserErrors: string[] = [];
          context.on("request", (request) => {
            requestedOrigins.add(new URL(request.url()).origin);
          });
          const page = await context.newPage();
          page.on("console", (message) => {
            if (message.type() === "error") {
              browserErrors.push(message.text());
            }
          });
          page.on("pageerror", (cause) => {
            browserErrors.push(cause.message);
          });

          await page.goto(qaLab.baseUrl.href);
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Account",
              exact: true,
            }),
          ).toBeVisible();
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Personal details",
            }),
          ).toBeVisible();
          await playwrightExpect(
            page.getByRole("heading", { name: "Team plan" }),
          ).toBeVisible();
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Security posture",
            }),
          ).toBeVisible();
          await page.reload();
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Account",
              exact: true,
            }),
          ).toBeVisible();

          await page.goto(
            new URL("/missing", qaLab.baseUrl).href,
          );
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Page not found",
            }),
          ).toBeVisible();
          await page.reload();
          await playwrightExpect(
            page.getByRole("heading", {
              name: "Page not found",
            }),
          ).toBeVisible();

          expect([...requestedOrigins]).toEqual([
            qaLab.baseUrl.origin,
          ]);
          expect(browserErrors).toEqual([]);
          expect(qaLab.isRunning()).toBe(true);
          await context.close();
        });
        return qaLab;
      }),
    ),
  );
  expect(releasedQaLab.isRunning()).toBe(false);
});
