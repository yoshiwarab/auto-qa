import { CommanderError } from "commander";
import { describe, expect, test } from "vitest";
import {
  cliFailure,
  cliSuccess,
} from "../src/cliProtocol.js";

describe("CLI wire protocol", () => {
  test("encodes versioned success envelopes", () => {
    expect(
      cliSuccess(
        { phase: "awaitingAgent" },
        "correlation-success",
      ),
    ).toEqual({
      schemaVersion: 1,
      correlationId: "correlation-success",
      ok: true,
      result: { phase: "awaitingAgent" },
    });
  });

  test("encodes the incumbent Run for one-active-Run failures", () => {
    expect(
      cliFailure(
        {
          _tag: "ActiveRunExistsError",
          activeRunId: "run-active",
        },
        "correlation-active",
      ),
    ).toEqual({
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        correlationId: "correlation-active",
        ok: false,
        error: {
          code: "ActiveRunExistsError",
          message:
            "Run run-active is already active in this worktree",
          details: { activeRunId: "run-active" },
        },
      },
    });
  });

  test("encodes Commander failures as usage errors", () => {
    expect(
      cliFailure(
        new CommanderError(
          1,
          "commander.missingArgument",
          "A required argument is missing",
        ),
        "correlation-usage",
      ),
    ).toEqual({
      exitCode: 2,
      envelope: {
        schemaVersion: 1,
        correlationId: "correlation-usage",
        ok: false,
        error: {
          code: "commander.missingArgument",
          message: "A required argument is missing",
        },
      },
    });
  });

  test("uses operation context when tagged errors have no message", () => {
    expect(
      cliFailure(
        {
          _tag: "WorkflowStoreError",
          operation: "open Run Store",
          cause: new Error("database missing"),
        },
        "correlation-store",
      ),
    ).toEqual({
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        correlationId: "correlation-store",
        ok: false,
        error: {
          code: "WorkflowStoreError",
          message: "Auto-QA failed during open Run Store",
        },
      },
    });
  });

  test("encodes unknown failures without exposing their value", () => {
    expect(
      cliFailure("secret unknown failure", "correlation-unknown"),
    ).toEqual({
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        correlationId: "correlation-unknown",
        ok: false,
        error: {
          code: "CLI_ERROR",
          message: "Auto-QA command failed",
        },
      },
    });
  });

  test("defensively normalizes malformed failure values", () => {
    const whitespaceError = Object.assign(new Error("   "), {
      operation: "recover state",
    });
    const cases: readonly {
      readonly cause: unknown;
      readonly code: string;
      readonly message: string;
    }[] = [
      {
        cause: null,
        code: "CLI_ERROR",
        message: "Auto-QA command failed",
      },
      {
        cause: {},
        code: "CLI_ERROR",
        message: "Auto-QA command failed",
      },
      {
        cause: { _tag: 42, code: "CUSTOM_ERROR" },
        code: "CUSTOM_ERROR",
        message: "Auto-QA command failed",
      },
      {
        cause: { code: 42 },
        code: "CLI_ERROR",
        message: "Auto-QA command failed",
      },
      {
        cause: {
          _tag: "DifferentError",
          activeRunId: "not-an-active-Run-error",
        },
        code: "DifferentError",
        message: "Auto-QA command failed",
      },
      {
        cause: {
          _tag: "ActiveRunExistsError",
          activeRunId: 42,
        },
        code: "ActiveRunExistsError",
        message: "Auto-QA command failed",
      },
      {
        cause: { _tag: "ActiveRunExistsError" },
        code: "ActiveRunExistsError",
        message: "Auto-QA command failed",
      },
      {
        cause: { operation: 42 },
        code: "CLI_ERROR",
        message: "Auto-QA command failed",
      },
      {
        cause: { operation: "inspect changes" },
        code: "CLI_ERROR",
        message: "Auto-QA failed during inspect changes",
      },
      {
        cause: whitespaceError,
        code: "CLI_ERROR",
        message: "Auto-QA failed during recover state",
      },
    ];

    for (const example of cases) {
      expect(
        cliFailure(example.cause, "correlation-defensive"),
      ).toEqual({
        exitCode: 1,
        envelope: {
          schemaVersion: 1,
          correlationId: "correlation-defensive",
          ok: false,
          error: {
            code: example.code,
            message: example.message,
          },
        },
      });
    }
  });
});
