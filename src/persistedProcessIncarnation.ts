import type { ProcessIncarnation } from "./processIdentity.js";

export type PersistedProcessIncarnation =
  | {
      readonly format: "current";
      readonly incarnation: ProcessIncarnation;
    }
  | { readonly format: "legacy" };

export const encodeProcessIncarnation = (
  incarnation: ProcessIncarnation,
): string => JSON.stringify(incarnation);

export const decodeProcessIncarnation = (
  value: string,
): PersistedProcessIncarnation => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    if (!Number.isNaN(Date.parse(value))) {
      return { format: "legacy" };
    }
    throw new Error("Malformed persisted process incarnation");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("bootId" in decoded) ||
    typeof decoded.bootId !== "string" ||
    !("startTicks" in decoded) ||
    typeof decoded.startTicks !== "string"
  ) {
    throw new Error("Malformed persisted process incarnation");
  }
  return {
    format: "current",
    incarnation: {
      bootId: decoded.bootId,
      startTicks: decoded.startTicks,
    },
  };
};
