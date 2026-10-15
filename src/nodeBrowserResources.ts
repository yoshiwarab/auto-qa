import { spawn } from "node:child_process";
import {
  closeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { syncDirectory, writeFileDurably } from "./durableFile.js";
import {
  makeNodeProcessIdentity,
  readCurrentProcessIdentity,
} from "./nodeProcessIdentity.js";
import { ScenarioRuntimeError } from "./scenarioRuntime.js";
import {
  AttemptWorkspaceIdentity,
  makeNodeAttemptWorkspace,
} from "./nodeAttemptWorkspace.js";

const PositiveInteger = Schema.Number.pipe(Schema.int(), Schema.greaterThan(1));
const Incarnation = Schema.Struct({
  bootId: Schema.NonEmptyString,
  startTicks: Schema.String.pipe(Schema.pattern(/^\d+$/)),
});
const BrowserProcess = Schema.Struct({
  processId: PositiveInteger,
  startTicks: Schema.String.pipe(Schema.pattern(/^\d+$/)),
  executablePath: Schema.NonEmptyString,
  groupId: PositiveInteger,
  sessionId: PositiveInteger,
});
type BrowserProcess = typeof BrowserProcess.Type;
const Registry = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  runId: Schema.NonEmptyString,
  launchToken: Schema.UUID,
  executablePath: Schema.NonEmptyString,
  launcherExecutablePath: Schema.NonEmptyString,
  workspaceIdentity: Schema.NullOr(AttemptWorkspaceIdentity),
  owner: Schema.Struct({
    processId: PositiveInteger,
    processIncarnation: Incarnation,
  }),
  processes: Schema.Array(BrowserProcess),
});
type Registry = typeof Registry.Type;
const LaunchRecord = Schema.Struct({
  launchToken: Schema.UUID,
  process: BrowserProcess,
});

const missing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ESRCH");

const resourceError = (cause: unknown) =>
  new ScenarioRuntimeError({
    operation: "reconcile browser resources",
    cause,
  });

