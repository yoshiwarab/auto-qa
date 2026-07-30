import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

export type QaLabProcess = {
  readonly baseUrl: URL;
  readonly isRunning: () => boolean;
  readonly stop: () => Promise<void>;
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
    if (child.exitCode !== null) {
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
  const chunks: string[] = [];
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
  child.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString("utf8"));
  });
  try {
    await waitUntilReachable(child, baseUrl, () => chunks.join(""));
  } catch (cause) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw cause;
  }

  return {
    baseUrl,
    isRunning: () => child.exitCode === null,
    stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
        if (!child.kill("SIGTERM") && child.exitCode !== null) {
          resolve();
        }
      });
    },
  };
};
