import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger-cost-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hasIo = existsSync("/proc/self/io");

/** Bytes this process passed to `write`, from an OS counter independent of the ledger. */
function wchar(): number {
  const match = /^wchar: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"));
  return Number(match?.[1]);
}

function note(key: string): Notification {
  return {
    key,
    event: "opened",
    incidentId: 1,
    checkId: "c",
    checkName: "C",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
    openedMs: 0,
  };
}

const SAMPLES = 5;

/** The 3rd smallest of 5 write deltas of `op(i)`. */
async function median(op: (i: number) => void | Promise<void>): Promise<number> {
  const deltas: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const before = wchar();
    await op(i);
    deltas.push(wchar() - before);
  }
  deltas.sort((a, b) => a - b);
  return deltas[2] ?? Number.NaN;
}

type Costs = Record<"claim" | "settle" | "resend" | "seed", number>;

async function costsAt(n: number): Promise<Costs> {
  const ledger = new Ledger(join(dir, `state-${n}.json`));
  ledger.seed(
    "c",
    Array.from({ length: n }, (_, i) => `${i}:opened`),
  );
  for (let i = 0; i < SAMPLES; i++) {
    ledger.claim("c", `s${i}:opened`, note(`s${i}:opened`));
    ledger.claim("c", `r${i}:opened`, note(`r${i}:opened`));
    ledger.settle("c", `r${i}:opened`, "failed");
  }
  await ledger.flush();
  const costs: Costs = {
    claim: await median((i) => {
      ledger.claim("c", `a${i}:opened`, note(`a${i}:opened`));
    }),
    settle: await median(async (i) => {
      ledger.settle("c", `s${i}:opened`, "delivered");
      await ledger.flush();
    }),
    resend: await median((i) => {
      ledger.resend("c", `r${i}:opened`);
    }),
    seed: await median((i) => {
      ledger.seed(
        "c",
        Array.from({ length: 5 }, (_, j) => `d${i}-${j}:opened`),
      );
    }),
  };
  ledger.close();
  return costs;
}

test.skipIf(!hasIo)(
  "a ledger write costs the same at 100 and 10,000 entries",
  async () => {
    const small = await costsAt(100);
    const large = await costsAt(10_000);
    for (const op of ["claim", "settle", "resend", "seed"] as const) {
      assert.ok(large[op] <= 65_536, `${op} at 10,000 wrote ${large[op]} bytes`);
      assert.ok(large[op] - small[op] <= 16_384, `${op} grew by ${large[op] - small[op]} bytes`);
    }
  },
  30_000,
);
