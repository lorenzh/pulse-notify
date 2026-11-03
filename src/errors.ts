import { AtomicWriteError } from "@lorenzh/pulse-kit";
import type { RecipientProgress } from "./types.ts";

/**
 * A delivery failure that a retry cannot fix (a 4xx answer, an SMTP 5xx reply).
 * `status` is the HTTP status or SMTP reply code; `code` is a system error code.
 */
export class PermanentDeliveryError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    fields: { status?: number; code?: string | undefined; cause?: unknown } = {},
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "PermanentDeliveryError";
    this.status = fields.status;
    this.code = fields.code;
  }
}

/**
 * An email attempt that did not reach every recipient. `progress` is cumulative, including this
 * attempt; `isPermanent` is true when no recipient is left to try. The message holds counts and
 * reply codes only, never an address or server text.
 */
export class PartialDeliveryError extends Error {
  readonly progress: RecipientProgress;
  readonly isPermanent: boolean;
  /** Recipients still to try after this attempt. */
  readonly remaining: number;
  /** Distinct numeric reply codes of this attempt's refusals, sorted. */
  readonly codes: number[];

  constructor(fields: {
    progress: RecipientProgress;
    remaining: number;
    refusedNow: number;
    attempted: number;
    codes: number[];
  }) {
    const codes = [...new Set(fields.codes)].sort((a, b) => a - b);
    const suffix = codes.length > 0 ? `: ${codes.join(", ")}` : "";
    super(`SMTP refused ${fields.refusedNow} of ${fields.attempted} recipients${suffix}`);
    this.name = "PartialDeliveryError";
    this.progress = fields.progress;
    this.remaining = fields.remaining;
    this.isPermanent = fields.remaining === 0;
    this.codes = codes;
  }
}

export type ErrorFields = { error: string; code?: string; cause?: string };

/** Log fields for an error: its message, the innermost `code` and the innermost cause message.
 * The walk stops at an `AtomicWriteError`, whose cause text is never logged. */
export function errorFields(err: unknown): ErrorFields {
  const fields: ErrorFields = { error: messageOf(err) };
  let current: unknown = err;
  let innermost: unknown;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") fields.code = code;
    // The kit already reduced the cause to a stage and an errno; its raw text can hold paths.
    if (current instanceof AtomicWriteError || current.cause === undefined) break;
    innermost = current.cause;
    current = current.cause;
  }
  if (innermost !== undefined) fields.cause = messageOf(innermost);
  return fields;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
