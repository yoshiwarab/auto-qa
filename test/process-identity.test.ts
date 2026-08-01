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
      const [bootId, startTicks] = recorded.processStartedAt.split(":");
      if (bootId === undefined || startTicks === undefined) {
        return yield* Effect.fail(
          new Error("Linux Process Identity was malformed"),
        );
      }
      return {
        matching: yield* processIdentity.isCurrent(recorded),
        reused: yield* processIdentity.isCurrent({
          ...recorded,
          processStartedAt: `${bootId}:${BigInt(startTicks) + 1n}`,
        }),
      };
    }),
  );

  expect(result).toEqual({
    matching: true,
    reused: false,
  });
});
