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

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message;
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
  const activeRunId =
    code === "ActiveRunExistsError" &&
    typeof cause === "object" &&
    cause !== null &&
    "activeRunId" in cause &&
    typeof cause.activeRunId === "string"
      ? cause.activeRunId
      : undefined;
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