// Read immediately before signaling, without yielding between identity checks
// and kill. A PID or process-group number alone is never sufficient authority.
const observe = (
  processId: number,
  accepts: (groupId: number, args: readonly string[]) => boolean = () => true
): (BrowserProcess & { readonly args: readonly string[] }) | null => {
  try {
    const path = `/proc/${processId}`;
    if (statSync(path).uid !== process.getuid?.()) return null;
    const stat = readFileSync(`${path}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/);
    if (end < 0 || fields[19] === undefined)
      throw new Error("Malformed process identity");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    // Chromium may rewrite argv as one space-delimited process title.
    const args = readFileSync(`${path}/cmdline`, "utf8").split(/[\0\s]+/);
    if (!accepts(Number(fields[2]), args)) return null;
    return {
      processId,
      startTicks: fields[19],
      groupId: Number(fields[2]),
      sessionId: Number(fields[3]),
      executablePath: readlinkSync(`${path}/exe`),
      args,
    };
  } catch (cause) {
    if (missing(cause)) return null;
    throw cause;
  }
};

const sameProcess = (
  recorded: BrowserProcess,
  observed: BrowserProcess
): boolean =>
  recorded.processId === observed.processId &&
  recorded.startTicks === observed.startTicks &&
  recorded.executablePath === observed.executablePath &&
  recorded.groupId === observed.groupId &&
  recorded.sessionId === observed.sessionId;

const assertRootOwnership = (
  registry: Registry,
  root: NonNullable<ReturnType<typeof observe>>
): void => {
  const recordedRoot = registry.processes.find(
    (entry) => entry.processId === root.processId
  );
  if (
    root.groupId <= 1 ||
    root.processId !== root.groupId ||
    root.processId !== root.sessionId ||
    (root.executablePath !== registry.executablePath &&
      root.executablePath !== registry.launcherExecutablePath) ||
    !root.args.includes(`--auto-qa-launch-token=${registry.launchToken}`) ||
    (recordedRoot !== undefined && !sameProcess(recordedRoot, root))
  ) {
    throw new Error(
      "Browser ownership mismatch; registry retained without signaling"
    );
  }
};

const snapshot = (
  groups: ReadonlySet<number>,
  registry: Registry
): readonly ReturnType<typeof observe>[] =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((name) =>
      observe(
        Number(name),
        (groupId, args) =>
          groups.has(groupId) ||
          args.includes(`--auto-qa-launch-token=${registry.launchToken}`)
      )
    );

const discover = (registry: Registry): readonly BrowserProcess[] => {
  const observed = snapshot(
    new Set(registry.processes.map((entry) => entry.groupId)),
    registry
  );
  const groups = new Set(
    observed.flatMap((entry) =>
      entry !== null &&
      (entry.executablePath === registry.executablePath ||
        (entry.executablePath === registry.launcherExecutablePath &&
          entry.processId === entry.groupId)) &&
      entry.args.includes(`--auto-qa-launch-token=${registry.launchToken}`) &&
      entry.groupId > 1 &&
      entry.sessionId === entry.groupId
        ? [entry.groupId]
        : []
    )
  );
  // A surviving, previously recorded member also proves the group has not
  // been recycled when its original leader died during an earlier cleanup.
  for (const recorded of registry.processes) {
    if (
      observed.some((entry) => entry !== null && sameProcess(recorded, entry))
    ) {
      groups.add(recorded.groupId);
    }
  }
  if (
    observed.some(
      (entry) =>
        entry !== null &&
        registry.processes.some(
          (recorded) => recorded.groupId === entry.groupId
        ) &&
        !groups.has(entry.groupId)
    )
  ) {
    throw new Error(
      "Live members have no surviving ownership witness; registry retained"
    );
  }
  for (const groupId of groups) {
    const root = observe(groupId);
    if (root !== null) assertRootOwnership(registry, root);
  }
  const members = snapshot(groups, registry);
  for (const groupId of groups) {
    const currentMembers = members.filter(
      (entry) => entry?.groupId === groupId
    );
    if (
      currentMembers.length > 0 &&
      !currentMembers.some(
        (current) =>
          current !== null &&
          observed.some(
            (prior) => prior !== null && sameProcess(prior, current)
          )
      )
    ) {
      throw new Error(
        "Browser group changed during discovery; registry retained"
      );
    }
  }
  return members.flatMap((entry) =>
    entry !== null &&
    groups.has(entry.groupId) &&
    entry.sessionId === entry.groupId
      ? [
          {
            processId: entry.processId,
            startTicks: entry.startTicks,
            executablePath: entry.executablePath,
            groupId: entry.groupId,
            sessionId: entry.sessionId,
          },
        ]
      : []
  );
};

const signalGroups = (registry: Registry, signal: NodeJS.Signals): void => {
  const signaled = new Set<number>();
  for (const recorded of registry.processes) {
    if (signaled.has(recorded.groupId)) continue;
    const currentBoot = readFileSync(
      "/proc/sys/kernel/random/boot_id",
      "utf8"
    ).trim();
    if (currentBoot !== registry.owner.processIncarnation.bootId) return;
    const current = observe(recorded.processId);
    if (current === null || !sameProcess(recorded, current)) continue;
    const root = observe(recorded.groupId);
    if (root !== null) assertRootOwnership(registry, root);
    // The member may have exited while the root was checked.
    const rechecked = observe(recorded.processId);
    if (rechecked === null || !sameProcess(recorded, rechecked)) continue;
    if (recorded.groupId <= 1) throw new Error("Unsafe browser process group");
    try {
      process.kill(-recorded.groupId, signal);
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
    signaled.add(recorded.groupId);
  }
};

export const makeNodeBrowserResources = (stateDirectory: string) => {
  const registryPath = join(stateDirectory, "registry.json");
  const launcherPath = (token: string) =>
    join(stateDirectory, `.browser-launch-${token}.sh`);
  const launchRecordPath = (token: string) =>
    join(stateDirectory, `.browser-launch-${token}.json`);
  const read = Effect.fn(function* () {
    const text = yield* Effect.tryPromise({
      try: () =>
        readFile(registryPath, "utf8").catch((cause: unknown) => {
          if (missing(cause)) return null;
          throw cause;
        }),
      catch: resourceError,
    });
    if (text === null) return null;
    const registry = yield* Schema.decodeUnknown(Schema.parseJson(Registry))(
      text
    ).pipe(Effect.mapError(resourceError));
    const launchText = yield* Effect.tryPromise({
      try: () =>
        readFile(launchRecordPath(registry.launchToken), "utf8").catch(
          (cause: unknown) => {
            if (missing(cause)) return null;
            throw cause;
          }
        ),
      catch: resourceError,
    });
    if (launchText === null) return registry;
    const launch = yield* Schema.decodeUnknown(Schema.parseJson(LaunchRecord))(
      launchText
    ).pipe(Effect.mapError(resourceError));
    if (
      launch.launchToken !== registry.launchToken ||
      launch.process.executablePath !== registry.launcherExecutablePath ||
      launch.process.processId !== launch.process.groupId ||
      launch.process.processId !== launch.process.sessionId
    )
      return yield* Effect.fail(
        resourceError(new Error("Invalid browser launch record"))
      );
    return {
      ...registry,
      processes: registry.processes.some(
        (entry) => entry.processId === launch.process.processId
      )
        ? registry.processes
        : [...registry.processes, launch.process],
    };
  });
  const write = (registry: Registry) =>
    Effect.tryPromise({
      try: async () => {
        const temporary = join(
          stateDirectory,
          `.registry-${registry.launchToken}.tmp`
        );
        await writeFileDurably(temporary, `${JSON.stringify(registry)}\n`);
        await rename(temporary, registryPath);
        await syncDirectory(stateDirectory);
      },
      catch: resourceError,
    });
  const clear = Effect.fn(function* (registry: Registry) {
    yield* makeNodeAttemptWorkspace(
      stateDirectory,
      registry.launchToken
    ).remove(registry.workspaceIdentity);
    yield* Effect.tryPromise({
      try: async () => {
        await rm(launcherPath(registry.launchToken), { force: true });
        await rm(launchRecordPath(registry.launchToken), { force: true });
        await rm(registryPath, { force: true });
        await syncDirectory(stateDirectory);
      },
      catch: resourceError,
    });
  });
  const capture = Effect.fn(function* (
    registry: Registry,
    requireLaunchProof = false
  ) {
    const processes = yield* Effect.try({
      try: () => discover(registry),
      catch: resourceError,
    });
    if (
      requireLaunchProof &&
      registry.processes.length === 0 &&
      processes.length === 0
    ) {
      return yield* Effect.fail(
        resourceError(
          new Error(
            "Interrupted launch has no verifiable process identity; registry retained"
          )
        )
      );
    }
    const captured = { ...registry, processes };
    // Checkpoint ownership before any signal so interrupted cleanup can resume.
    yield* write(captured);
    return captured;
  });
  const reconcile = Effect.fn(function* (releaseToken?: string) {
    const registry = yield* read();
    if (registry === null) return;
    const current = yield* readCurrentProcessIdentity().pipe(
      Effect.mapError(resourceError)
    );
    const releasingOwn =
      releaseToken === registry.launchToken &&
      registry.owner.processId === current.processId &&
      registry.owner.processIncarnation.bootId ===
        current.processIncarnation.bootId &&
      registry.owner.processIncarnation.startTicks ===
        current.processIncarnation.startTicks;
    if (
      !releasingOwn &&
      (yield* makeNodeProcessIdentity()
        .isRunning(registry.owner)
        .pipe(Effect.mapError(resourceError)))
    ) {
      return yield* Effect.fail(
        resourceError(new Error("Browser resources still have a live owner"))
      );
    }
    if (
      registry.owner.processIncarnation.bootId !==
      current.processIncarnation.bootId
    ) {
      yield* clear(registry);
      return;
    }
    let captured = yield* capture(registry, !releasingOwn);
    yield* Effect.try({
      try: () => signalGroups(captured, "SIGTERM"),
      catch: resourceError,
    });
    for (let poll = 0; poll < 10; poll += 1) {
      const remaining = yield* Effect.try({
        try: () => discover(captured),
        catch: resourceError,
      });
      if (remaining.length === 0) {
        yield* clear(registry);
        return;
      }
      yield* Effect.sleep("50 millis");
    }
    captured = yield* capture(captured);
    yield* Effect.try({
      try: () => signalGroups(captured, "SIGKILL"),
      catch: resourceError,
    });
    for (let poll = 0; poll < 40; poll += 1) {
      const remaining = yield* Effect.try({
        try: () => discover(captured),
        catch: resourceError,
      });
      if (remaining.length === 0) {
        yield* clear(registry);
        return;
      }
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.fail(
      resourceError(new Error("Browser cleanup timed out; registry retained"))
    );
  });
  return {
    // Registry I/O and bounded cleanup must finish before the Turn is released.
    reconcile: () => reconcile().pipe(Effect.uninterruptible),
    register: Effect.fn(function* (
      runId: string,
      launchToken: string,
      executablePath: string
    ) {
      if ((yield* read()) !== null) {
        return yield* Effect.fail(
          resourceError(
            new Error("Reconcile existing browser resources before launching")
          )
        );
      }
      const owner = yield* readCurrentProcessIdentity().pipe(
        Effect.mapError(resourceError)
      );
      const executable = yield* Effect.tryPromise({
        try: () => realpath(executablePath),
        catch: resourceError,
      });
      const launcherExecutable = yield* Effect.tryPromise({
        try: async () => {
          const executable = await realpath(process.execPath);
          const quote = (value: string) =>
            `'${value.replaceAll("'", "'\\''")}'`;
          const module = fileURLToPath(
            new URL("./nodeBrowserLauncher.js", import.meta.url)
          );
          const file = await open(launcherPath(launchToken), "wx", 0o700);
          try {
            await file.writeFile(
              `#!/bin/sh\nexec ${quote(executable)} ${quote(module)} ${quote(stateDirectory)} "$@"\n`
            );
            await file.sync();
          } finally {
            await file.close();
          }
          return executable;
        },
        catch: resourceError,
      });
      const registry: Registry = {
        schemaVersion: 2,
        runId,
        launchToken,
        executablePath: executable,
        launcherExecutablePath: launcherExecutable,
        workspaceIdentity: null,
        owner,
        processes: [],
      };
      yield* write(registry);
      const workspace = makeNodeAttemptWorkspace(stateDirectory, launchToken);
      const workspaceIdentity = yield* workspace.allocate();
      yield* write({ ...registry, workspaceIdentity });
      yield* workspace.prepare(workspaceIdentity);
      return {
        workspaceDirectory: workspace.directory,
        launcherPath: launcherPath(launchToken),
        profileDirectory: workspace.profileDirectory,
        artifactsDirectory: workspace.artifactsDirectory,
      };
    }),
    runLauncher: Effect.fn(function* (args: readonly string[]) {
      const root = yield* Effect.try({
        try: () => observe(process.pid),
        catch: resourceError,
      });
      if (
        root === null ||
        root.processId <= 1 ||
        root.groupId !== root.processId ||
        root.sessionId !== root.processId
      )
        return yield* Effect.fail(
          resourceError(new Error("Launcher requires its own process group"))
        );
      yield* Effect.gen(function* () {
        const registry = yield* read();
        if (
          registry === null ||
          !args.includes(`--auto-qa-launch-token=${registry.launchToken}`)
        )
          return yield* Effect.fail(
            resourceError(
              new Error("Browser registration missing or mismatched")
            )
          );
        yield* Effect.try({
          try: () => assertRootOwnership(registry, root),
          catch: resourceError,
        });
        // This process is durable before it can create any Chromium children.
        // A separate single-writer record avoids racing the next CLI's registry
        // checkpoint if this launcher outlives its original owner.
        yield* Effect.tryPromise({
          try: async () => {
            const path = launchRecordPath(registry.launchToken);
            await writeFileDurably(
              `${path}.tmp`,
              `${JSON.stringify({
                launchToken: registry.launchToken,
                process: {
                  processId: root.processId,
                  startTicks: root.startTicks,
                  executablePath: root.executablePath,
                  groupId: root.groupId,
                  sessionId: root.sessionId,
                },
              })}\n`
            );
            await rename(`${path}.tmp`, path);
            await syncDirectory(stateDirectory);
          },
          catch: resourceError,
        });
        const owner = yield* Effect.try({
          try: () => observe(registry.owner.processId),
          catch: resourceError,
        });
        const current = yield* readCurrentProcessIdentity().pipe(
          Effect.mapError(resourceError)
        );
        // Check AFTER journaling. If cleanup raced this late-starting launcher,
        // a dead owner prevents it from starting fresh browser work.
        if (
          owner === null ||
          owner.startTicks !== registry.owner.processIncarnation.startTicks ||
          current.processIncarnation.bootId !==
            registry.owner.processIncarnation.bootId ||
          process.ppid !== registry.owner.processId
        )
          return yield* Effect.fail(
            resourceError(new Error("Browser launch owner exited"))
          );
        yield* Effect.async<void, ScenarioRuntimeError>((resume) => {
          const browser = spawn(registry.executablePath, args, {
            // Stay in the launcher's session/group and preserve Playwright's
            // protocol pipes. The target application is never in this group.
            stdio: ["inherit", "inherit", "inherit", 3, 4],
          });
          browser.once("error", (cause) =>
            resume(Effect.fail(resourceError(cause)))
          );
          browser.once("exit", () => resume(Effect.void));
          closeSync(3);
          closeSync(4);
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // The live session leader pins this group identity. On browser exit,
            // terminate any remaining descendants and this launcher together.
            process.kill(-process.pid, "SIGKILL");
          })
        )
      );
    }),
    capture: Effect.fn(function* () {
      const registry = yield* read();
      if (registry === null)
        return yield* Effect.fail(
          resourceError(new Error("Browser registration missing"))
        );
      yield* capture(registry);
    }),
    release: (launchToken: string) =>
      reconcile(launchToken).pipe(Effect.uninterruptible),
  };
};
