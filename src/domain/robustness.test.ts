/**
 * Defensive-API check: no exported schema may THROW on hostile or malformed
 * input. It must return a validation failure instead, or a server action
 * would 500 instead of answering 400. Each object schema is also fed objects
 * whose every field is garbage, which exercises the cross-field refinements.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as domain from "./index";

const GARBAGE: unknown[] = [
  undefined,
  null,
  true,
  0,
  -1,
  1e308,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  " ",
  "garbage",
  "2026-13-45T99:00:00Z",
  "24:99",
  "../../etc/passwd",
  "💥".repeat(500),
  [],
  [null],
  {},
  { __proto__: { x: 1 } },
  new Date(Number.NaN),
  () => 1,
  Symbol("s"),
  10n,
];

const schemas = Object.entries(domain as Record<string, unknown>).filter(
  (entry): entry is [string, z.ZodType] =>
    typeof entry[1] === "object" &&
    entry[1] !== null &&
    typeof (entry[1] as { safeParse?: unknown }).safeParse === "function",
);

function shapeOf(schema: z.ZodType): Record<string, unknown> | undefined {
  return (schema as unknown as { shape?: Record<string, unknown> }).shape;
}

describe("schemas never throw", () => {
  it("found the exported schemas", () => {
    expect(schemas.length).toBeGreaterThan(30);
  });

  it.each(schemas)("%s", (_name, schema) => {
    for (const value of GARBAGE) {
      expect(() => schema.safeParse(value)).not.toThrow();
    }
    const shape = shapeOf(schema);
    if (shape) {
      for (const value of GARBAGE) {
        const hostile = Object.fromEntries(Object.keys(shape).map((k) => [k, value]));
        expect(() => schema.safeParse(hostile)).not.toThrow();
      }
    }
  });
});
