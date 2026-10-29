import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchChecks, fetchIncidents } from "../src/api.ts";
import { redactUrl } from "../src/redact.ts";

const wire = { "x-pulse-wire-version": "1" };

function body(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...wire, ...headers } });
}

const options = (fetchFn: typeof fetch, maxBytes: number) => ({
  baseUrl: "https://api.invalid",
  fetch: fetchFn,
  maxBytes,
  schedule: () => () => {},
});

test("a body within the cap is read", async () => {
  const result = await fetchChecks(options(async () => body(["[", "]"]), 10));
  assert.deepEqual(result, []);
});

test("a Content-Length over the cap fails early", async () => {
  const res = new Response("[]", { headers: { ...wire, "content-length": "1000" } });
  await assert.rejects(fetchIncidents(options(async () => res, 100)), /larger than 100 bytes/);
});

test("a stream past the cap is stopped, without or with a false Content-Length", async () => {
  const chunks = ["[", `"${"x".repeat(60)}",`, `"${"y".repeat(60)}"`, "]"];
  await assert.rejects(fetchIncidents(options(async () => body(chunks), 100)), /larger than/);
  await assert.rejects(
    fetchIncidents(options(async () => body(chunks, { "content-length": "5" }), 100)),
    /larger than/,
  );
});

test("an endless body is cut off at the cap", async () => {
  let sent = 0;
  const res = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(new TextEncoder().encode("0".repeat(50)));
      },
    }),
    { headers: wire },
  );
  await assert.rejects(fetchChecks(options(async () => res, 200)), /larger than/);
  assert.ok(sent < 20);
});

test("redactUrl drops user info, query and fragment", () => {
  const out = redactUrl("https://user:pw@host.example/p?token=x#frag");
  assert.equal(out, "https://host.example/p");
  assert.equal(redactUrl("not a url with secret"), "<invalid url>");
});

test("a fetch error that carries the url is logged without credentials or query", async () => {
  const url = "https://user:pw@host.example/base?token=x";
  const failing: typeof fetch = async (input) => {
    throw new TypeError(
      `Request cannot be constructed from a URL that includes credentials: ${String(input)}`,
      { cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" }) },
    );
  };
  await assert.rejects(
    fetchIncidents({ baseUrl: url, fetch: failing, schedule: () => () => {} }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const text = JSON.stringify([err.message, (err as { code?: string }).code, err.cause]);
      for (const secret of ["user", "pw", "token=x", "x@"]) {
        assert.equal(text.includes(secret), false, `${secret} in ${text}`);
      }
      assert.equal((err as { code?: string }).code, "ECONNREFUSED");
      return true;
    },
  );
});
