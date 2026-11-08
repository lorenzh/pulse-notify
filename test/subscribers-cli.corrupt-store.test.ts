// Corrupt subscriber store: subscribers delete exits 2 with one address-free line.
import { Database, SQLiteError } from "bun:sqlite";
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/ledger-lock.ts";
import { SubscriberStore } from "../src/subscriber-store.ts";
import { runSubscribers } from "../src/subscribers-cli.ts";
import { tempDir, testLockDeps } from "./subscriptions-support.ts";

const REASON = ": the file is corrupt or not a database";
const PREFIX = "pulse-notify: cannot use subscription store ";
const INDEX = join(import.meta.dir, "..", "src", "index.ts");

let dir: string;
let remove: () => void;

beforeEach(() => {
  ({ dir, remove } = tempDir("notify-subs-corrupt-"));
});
afterEach(() => remove());

const diagnostic = (shown: string): string => PREFIX + shown + REASON;

const run = (path: string, ...args: string[]): { lines: string[]; code: number } =>
  runSubscribers(args, { storePath: path, lock: testLockDeps() });

function writeN(name = "store.db"): string {
  const path = join(dir, name);
  writeFileSync(path, "not a database sentinel@example.org\n".repeat(100));
  return path;
}

function buildStore(rollback: boolean): string {
  const path = join(dir, "store.db");
  SubscriberStore.open(path).close();
  const db = new Database(path);
  if (rollback) db.run("PRAGMA journal_mode = DELETE");
  const insert = db.prepare(
    "INSERT INTO subscriptions (id, email, state, created_at, confirm_sends) VALUES (?, ?, 'confirmed', 1, 0)",
  );
  for (let i = 0; i < 50; i++) {
    insert.run(`id${i}`, i === 0 ? "probe@example.com" : `sentinel${i}@example.org`);
  }
  insert.finalize();
  db.close(true);
  return path;
}

function damage(path: string, page: "schema" | "table"): void {
  const bytes = readFileSync(path);
  const pageSize = bytes.readUInt16BE(16);
  if (page === "schema") bytes.fill(0xff, 100, pageSize);
  else bytes.fill(0xff, pageSize, pageSize + 100);
  writeFileSync(path, bytes);
}

function writeS(): string {
  const path = buildStore(false);
  damage(path, "schema");
  return path;
}

function writeT(): string {
  const path = buildStore(false);
  damage(path, "table");
  return path;
}

function writeR(): string {
  const path = buildStore(true);
  damage(path, "table");
  return path;
}

function assertNoLeak(output: string, address: string): void {
  for (const forbidden of [address, address.toLowerCase(), "sentinel", "SQLite", "    at "]) {
    assert.equal(output.includes(forbidden), false, `output holds ${forbidden}`);
  }
}

function assertClean(path: string, before: Buffer, output: string, address: string): void {
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.deepEqual(readdirSync(dir), [path.slice(dir.length + 1)]);
  acquireLock(path, testLockDeps()).release();
  assertNoLeak(output, address);
}

