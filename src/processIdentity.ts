import { execFile } from "node:child_process";
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

const readProcessStartedAt = (
  processId: number,
): Effect.Effect<string | null, ProcessIdentityError> =>
  Effect.async<string | null, ProcessIdentityError>((resume) => {
    const child = execFile(
      "ps",
      ["-o", "lstart=", "-p", String(processId)],
      (cause, stdout) => {
        if (cause !== null) {
          if (
            "code" in cause &&
            (cause.code === 1 || cause.code === "1")
          ) {
            resume(Effect.succeed(null));
            return;
          }
          resume(
            Effect.fail(
              new ProcessIdentityError({ processId, cause }),
            ),
          );
          return;
        }

        const observedStartedAt = Date.parse(stdout.trim());
        if (Number.isNaN(observedStartedAt)) {
          resume(
            Effect.fail(
              new ProcessIdentityError({
                processId,
                cause: new Error(
                  `Could not read process start time: ${stdout.trim()}`,
                ),
              }),
            ),
          );
          return;
        }
        resume(
          Effect.succeed(
            new Date(observedStartedAt).toISOString(),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
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
