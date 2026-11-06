import { describe, expect, test } from "bun:test";
import {
  channelChanges,
  channelDigest,
  effectiveSet,
  installedChannel,
} from "../src/channel-set.ts";
import type { ChannelConfig } from "../src/types.ts";

const webhook = (id: string, url: string, secret?: string): ChannelConfig =>
  secret === undefined ? { id, type: "webhook", url } : { id, type: "webhook", url, secret };

describe("effectiveSet", () => {
  test("a file channel wins by whole id and its database copy is shadowed", () => {
    const fileOps: ChannelConfig = { id: "ops", type: "slack", url: "https://slack.test/f" };
    const set = effectiveSet(
      [installedChannel(fileOps)],
      [
        installedChannel(webhook("ops", "https://db.test/ops")),
        installedChannel(webhook("db", "https://db.test/db")),
      ],
    );
    expect(set.channels.map((c) => c.config)).toEqual([
      { id: "ops", type: "slack", url: "https://slack.test/f" },
      { id: "db", type: "webhook", url: "https://db.test/db" },
    ]);
    expect(set.shadowedIds).toEqual(["ops"]);
  });

  test("removing the file channel unshadows the database copy", () => {
    const set = effectiveSet([], [installedChannel(webhook("ops", "https://db.test/ops"))]);
    expect(set.channels.map((c) => c.config)).toEqual([
      { id: "ops", type: "webhook", url: "https://db.test/ops" },
    ]);
    expect(set.shadowedIds).toEqual([]);
  });
});

describe("channelChanges", () => {
  test("classifies added, changed, unchanged and removed ids", () => {
    const keep = installedChannel(webhook("keep", "https://a.test/1"));
    const swap = installedChannel(webhook("swap", "https://a.test/1", "s1"));
    const gone = installedChannel(webhook("gone", "https://a.test/1"));
    const swapNext = installedChannel(webhook("swap", "https://a.test/1", "s2"));
    const added = installedChannel(webhook("new", "https://a.test/1"));
    const keepAgain = installedChannel({ url: "https://a.test/1", type: "webhook", id: "keep" });
    const changes = channelChanges([keep, swap, gone], [keepAgain, swapNext, added]);
    expect(changes.map((c) => [c.kind, c.id])).toEqual([
      ["unchanged", "keep"],
      ["changed", "swap"],
      ["added", "new"],
      ["removed", "gone"],
    ]);
  });

  test("the digest is a fixed SHA-256 of the canonical resolved form", () => {
    expect(channelDigest({ url: "u", type: "webhook", id: "a" })).toBe(
      "ac8ce79388f3d204c6fb174b80590c715460eb09227d0f98381ed69cfdda249d",
    );
    expect(channelDigest({ id: "a", type: "webhook", url: "u" })).not.toBe(
      channelDigest({ id: "a", type: "webhook", url: "u", secret: "x" }),
    );
  });
});
