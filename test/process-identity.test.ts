import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  makeNodeProcessIdentity,
  readCurrentProcessIdentity,
} from "../src/processIdentity.js";

test("Process Identity distinguishes the live process from PID reuse", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const recorded = yield* readCurrentProcessIdentity();
      const processIdentity = makeNodeProcessIdentity();
      return {
        matching: yield* processIdentity.isCurrent(recorded),
        reused: yield* processIdentity.isCurrent({
          ...recorded,
          processStartedAt: "2000-01-01T00:00:00.000Z",
        }),
      };
    }),
  );

  expect(result).toEqual({
    matching: true,
    reused: false,
  });
});
