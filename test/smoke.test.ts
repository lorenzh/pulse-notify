import assert from "node:assert/strict";
import { test } from "node:test";
import { name } from "../src/index.ts";

test("smoke: index exports the package name", () => {
  assert.equal(name, "pulse-notify");
});
