import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  ProcessIdentityError,
  type ProcessIdentity,
  type ProcessIdentityRecord,
  type ProcessIncarnation,
} from "./processIdentity.js";

const linuxProcessStartTicks = (stat: string): string => {
  const commandEnd = stat.lastIndexOf(")");
  const fieldsAfterCommand = stat.slice(commandEnd + 2).split(" ");
  const startTicks = fieldsAfterCommand[19];
  if (commandEnd < 0 || startTicks === undefined) {
    throw new Error("Malformed Linux process stat record");
  }
  return startTicks;
};

const readProcessIncarnation = (
  processId: number,
): Effect.Effect<ProcessIncarnation | null, ProcessIdentityError> =>
  Effect.tryPromise({
    try: async () => {
      if (process.platform !== "linux") {
        throw new Error(
          `Process identity is unsupported on ${process.platform}`,
        );
      }
      try {
        const [bootId, stat] = await Promise.all([
          readFile("/proc/sys/kernel/random/boot_id", "utf8"),
          readFile(`/proc/${processId}/stat`, "utf8"),
        ]);
        return {
          bootId: bootId.trim(),
          startTicks: linuxProcessStartTicks(stat.trim()),
        };
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return null;
        }
        throw cause;
      }
    },
    catch: (cause) =>
      new ProcessIdentityError({ processId, cause }),
  });

export const readCurrentProcessIdentity = (): Effect.Effect<
  ProcessIdentityRecord,
  ProcessIdentityError
> =>
  Effect.flatMap(readProcessIncarnation(process.pid), (incarnation) =>
    incarnation === null
      ? Effect.fail(
          new ProcessIdentityError({
            processId: process.pid,
            cause: new Error("Current process identity disappeared"),
          }),
        )
      : Effect.succeed({
          processId: process.pid,
          processIncarnation: incarnation,
        }),
  );

export const makeNodeProcessIdentity = (): ProcessIdentity => ({
  isRunning: (recorded) =>
    Effect.map(
      readProcessIncarnation(recorded.processId),
      (observed) =>
        observed !== null &&
        (!("processIncarnation" in recorded) ||
          (observed.bootId === recorded.processIncarnation.bootId &&
            observed.startTicks ===
              recorded.processIncarnation.startTicks)),
    ),
});
