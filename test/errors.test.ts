import { test } from "bun:test";
import assert from "node:assert/strict";
import { errorFields } from "../src/errors.ts";

test("errorFields walks the cause chain for code and innermost cause", () => {
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
    code: "ECONNREFUSED",
  });
  const err = new TypeError("fetch failed", { cause: inner });
  assert.deepEqual(errorFields(err), {
    error: "fetch failed",
    code: "ECONNREFUSED",
    cause: "connect ECONNREFUSED 127.0.0.1:1",
  });
});

test("errorFields handles plain errors and non-errors", () => {
  assert.deepEqual(errorFields(new Error("boom")), { error: "boom" });
  assert.deepEqual(errorFields("text"), { error: "text" });
});
