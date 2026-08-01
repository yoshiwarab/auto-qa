import { readFile } from "node:fs/promises";
import { Data, Effect } from "effect";

export type ProcessIdentityRecord = {
  readonly processId: number;
  readonly processStartedAt: string;
};

export class ProcessIdentityError extends Data.TaggedError(
  "ProcessIdentityError",
)<{
  readonly processId: number;
  readonly cause: unknown;
}> {}

export interface ProcessIdentity {
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

const readProcessStartedAt = (
  processId: number,
): Effect.Effect<string | null, ProcessIdentityError> =>
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
        return `${bootId.trim()}:${linuxProcessStartTicks(stat.trim())}`;
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
  Effect.flatMap(readProcessStartedAt(process.pid), (processStartedAt) =>
    processStartedAt === null
      ? Effect.fail(
          new ProcessIdentityError({
            processId: process.pid,
            cause: new Error("Current process identity disappeared"),
          }),
        )
      : Effect.succeed({
          processId: process.pid,
          processStartedAt,
        }),
  );

export const makeNodeProcessIdentity = (): ProcessIdentity => ({
  isCurrent: (recorded) =>
    Effect.map(
      readProcessStartedAt(recorded.processId),
      (observedStartedAt) =>
        observedStartedAt === recorded.processStartedAt,
    ),
});
