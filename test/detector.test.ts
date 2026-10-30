import { test } from "bun:test";
import assert from "node:assert/strict";
import { detectEvents, seedKeys } from "../src/detector.ts";
import { incident } from "./support.ts";

test("open incident yields opened only", () => {
  const events = detectEvents([incident({ id: 1 })], () => false);
  assert.deepEqual(
    events.map((e) => e.key),
    ["1:opened"],
  );
});

test("resolved incident with unrecorded opened yields opened then resolved", () => {
  const events = detectEvents([incident({ id: 2, resolvedAt: 5 })], () => false);
  assert.deepEqual(
    events.map((e) => e.key),
    ["2:opened", "2:resolved"],
  );
});

test("resolved incident with recorded opened yields resolved only", () => {
  const events = detectEvents([incident({ id: 2, resolvedAt: 5 })], (k) => k === "2:opened");
  assert.deepEqual(
    events.map((e) => e.event),
    ["resolved"],
  );
});

test("handled events yield nothing", () => {
  assert.deepEqual(
    detectEvents([incident({ id: 3, resolvedAt: 5 })], () => true),
    [],
  );
});

test("seedKeys covers opened and resolved", () => {
  assert.deepEqual(seedKeys([incident({ id: 1 }), incident({ id: 2, resolvedAt: 9 })]), [
    "1:opened",
    "2:opened",
    "2:resolved",
  ]);
});
