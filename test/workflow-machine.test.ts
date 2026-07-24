import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Either } from "effect";
import {
  RunId,
  TRANSITIONS,
  step,
  type MachineEvent,
  type MachineEventType,
  type MachinePhase,
} from "../src/index.js";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";

const phases = Object.keys(TRANSITIONS) as MachinePhase[];
const eventTypes: readonly MachineEventType[] = [
  "start",
  "changesInspected",
];

let targetApplication: Server;
let baseUrl: URL;

beforeAll(async () => {
  targetApplication = createServer((_request, response) => {
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    targetApplication.listen(0, "127.0.0.1", resolve);
  });
  const address = targetApplication.address() as AddressInfo;
  baseUrl = new URL(`http://127.0.0.1:${address.port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    targetApplication.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

const eventFor = (eventType: MachineEventType): MachineEvent =>
  eventType === "start"
    ? { type: "start", baseUrl }
    : { type: "changesInspected" };

describe("Workflow machine Phase × Event coverage", () => {
  for (const phase of phases) {
    for (const eventType of eventTypes) {
      test(`${phase} + ${eventType}`, () => {
        const declared = (
          TRANSITIONS[phase] as Partial<
            Record<MachineEventType, MachinePhase>
          >
        )[eventType];
        const result = step(
          {
            runId: RunId("machine-run"),
            phase,
            baseUrl,
          },
          eventFor(eventType),
        );

        if (declared === undefined) {
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left).toMatchObject({
              phase,
              event: eventType,
              allowedEvents: Object.keys(TRANSITIONS[phase]),
            });
          }
        } else {
          expect(Either.isRight(result)).toBe(true);
          if (Either.isRight(result)) {
            expect(result.right.phase).toBe(declared);
          }
        }
      });
    }
  }
});
