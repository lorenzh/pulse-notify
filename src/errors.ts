export type ErrorFields = { error: string; code?: string; cause?: string };

/** Log fields for an error: its message, the innermost `code` and the innermost cause message. */
export function errorFields(err: unknown): ErrorFields {
  const fields: ErrorFields = { error: messageOf(err) };
  let current: unknown = err;
  let innermost: unknown;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") fields.code = code;
    if (current.cause === undefined) break;
    innermost = current.cause;
    current = current.cause;
  }
  if (innermost !== undefined) fields.cause = messageOf(innermost);
  return fields;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
