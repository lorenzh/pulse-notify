import type { Schedule } from "./types.ts";

export const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * Fetches and reads the response under one timer, so a stalled body times out too.
 * `read` runs while the timer is still active. `init.signal` aborts the request early.
 */
export async function fetchWithTimeout<T>(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
  read: (res: Response) => Promise<T>,
  schedule: Schedule = defaultSchedule,
): Promise<T> {
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  let expire: (err: Error) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = reject;
  });
  // The race below handles a rejection; this keeps an unraced one from being unhandled.
  expired.catch(() => {});
  const cancel = schedule(() => {
    controller.abort();
    expire(new Error(`timeout after ${ms}ms`));
  }, ms);
  try {
    return await Promise.race([
      fetchFn(url, { ...init, signal }).then((res) => read(res)),
      expired,
    ]);
  } finally {
    cancel();
  }
}
