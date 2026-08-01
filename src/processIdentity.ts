import { readFile } from "node:fs/promises";
import { Data, Effect } from "effect";

export type ProcessIncarnation = {
  readonly bootId: string;
  readonly startTicks: string;
};

export type ProcessIdentityRecord = {
  readonly processId: number;
  readonly processIncarnation: ProcessIncarnation;
};

export class ProcessIdentityError extends Data.TaggedError(
  "ProcessIdentityError",
)<{
  readonly processId: number;
  readonly cause: unknown;
}> {}

export interface ProcessIdentity {
  readonly isRunning: (
    processId: number,
  ) => Effect.Effect<boolean, ProcessIdentityError>;
  readonly isCurrent: (
    recorded: ProcessIdentityRecord,
  ) => Effect.Effect<boolean, ProcessIdentityError>;
}

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
  isRunning: (processId) =>
    Effect.map(
      readProcessIncarnation(processId),
      (observed) => observed !== null,
    ),
  isCurrent: (recorded) =>
    Effect.map(
      readProcessIncarnation(recorded.processId),
      (observed) =>
        observed?.bootId === recorded.processIncarnation.bootId &&
        observed.startTicks ===
          recorded.processIncarnation.startTicks,
    ),
});
