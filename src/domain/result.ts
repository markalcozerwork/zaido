/**
 * The result shape every server action returns, so UI code handles success,
 * field errors and domain errors uniformly.
 */
import type { z } from "zod";
import type { DomainError } from "./errors";

export type FieldErrors = Record<string, string[]>;

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: DomainError; fieldErrors?: FieldErrors };

/** Zod issues → { "coach.hourly_rate": ["…"], "player_sports.0.rating": ["…"] }. "" = form-level. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Validate untrusted input at a server boundary. */
export function validate<S extends z.ZodType>(schema: S, input: unknown): ActionResult<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    error: {
      code: "VALIDATION_FAILED",
      message: "Please check the highlighted fields.",
      retryable: false,
    },
    fieldErrors: toFieldErrors(parsed.error),
  };
}
