import { test } from "bun:test";
import assert from "node:assert/strict";
import { name } from "../src/index.ts";

test("smoke: index exports the package name", () => {
  assert.equal(name, "pulse-notify");
});
