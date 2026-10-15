import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { syncDirectory } from "./durableFile.js";
import { ScenarioRuntimeError } from "./scenarioRuntime.js";

export const AttemptWorkspaceIdentity = Schema.Struct({
  device: Schema.String.pipe(Schema.pattern(/^\d+$/)),
  inode: Schema.String.pipe(Schema.pattern(/^\d+$/)),
});
type AttemptWorkspaceIdentity = typeof AttemptWorkspaceIdentity.Type;

const workspaceError = (cause: unknown) =>
  new ScenarioRuntimeError({
    operation: "manage Attempt workspace",
    cause,
  });

const status = (path: string) =>
  lstat(path, { bigint: true }).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  });

const directory = async (path: string) => {
  const observed = await status(path);
  if (
    observed !== null &&
    (!observed.isDirectory() ||
      observed.uid !== BigInt(process.getuid?.() ?? -1))
  )
    throw new Error("Attempt workspace path is not an owned directory");
  return observed;
};

/** Private, per-launch storage. Never sweep arbitrary paths or follow symlinks. */
export const makeNodeAttemptWorkspace = (
  stateDirectory: string,
  launchToken: string
) => {
  // Tokens come from a UUID generator or a decoded registry. Validate again at
  // this deletion boundary so no caller can turn a token into a path traversal.
  const token = Schema.decodeUnknownSync(Schema.UUID)(launchToken);
  const parent = join(stateDirectory, "runtime");
  const root = join(parent, token);
  const profileDirectory = join(root, "profile");
  const artifactsDirectory = join(root, "artifacts");

  const inspect = async () => {
    if ((await directory(stateDirectory)) === null)
      throw new Error("State directory missing");
    if ((await directory(parent)) === null) return null;
    return directory(root);
  };
  const owned = async (identity: AttemptWorkspaceIdentity | null) => {
    const observed = await inspect();
    if (
      observed !== null &&
      (identity === null ||
        observed.dev.toString() !== identity.device ||
        observed.ino.toString() !== identity.inode)
    )
      throw new Error("Attempt workspace identity mismatch; registry retained");
    return observed;
  };

  return {
    directory: root,
    profileDirectory,
    artifactsDirectory,
    allocate: () =>
      Effect.tryPromise({
        try: async () => {
          if ((await directory(stateDirectory)) === null)
            throw new Error("State directory missing");
          await mkdir(parent, { mode: 0o700 }).catch((cause: unknown) => {
            if (!(
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "EEXIST"
            ))
              throw cause;
          });
          await directory(parent);
          await mkdir(root, { mode: 0o700 });
          await syncDirectory(parent);
          const observed = await directory(root);
          if (observed === null)
            throw new Error("Attempt workspace disappeared");
          return {
            device: observed.dev.toString(),
            inode: observed.ino.toString(),
          };
        },
        catch: workspaceError,
      }),
    prepare: (identity: AttemptWorkspaceIdentity) =>
      Effect.tryPromise({
        try: async () => {
          if ((await owned(identity)) === null)
            throw new Error("Attempt workspace missing");
          await mkdir(profileDirectory, { mode: 0o700 });
          await mkdir(artifactsDirectory, { mode: 0o700 });
          await syncDirectory(root);
        },
        catch: workspaceError,
      }),
    remove: (identity: AttemptWorkspaceIdentity | null) =>
      Effect.tryPromise({
        try: async () => {
          if ((await owned(identity)) === null) return;
          // All owned processes must be stopped by the caller before removal.
          // rm unlinks nested symlinks rather than recursively visiting targets.
          await rm(root, { recursive: true, maxRetries: 3, retryDelay: 50 });
          await syncDirectory(parent);
        },
        catch: workspaceError,
      }),
  };
};
