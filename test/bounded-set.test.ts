import { test } from "bun:test";
import assert from "node:assert/strict";
import { BoundedSet } from "../src/bounded-set.ts";

test("at capacity the oldest key is evicted", () => {
  const set = new BoundedSet(3);
  assert.deepEqual(
    ["a", "b", "c", "d"].map((k) => set.add(k)),
    [true, true, true, true],
  );
  assert.equal(set.size, 3);
  assert.equal(set.has("a"), false);
  assert.equal(set.has("d"), true);
});

test("adding a held key returns false and does not refresh it", () => {
  const set = new BoundedSet(3);
  set.add("a");
  set.add("b");
  set.add("c");
  assert.equal(set.add("a"), false);
  set.add("d");
  assert.equal(set.has("a"), false);
  assert.equal(set.has("b"), true);
});
