import type { Schedule } from "./types.ts";

export const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** fetch that aborts after `ms`, using an injectable timer. */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
  schedule: Schedule = defaultSchedule,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = schedule(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new Error(`timeout after ${ms}ms`);
    throw err;
  } finally {
    cancel();
  }
}
