import { PermanentDeliveryError } from "../errors.ts";
import { fetchWithTimeout } from "../timeout.ts";
import type { Schedule } from "../types.ts";

export interface HttpDeps {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  schedule?: Schedule | undefined;
}

/**
 * The error of a failed request, without the original cause: a fetch error can carry the URL,
 * which may be a secret. Only the timeout text and a system `code` are kept.
 */
function safeFetchError(label: string, err: unknown): Error {
  if (err instanceof Error && err.message.startsWith("timeout after ")) return err;
  const error = new Error(`${label} request failed`);
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") Object.assign(error, { code });
    current = current.cause;
  }
  return error;
}

/** POSTs a JSON body without following redirects. Any non-2xx status rejects with the status only;
 * a 4xx except 408 and 429 rejects with a `PermanentDeliveryError`. */
export async function postJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  deps: HttpDeps,
  signal?: AbortSignal,
): Promise<void> {
  let status: number;
  try {
    status = await fetchWithTimeout(
      deps.fetch ?? fetch,
      url,
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", ...headers },
        body,
        ...(signal ? { signal } : {}),
      },
      deps.timeoutMs ?? 5000,
      async (res) => {
        await res.body?.cancel();
        return res.status;
      },
      deps.schedule,
    );
  } catch (err) {
    throw safeFetchError(label, err);
  }
  if (status >= 200 && status <= 299) return;
  // 408 and 429 ask for a later retry; every other 4xx will not change by itself.
  if (status >= 400 && status <= 499 && status !== 408 && status !== 429) {
    throw new PermanentDeliveryError(`${label} responded with status ${status}`, { status });
  }
  throw new Error(`${label} responded with status ${status}`);
}
