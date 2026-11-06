import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getService } from "../src/api.ts";
import { ChannelSync } from "../src/channel-sync.ts";
import { signBody } from "../src/channels/signature.ts";
import { parseConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import { buildServiceReport } from "../src/service-report.ts";
import { makeCert, type SmtpStub, startSmtpStub, type TestCert } from "./smtp-stub.ts";
import {
  type FakeApi,
  incident,
  manualIncident,
  type ReceivedRequest,
  type Receiver,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

/*
 * The per-field matrix: for each exposed field one running Notifier, ledger and sync go through
 * V1 (database) -> V2 (database) -> V3 (a file channel with the same id wins whole) -> V2 (the file
 * channel is removed). Every step polls once, sends fresh events and records what the shared fake
 * receivers and SMTP stubs got. The expected strings are literals written for each row.
 */

const TOKEN = "sentinel-matrix-token-0123456789";
const S1 = "sentinel-sig-one-0123456789";
const S2 = "sentinel-sig-two-0123456789";
const S3 = "sentinel-sig-three-0123456789";
const P1 = "sentinel-pass-one-0123456789";
const P2 = "sentinel-pass-two-0123456789";
const P3 = "sentinel-pass-three-0123456789";
const REVS = ["1", "2"].map((d) => `sha256-${d.repeat(64)}`);
const STAMPS = { createdAt: 1, updatedAt: 2 };
const START = Date.UTC(2026, 0, 1, 12, 0, 0);

const dir = mkdtempSync(join(tmpdir(), "notify-fields-"));
const secretDir = join(dir, "secrets");
mkdirSync(secretDir);

let cert: TestCert;
let api: FakeApi;
const receivers: Record<"r1" | "r2" | "r3", Receiver> = {} as Record<"r1" | "r2" | "r3", Receiver>;
let smtpA: SmtpStub;
let smtpB: SmtpStub;
let smtpTls: SmtpStub;
let env: Record<string, string>;

beforeAll(async () => {
  cert = makeCert();
  api = await startFakeApi();
  for (const name of ["r1", "r2", "r3"] as const) receivers[name] = await startReceiver();
  smtpA = await startSmtpStub({ auth: ["PLAIN"] });
  smtpB = await startSmtpStub({ auth: ["PLAIN"] });
  smtpTls = await startSmtpStub({ starttls: cert });
  // R2 is the sentinel destination: its full URL must never reach a report, log or metric.
  env = {
    PULSE_NOTIFY_SECRET_R1: `${receivers.r1.url}/hook-r1`,
    PULSE_NOTIFY_SECRET_R2: `${receivers.r2.url}/hook-r2-sentinel`,
    PULSE_NOTIFY_SECRET_S1: S1,
    PULSE_NOTIFY_SECRET_S2: S2,
    PULSE_NOTIFY_SECRET_P1: P1,
    PULSE_NOTIFY_SECRET_P2: P2,
    FILE_R3: `${receivers.r3.url}/hook-r3`,
    FILE_S3: S3,
    FILE_P3: P3,
  };
  writeFileSync(join(secretDir, "r1.url"), `${receivers.r1.url}/hook-r1`);
  writeFileSync(join(secretDir, "r2.url"), `${receivers.r2.url}/hook-r2-sentinel`);
  writeFileSync(join(secretDir, "s1"), S1);
  writeFileSync(join(secretDir, "s2"), S2);
  writeFileSync(join(secretDir, "p1"), P1);
  writeFileSync(join(secretDir, "p2"), P2);
  writeFileSync(join(dir, "r3.url"), `${receivers.r3.url}/hook-r3`);
  writeFileSync(join(dir, "s3"), S3);
  writeFileSync(join(dir, "p3"), P3);
});

afterAll(async () => {
  await api.close();
  for (const r of Object.values(receivers)) await r.close();
  for (const s of [smtpA, smtpB, smtpTls]) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

type Def = Record<string, unknown>;

interface Row {
  name: string;
  v1: Def;
  v2: Def;
  /** The file channel; references resolve from the local env and files. */
  v3: Def;
  /** Check ids of the automatic incidents opened in each step. */
  checks?: string[];
  /** Component ids of the manual incidents opened in each step, one incident each. */
  components?: string[];
  /** Advance the clock and tick once more, so a reminder can fall due. */
  isReminderStep?: boolean;
  /** The observations of the steps V1, V2, V3 and V2 again. */
  expect: [string, string, string, string];
}

interface Mark {
  http: Record<string, number>;
  smtp: Map<SmtpStub, { commands: number; messages: number }>;
}

function mark(): Mark {
  const http = Object.fromEntries(
    Object.entries(receivers).map(([name, r]) => [name, r.requests.length]),
  );
  const smtp = new Map(
    [smtpA, smtpB, smtpTls].map((s) => [
      s,
      { commands: s.commands.length, messages: s.messages.length },
    ]),
  );
  return { http, smtp };
}

function bodyOf(req: ReceivedRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/** One HTTP delivery as a short literal-comparable text. */
function httpView(name: string, req: ReceivedRequest): string {
  const body = bodyOf(req);
  const path = new URL(`http://x${req.url ?? ""}`).pathname;
  const parts = [name + path];
  if (typeof body.event === "string") {
    const manual = body.manual as { componentIds?: string[] } | undefined;
    parts.push(
      `${body.event}:${manual ? "manual/" + (manual.componentIds ?? []).join("+") : body.checkId}`,
    );
    const signature = req.headers["x-pulse-signature"];
    if (signature === undefined) parts.push("unsigned");
    else {
      const which = [S1, S2, S3].findIndex((s) => signBody(s, req.raw) === signature);
      parts.push(which === -1 ? "bad-signature" : `signed:S${which + 1}`);
    }
  } else {
    // A chat message: report only the link and the reason line.
    const text = req.raw;
    const link = /https:\/\/status\.example\/(v\d)/.exec(text);
    parts.push(link ? `link:${link[1]}` : "no-link");
    parts.push(/Reason/.test(text) ? "reason" : "no-reason");
  }
  return parts.join(" ");
}

/** One SMTP session as text: port label, EHLO name, TLS, AUTH, envelope and Subject. */
function smtpView(label: string, commands: string[], messages: string[]): string {
  const ehlo = commands.find((c) => c.startsWith("EHLO "))?.slice(5) ?? "-";
  const isTls = commands.includes("STARTTLS");
  const authLine = commands.find((c) => c.startsWith("AUTH PLAIN"));
  let auth = "no-auth";
  if (authLine !== undefined) {
    const [, user, pass] = Buffer.from(authLine.split(" ")[2] ?? "", "base64")
      .toString("utf8")
      .split("\0");
    const index = [P1, P2, P3].indexOf(pass ?? "");
    auth = `auth:${user}/${index === -1 ? "?" : "P" + String(index + 1)}`;
  }
  const from = commands
    .find((c) => c.startsWith("MAIL FROM:"))
    ?.replace(/^MAIL FROM:<([^>]*)>.*/, "$1");
  const rcpt = commands
    .filter((c) => c.startsWith("RCPT TO:"))
    .map((c) => c.replace(/^RCPT TO:<([^>]*)>.*/, "$1"))
    .join("+");
  const subject = /^Subject: (.*)$/m.exec(messages[0] ?? "")?.[1]?.trim() ?? "-";
  const body = messages[0] ?? "";
  const link = /https:\/\/status\.example\/(v\d)/.exec(body);
  const extra = link ? [`link:${link[1]}`, /Reason/.test(body) ? "reason" : "no-reason"] : [];
  return [
    label,
    `ehlo:${ehlo}`,
    isTls ? "starttls" : "plain",
    auth,
    `from:${from ?? "-"}`,
    `to:${rcpt || "-"}`,
    `subject:${subject}`,
    ...extra,
  ].join(" ");
}

function observe(since: Mark): string {
  const out: string[] = [];
  for (const [name, r] of Object.entries(receivers)) {
    for (const req of r.requests.slice(since.http[name] ?? 0)) out.push(httpView(name, req));
  }
  const labels = new Map([
    [smtpA, "smtpA"],
    [smtpB, "smtpB"],
    [smtpTls, "smtpTls"],
  ]);
  for (const [stub, at] of since.smtp) {
    const commands = stub.commands.slice(at.commands);
    if (commands.length === 0) continue;
    out.push(smtpView(labels.get(stub) ?? "?", commands, stub.messages.slice(at.messages)));
  }
  return out.length === 0 ? "none" : out.toSorted((a, b) => a.localeCompare(b)).join(" | ");
}

async function runRow(row: Row): Promise<{ seen: string[]; shadowed: string[][]; leak: string }> {
  const rowDir = mkdtempSync(join(dir, "row-"));
  const filePath = join(rowDir, "channels.json");
  writeFileSync(filePath, JSON.stringify({ channels: [] }));
  const clock = { now: START };
  const ledger = new Ledger(join(rowDir, "state.sqlite"), { now: () => clock.now });
  const logger = spyLogger();
  const metrics = new Metrics([], () => 0);
  api.incidents = [];
  api.manualIncidents = [];
  const notifier = new Notifier({
    config: { channels: [] },
    apiUrl: api.url,
    ledger,
    logger,
    metrics,
    now: () => clock.now,
    sleep: () => Promise.resolve(),
    schedule: () => () => {},
    retryAttempts: 1,
    hostname: () => "notify.test",
    timeoutMs: 2000,
  });
  const localSource = {
    env,
    readFile: (path: string) => readFileSync(join(dir, path.replace(/^.*\//, "")), "utf8"),
  };
  const sync = new ChannelSync({
    ledger,
    install: (channels) => notifier.reconcile(channels),
    readFile: () => readFileSync(filePath, "utf8"),
    parseFile: (text) =>
      parseConfig(JSON.parse(text), filePath, localSource, { allowEmpty: true }).channels,
    fetchChannels: (etag) =>
      getService(
        { baseUrl: api.url, token: TOKEN },
        "service/notify/channels",
        (raw) => ({ ok: true, value: raw }),
        etag,
      ),
    secrets: { env, secretDir, realpath: realpathSync, readFile: (p) => readFileSync(p, "utf8") },
    now: () => clock.now,
    logger,
  });
  const seen: string[] = [];
  const shadowed: string[][] = [];
  const reports: string[] = [];
  let next = 1;
  const step = async (index: number, db: Def, file: Def | undefined): Promise<void> => {
    const rev = REVS[index % 2] ?? "";
    api.notifyChannels = {
      etag: `"${rev}"`,
      body: { revision: rev, channels: [{ ...db, ...STAMPS }] },
    };
    writeFileSync(filePath, JSON.stringify({ channels: file === undefined ? [] : [file] }));
    await sync.poll();
    await notifier.idle();
    // A first tick seeds what the feed already shows, so only the new events below are sent.
    await notifier.tick();
    await notifier.idle();
    const since = mark();
    if (row.isReminderStep === true) {
      api.incidents = [];
      await notifier.tick();
    }
    for (const checkId of row.checks ?? ["api"]) {
      api.incidents.push(incident({ id: next++, checkId, openedAt: clock.now }));
    }
    for (const component of row.components ?? []) {
      api.manualIncidents?.push(
        manualIncident({ id: next++, componentIds: [component], createdAt: clock.now }),
      );
    }
    await notifier.tick();
    await notifier.idle();
    if (row.isReminderStep === true) {
      clock.now += 61_000;
      await notifier.tick();
      await notifier.idle();
    }
    seen.push(observe(since));
    const state = sync.state();
    shadowed.push(state.shadowedIds);
    reports.push(
      JSON.stringify(
        buildServiceReport({
          at: clock.now,
          startedAt: START,
          appliedRevision: state.appliedRevision,
          fileChannels: state.fileChannels.map((c) => ({
            id: c.id,
            type: c.type,
            raw: file ?? {},
          })),
          shadowedIds: state.shadowedIds,
          rejected: state.rejected,
          failed: ledger.failed(),
        }),
      ),
    );
    clock.now += 1000;
  };
  try {
    await step(0, row.v1, undefined);
    await step(1, row.v2, undefined);
    await step(2, row.v2, row.v3);
    await step(3, row.v2, undefined);
  } finally {
    await sync.stop();
    await notifier.stop();
    ledger.close();
    rmSync(rowDir, { recursive: true, force: true });
  }
  const leak = [reports.join("\n"), JSON.stringify(logger.entries), metrics.render()].join("\n");
  return { seen, shadowed, leak };
}

const R1 = { urlEnv: "PULSE_NOTIFY_SECRET_R1" };
const R2 = { urlEnv: "PULSE_NOTIFY_SECRET_R2" };
const R3 = { urlEnv: "FILE_R3" };
const F1 = { urlFile: "r1.url" };
const F2 = { urlFile: "r2.url" };
const F3 = { urlFile: "r3.url" };

function smtpPort(stub: () => SmtpStub): number {
  return stub().port;
}

/** An email channel to stub A without TLS; `over` replaces fields, `smtp` replaces smtp fields. */
function mail(id: string, over: Def = {}, smtp: Def = {}): () => Def {
  return () => ({
    id,
    type: "email",
    from: "pulse@example.org",
    to: ["ops@example.org"],
    ...over,
    smtp: { host: "127.0.0.1", port: smtpPort(() => smtpA), tls: "none", ...smtp },
  });
}

type LazyRow = Omit<Row, "v1" | "v2" | "v3"> & {
  v1: Def | (() => Def);
  v2: Def | (() => Def);
  v3: Def | (() => Def);
};

function chatRows(type: "slack" | "teams"): LazyRow[] {
  return [
    {
      name: `${type} urlEnv`,
      v1: { id: "x", type, ...R1 },
      v2: { id: "x", type, ...R2 },
      v3: { id: "x", type, ...R3 },
      expect: [
        "r1/hook-r1 no-link reason",
        "r2/hook-r2-sentinel no-link reason",
        "r3/hook-r3 no-link reason",
        "r2/hook-r2-sentinel no-link reason",
      ],
    },
    {
      name: `${type} urlFile`,
      v1: { id: "x", type, ...F1 },
      v2: { id: "x", type, ...F2 },
      v3: { id: "x", type, ...F3 },
      expect: [
        "r1/hook-r1 no-link reason",
        "r2/hook-r2-sentinel no-link reason",
        "r3/hook-r3 no-link reason",
        "r2/hook-r2-sentinel no-link reason",
      ],
    },
    {
      name: `${type} statusUrl`,
      v1: { id: "x", type, ...R1, statusUrl: "https://status.example/v1" },
      v2: { id: "x", type, ...R1, statusUrl: "https://status.example/v2" },
      v3: { id: "x", type, ...R3, statusUrl: "https://status.example/v3" },
      expect: [
        "r1/hook-r1 link:v1 reason",
        "r1/hook-r1 link:v2 reason",
        "r3/hook-r3 link:v3 reason",
        "r1/hook-r1 link:v2 reason",
      ],
    },
    {
      name: `${type} hideReason`,
      v1: { id: "x", type, ...R1 },
      v2: { id: "x", type, ...R1, hideReason: true },
      v3: { id: "x", type, ...R3, hideReason: false },
      expect: [
        "r1/hook-r1 no-link reason",
        "r1/hook-r1 no-link no-reason",
        "r3/hook-r3 no-link reason",
        "r1/hook-r1 no-link no-reason",
      ],
    },
  ];
}

const hook = (over: Def = {}): Def => ({ id: "x", type: "webhook", ...R1, ...over });

/** The rows that read no stub port at once. */
function earlyRows(): LazyRow[] {
  return [
    {
      name: "webhook urlEnv",
      v1: hook(),
      v2: hook(R2),
      v3: hook(R3),
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r2/hook-r2-sentinel opened:api unsigned",
        "r3/hook-r3 opened:api unsigned",
        "r2/hook-r2-sentinel opened:api unsigned",
      ],
    },
    {
      name: "webhook urlFile",
      v1: { id: "x", type: "webhook", ...F1 },
      v2: { id: "x", type: "webhook", ...F2 },
      v3: { id: "x", type: "webhook", ...F3 },
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r2/hook-r2-sentinel opened:api unsigned",
        "r3/hook-r3 opened:api unsigned",
        "r2/hook-r2-sentinel opened:api unsigned",
      ],
    },
    {
      name: "webhook secretEnv",
      v1: hook(),
      v2: hook({ secretEnv: "PULSE_NOTIFY_SECRET_S2" }),
      v3: hook({ ...R3, secretEnv: "FILE_S3" }),
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r1/hook-r1 opened:api signed:S2",
        "r3/hook-r3 opened:api signed:S3",
        "r1/hook-r1 opened:api signed:S2",
      ],
    },
    {
      name: "webhook secretFile",
      v1: hook({ secretFile: "s1" }),
      v2: hook({ secretFile: "s2" }),
      v3: hook({ ...R3, secretFile: "s3" }),
      expect: [
        "r1/hook-r1 opened:api signed:S1",
        "r1/hook-r1 opened:api signed:S2",
        "r3/hook-r3 opened:api signed:S3",
        "r1/hook-r1 opened:api signed:S2",
      ],
    },
    ...chatRows("slack"),
    ...chatRows("teams"),
    {
      name: "type webhook -> slack",
      v1: hook(),
      v2: { id: "x", type: "slack", ...R1 },
      v3: { id: "x", type: "webhook", ...R3 },
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r1/hook-r1 no-link reason",
        "r3/hook-r3 opened:api unsigned",
        "r1/hook-r1 no-link reason",
      ],
    },
    {
      name: "checks, with quiet widening",
      v1: hook({ checks: ["api"] }),
      v2: hook({ checks: ["api", "web"] }),
      v3: hook({ ...R3, checks: ["web"] }),
      checks: ["api", "web"],
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r1/hook-r1 opened:api unsigned | r1/hook-r1 opened:web unsigned",
        "r3/hook-r3 opened:web unsigned",
        "r1/hook-r1 opened:api unsigned | r1/hook-r1 opened:web unsigned",
      ],
    },
    {
      name: "excludeChecks",
      v1: hook(),
      v2: hook({ excludeChecks: ["web"] }),
      v3: hook({ ...R3, excludeChecks: ["api"] }),
      checks: ["api", "web"],
      expect: [
        "r1/hook-r1 opened:api unsigned | r1/hook-r1 opened:web unsigned",
        "r1/hook-r1 opened:api unsigned",
        "r3/hook-r3 opened:web unsigned",
        "r1/hook-r1 opened:api unsigned",
      ],
    },
    {
      name: "components",
      v1: hook({ checks: ["none"] }),
      v2: hook({ checks: ["none"], components: ["web"] }),
      v3: hook({ ...R3, checks: ["none"], components: ["db"] }),
      components: ["web", "db"],
      expect: [
        "r1/hook-r1 opened:manual/db unsigned | r1/hook-r1 opened:manual/web unsigned",
        "r1/hook-r1 opened:manual/web unsigned",
        "r3/hook-r3 opened:manual/db unsigned",
        "r1/hook-r1 opened:manual/web unsigned",
      ],
    },
    {
      name: "excludeComponents",
      v1: hook({ checks: ["none"] }),
      v2: hook({ checks: ["none"], excludeComponents: ["db"] }),
      v3: hook({ ...R3, checks: ["none"], excludeComponents: ["web"] }),
      components: ["web", "db"],
      expect: [
        "r1/hook-r1 opened:manual/db unsigned | r1/hook-r1 opened:manual/web unsigned",
        "r1/hook-r1 opened:manual/web unsigned",
        "r3/hook-r3 opened:manual/db unsigned",
        "r1/hook-r1 opened:manual/web unsigned",
      ],
    },
    {
      name: "sendIncidents",
      v1: hook(),
      v2: hook({ sendIncidents: false, alerts: ["budget-low"] }),
      v3: hook({ ...R3 }),
      expect: ["r1/hook-r1 opened:api unsigned", "none", "r3/hook-r3 opened:api unsigned", "none"],
    },
    {
      name: "remindEverySeconds",
      v1: hook(),
      v2: hook({ remindEverySeconds: 60 }),
      v3: hook({ ...R3 }),
      isReminderStep: true,
      expect: [
        "r1/hook-r1 opened:api unsigned",
        "r1/hook-r1 opened:api unsigned | r1/hook-r1 reminder:api unsigned",
        "r3/hook-r3 opened:api unsigned",
        "r1/hook-r1 opened:api unsigned | r1/hook-r1 reminder:api unsigned",
      ],
    },
    {
      name: "email smtp.host",
      v1: mail("x", {}, { host: "unresolvable.invalid" }),
      v2: mail("x"),
      v3: mail("x", { from: "file@example.org" }),
      expect: [
        "none",
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain no-auth from:file@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
      ],
    },
    {
      name: "email smtp.port",
      v1: mail("x"),
      v2: mail("x", {}, { port: smtpPort(() => smtpB) }),
      v3: () => mail("x", {}, { port: smtpB.port, clientName: "file.example" })(),
      expect: [
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpB ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpB ehlo:file.example plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpB ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
      ],
    },
  ];
}

/** Rows whose definitions read a stub port, built once the stubs listen. */
function lateRows(): LazyRow[] {
  return [
    {
      name: "email smtp.tls",
      v1: mail("x", {}, { port: smtpTls.port }),
      v2: mail("x", {}, { port: smtpTls.port, tls: "starttls" }),
      v3: mail("x", {}, { port: smtpTls.port, clientName: "file.example" }),
      expect: [
        "smtpTls ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpTls ehlo:notify.test starttls no-auth from:- to:- subject:-",
        "smtpTls ehlo:file.example plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpTls ehlo:notify.test starttls no-auth from:- to:- subject:-",
      ],
    },
    {
      name: "email smtp.username and smtp.passwordEnv",
      v1: mail("x", {}, { username: "u1", passwordEnv: "PULSE_NOTIFY_SECRET_P1" }),
      v2: mail("x", {}, { username: "u2", passwordEnv: "PULSE_NOTIFY_SECRET_P2" }),
      v3: mail("x", {}, { username: "u3", passwordEnv: "FILE_P3" }),
      expect: [
        "smtpA ehlo:notify.test plain auth:u1/P1 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u2/P2 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u3/P3 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u2/P2 from:pulse@example.org to:ops@example.org subject:DOWN: api",
      ],
    },
    {
      name: "email smtp.passwordFile",
      v1: mail("x", {}, { username: "u", passwordFile: "p1" }),
      v2: mail("x", {}, { username: "u", passwordFile: "p2" }),
      v3: mail("x", {}, { username: "u", passwordFile: "p3" }),
      expect: [
        "smtpA ehlo:notify.test plain auth:u/P1 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u/P2 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u/P3 from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain auth:u/P2 from:pulse@example.org to:ops@example.org subject:DOWN: api",
      ],
    },
    {
      name: "email smtp.clientName",
      v1: mail("x", {}, { clientName: "one.example" }),
      v2: mail("x", {}, { clientName: "two.example" }),
      v3: mail("x", {}, { clientName: "[127.0.0.1]" }),
      expect: [
        "smtpA ehlo:one.example plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:two.example plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:[127.0.0.1] plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
        "smtpA ehlo:two.example plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api",
      ],
    },
    {
      name: "email from, to and subjectPrefix",
      v1: mail("x", { from: "one@example.org", to: ["a@example.org"], subjectPrefix: "[one]" }),
      v2: mail("x", {
        from: "two@example.org",
        to: ["b@example.org", "c@example.org"],
        subjectPrefix: "[two]",
      }),
      v3: mail("x", { from: "three@example.org", to: ["d@example.org"] }),
      expect: [
        "smtpA ehlo:notify.test plain no-auth from:one@example.org to:a@example.org subject:[one] DOWN: api",
        "smtpA ehlo:notify.test plain no-auth from:two@example.org to:b@example.org+c@example.org subject:[two] DOWN: api",
        "smtpA ehlo:notify.test plain no-auth from:three@example.org to:d@example.org subject:DOWN: api",
        "smtpA ehlo:notify.test plain no-auth from:two@example.org to:b@example.org+c@example.org subject:[two] DOWN: api",
      ],
    },
    {
      name: "email statusUrl and hideReason",
      v1: mail("x", { statusUrl: "https://status.example/v1" }),
      v2: mail("x", { statusUrl: "https://status.example/v2", hideReason: true }),
      v3: mail("x", { statusUrl: "https://status.example/v3" }),
      expect: [
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api link:v1 reason",
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api link:v2 no-reason",
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api link:v3 reason",
        "smtpA ehlo:notify.test plain no-auth from:pulse@example.org to:ops@example.org subject:DOWN: api link:v2 no-reason",
      ],
    },
  ];
}

function resolveDef(def: Def | (() => Def)): Def {
  return typeof def === "function" ? def() : def;
}

test("the per-field matrix: database V1 -> V2, file V3 wins whole, file removal restores V2", async () => {
  const failures: string[] = [];
  for (const lazy of [...earlyRows(), ...lateRows()]) {
    const row: Row = {
      ...lazy,
      v1: resolveDef(lazy.v1),
      v2: resolveDef(lazy.v2),
      v3: resolveDef(lazy.v3),
    };
    const result = await runRow(row);
    try {
      assert.deepEqual(result.seen, row.expect);
      assert.deepEqual(result.shadowed, [[], [], ["x"], []]);
      for (const sentinel of [TOKEN, S1, S2, S3, P1, P2, P3, "hook-r2-sentinel"]) {
        assert.equal(result.leak.includes(sentinel), false, `${sentinel} leaked`);
      }
    } catch (err) {
      failures.push(`${row.name}: ${(err as Error).message}`);
    }
  }
  assert.deepEqual(failures, []);
}, 60_000);
