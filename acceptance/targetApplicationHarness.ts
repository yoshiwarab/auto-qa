import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect } from "effect";

const listen = (server: Server): Effect.Effect<URL, Error> =>
  Effect.async<URL, Error>((resume) => {
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      resume(Effect.fail(cause));
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resume(
        Effect.succeed(
          new URL(`http://127.0.0.1:${address.port}`),
        ),
      );
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

const close = (server: Server): Effect.Effect<void, Error> =>
  Effect.async<void, Error>((resume) => {
    server.close((cause) => {
      resume(cause === undefined ? Effect.void : Effect.fail(cause));
    });
  });

export const makeTargetApplicationHarness = (
  directoryPrefix: string,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const temporaryParent = join(process.cwd(), "tmp");
      yield* Effect.promise(() =>
        mkdir(temporaryParent, { recursive: true }),
      );
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(temporaryParent, directoryPrefix)),
      );
      const targetApplication = createServer(
        (_request, response) => {
          response.end("ok");
        },
      );
      const baseUrl = yield* listen(targetApplication);

      return { baseUrl, directory, targetApplication };
    }),
    ({ directory, targetApplication }) =>
      Effect.zipRight(
        close(targetApplication),
        Effect.promise(() => rm(directory, { recursive: true })),
      ).pipe(Effect.orDie),
  ).pipe(
    Effect.map(({ baseUrl, directory }) => ({
      baseUrl,
      directory,
    })),
  );
