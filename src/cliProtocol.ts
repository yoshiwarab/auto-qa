type SuccessEnvelope<Result> = {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly ok: true;
  readonly result: Result;
};

type FailureEnvelope = {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: {
      readonly activeRunId: string;
    };
  };
};

export const cliSuccess = <Result>(
  result: Result,
  correlationId: string,
): SuccessEnvelope<Result> => ({
  schemaVersion: 1,
  correlationId,
  ok: true,
  result,
});

const activeRunIdFrom = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "ActiveRunExistsError" &&
  "activeRunId" in cause &&
  typeof cause.activeRunId === "string"
    ? cause.activeRunId
    : undefined;

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message;
  }
  const activeRunId = activeRunIdFrom(cause);
  if (activeRunId !== undefined) {
    return `Run ${activeRunId} is already active in this worktree`;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "operation" in cause &&
    typeof cause.operation === "string"
  ) {
    return `Auto-QA failed during ${cause.operation}`;
  }
  return "Auto-QA command failed";
};

const failureCode = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) {
    return "CLI_ERROR";
  }
  if ("_tag" in cause && typeof cause._tag === "string") {
    return cause._tag;
  }
  if ("code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return "CLI_ERROR";
};

export const cliFailure = (
  cause: unknown,
  correlationId: string,
): {
  readonly envelope: FailureEnvelope;
  readonly exitCode: number;
} => {
  const code = failureCode(cause);
  const activeRunId = activeRunIdFrom(cause);
  return {
    envelope: {
      schemaVersion: 1,
      correlationId,
      ok: false,
      error: {
        code,
        message: failureMessage(cause),
        ...(activeRunId === undefined
          ? {}
          : { details: { activeRunId } }),
      },
    },
    exitCode: code.startsWith("commander.") ? 2 : 1,
  };
};