function runExecutable(path: string, address: string): void {
  const before = readFileSync(path);
  const result = spawnSync(process.execPath, [INDEX, "subscribers", "delete", address], {
    env: { PATH: process.env.PATH ?? "", PULSE_NOTIFY_SUBSCRIPTIONS_STATE: path },
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${diagnostic(path)}\n`);
  assertClean(path, before, result.stdout + result.stderr, address);
}

function runPublic(path: string, address: string): void {
  const before = readFileSync(path);
  const result = run(path, "delete", address);
  assert.deepEqual(result, { lines: [diagnostic(path)], code: 2 });
  assertClean(path, before, result.lines.join("\n"), address);
}

describe("subscribers delete on a corrupt store", () => {
  test("executable on a non-database file with a stored address exits 2", () => {
    runExecutable(writeN(), "probe@example.com");
  });

  test("executable on a non-database file with an absent mixed-case address exits 2", () => {
    runExecutable(writeN(), "Absent@Example.com");
  });

  test("a non-database file returns the diagnostic with code 2", () => {
    runPublic(writeN(), "probe@example.com");
  });

  test("a damaged schema page returns code 2 for a stored address", () => {
    runPublic(writeS(), "probe@example.com");
  });

  test("a damaged schema page returns code 2 for an absent address", () => {
    runPublic(writeS(), "Absent@Example.com");
  });

  test("a damaged table page returns code 2 for a stored address", () => {
    runPublic(writeT(), "probe@example.com");
  });

  const paths: ReadonlyArray<readonly [string, string, string]> = [
    ["LF", "a\nb.db", "a\\u000ab.db"],
    ["CR", "a\rb.db", "a\\u000db.db"],
    ["CRLF", "a\r\nb.db", "a\\u000d\\u000ab.db"],
    ["backslash n", "a\\nb.db", "a\\\\nb.db"],
    [
      "U+2028, NEL, DEL and ESC",
      "a\u2028b\u0085c\u007fd\u001be.db",
      "a\\u2028b\\u0085c\\u007fd\\u001be.db",
    ],
  ];
  for (const [label, name, shown] of paths) {
    test(`a path with ${label} is escaped on one line`, () => {
      const path = writeN(name);
      const result = run(path, "delete", "probe@example.com");
      assert.deepEqual(result, { lines: [diagnostic(join(dir, shown))], code: 2 });
    });
  }

  test("a damaged rollback-journal store returns code 2 and changes only the header", () => {
    const path = writeR();
    const before = readFileSync(path);
    assert.deepEqual([before[18], before[19]], [1, 1]);
    const result = run(path, "delete", "probe@example.com");
    assert.deepEqual(result, { lines: [diagnostic(path)], code: 2 });
    const after = readFileSync(path);
    assert.equal(after.length, before.length);
    assert.deepEqual([after[18], after[19]], [2, 2]);
    assert.equal(after.readUInt32BE(24), before.readUInt32BE(24) + 1);
    assert.equal(after.readUInt32BE(92), before.readUInt32BE(92) + 1);
    before.copy(after, 18, 18, 20);
    before.copy(after, 24, 24, 28);
    before.copy(after, 92, 92, 96);
    assert.deepEqual(after, before);
    assert.equal(existsSync(`${path}.lock`), false);
    assert.deepEqual(readdirSync(dir), ["store.db"]);
    assertNoLeak(result.lines.join("\n"), "probe@example.com");
  });

  test("argument checks still exit 1 before the store is touched", () => {
    const path = writeN();
    const before = readFileSync(path);
    const usage = { lines: ["usage: pulse-notify subscribers delete <address>"], code: 1 };
    assert.deepEqual(run(path, "list"), usage);
    assert.deepEqual(run(path), usage);
    assert.deepEqual(run(path, "delete"), usage);
    assert.deepEqual(run(path, "delete", "a@example.com", "extra"), usage);
    assert.deepEqual(run(path, "delete", "not-an-address"), {
      lines: ["pulse-notify: subscribers delete: invalid address"],
      code: 1,
    });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(`${path}.lock`), false);
  });

  test("an unknown store format keeps its own line", () => {
    const path = join(dir, "store.db");
    SubscriberStore.open(path).close();
    const db = new Database(path);
    db.run("PRAGMA user_version = 2");
    db.close(true);
    assert.deepEqual(run(path, "delete", "probe@example.com"), {
      lines: ["pulse-notify: PULSE_NOTIFY_SUBSCRIPTIONS_STATE: the store has an unknown format"],
      code: 2,
    });
    assert.equal(existsSync(`${path}.lock`), false);
  });

  test("a directory path is rethrown, not reported as corrupt", () => {
    const path = join(dir, "store.db");
    mkdirSync(path);
    assert.throws(
      () => run(path, "delete", "probe@example.com"),
      (err: unknown) => err instanceof SQLiteError && err.code === "SQLITE_CANTOPEN",
    );
    assert.equal(existsSync(`${path}.lock`), false);
  });
});
