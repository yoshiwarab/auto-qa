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
    recorded:
      | ProcessIdentityRecord
      | { readonly processId: number },
  ) => Effect.Effect<boolean, ProcessIdentityError>;
}
