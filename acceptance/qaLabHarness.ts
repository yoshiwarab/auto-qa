import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

export type QaLabProcess = {
  readonly baseUrl: URL;
  readonly isRunning: () => boolean;
  readonly stop: () => Promise<void>;
};

const hasStopped = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (hasStopped(child)) return;
  await new Promise<void>((resolve, reject) => {
    const removeListeners = (): void => {
      child.off("exit", finish);
      child.off("error", fail);
    };
    const finish = (): void => {
      removeListeners();
      resolve();
    };
    const fail = (cause: Error): void => {
      removeListeners();
      reject(cause);
    };
    child.once("exit", finish);
    child.once("error", fail);
    if (!child.kill("SIGTERM") && hasStopped(child)) {
      finish();
    }
  });
};

const reserveEphemeralPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("QA Lab harness did not receive a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });
  return address.port;
};

const waitUntilReachable = async (
  child: ChildProcess,
  baseUrl: URL,
  output: () => string,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (hasStopped(child)) {
      throw new Error(
        `QA Lab exited before readiness with code ${child.exitCode}\n${output()}`,
      );
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The independently owned Target Application is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`QA Lab did not become ready\n${output()}`);
};

export const startQaLab = async (
  projectRoot: string,
): Promise<QaLabProcess> => {
  const port = await reserveEphemeralPort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  const processOutput: string[] = [];
  const child = spawn(
    process.execPath,
    [
      join(
        projectRoot,
        "apps",
        "qa-lab",
        "node_modules",
        "vite",
        "bin",
        "vite.js",
      ),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: join(projectRoot, "apps", "qa-lab"),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const captureOutput = (chunk: Buffer): void => {
    processOutput.push(chunk.toString("utf8"));
  };
  child.stdout?.on("data", captureOutput);
  child.stderr?.on("data", captureOutput);
  try {
    await waitUntilReachable(
      child,
      baseUrl,
      () => processOutput.join(""),
    );
  } catch (cause) {
    await stopChild(child);
    throw cause;
  }

  return {
    baseUrl,
    isRunning: () => !hasStopped(child),
    stop: () => stopChild(child),
  };
};
