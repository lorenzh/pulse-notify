import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { validateResendClaimResponse } from "@lorenzh/pulse-contract";
import {
  createLogger,
  type Env,
  type Logger,
  type LogLevel,
  type OpsServer,
  type Readiness,
  readLogLevel,
  readString,
  runService,
  StartupError,
  startOpsServer,
} from "@lorenzh/pulse-kit";
import { getService, type ServiceOptions, sendService } from "./api.ts";
import { ChannelSync } from "./channel-sync.ts";
import type { SendMail } from "./channels/mailer.ts";
import { sendMail as smtpSendMail } from "./channels/smtp-send.ts";
import {
  ConfigError,
  loadBudgetThreshold,
  loadConfigFile,
  loadLockLeaseSeconds,
  loadSettings,
  parseConfig,
  type Settings,
} from "./config.ts";
import { errorFields } from "./errors.ts";
import { runFailed } from "./failed-cli.ts";
import { Ledger } from "./ledger.ts";
import {
  acquireLock,
  heartbeatIntervalSeconds,
  type LedgerLock,
  type LockDeps,
  LockLostError,
} from "./ledger-lock.ts";
import { createMailboxGuard, type MailboxGuard } from "./mailbox-guard.ts";
import { Metrics } from "./metrics.ts";
import { Notifier, type NotifierOptions, type PollHealth } from "./notifier.ts";
import { redactUrl } from "./redact.ts";
import {
  type PostOutcome,
  type ResendCommandDeps,
  type ResendLoop,
  startResendLoop,
} from "./resend-commands.ts";
import { buildServiceReport, type FileChannelSource } from "./service-report.ts";
import {
  ConfirmationWorker,
  createSubscriberDetection,
  IncidentWorker,
  type ManualRead,
  type Sleep,
} from "./subscriber-fanout.ts";
import { type CleanupTimer, SubscriberStore, startCleanup } from "./subscriber-store.ts";
import { runSubscribers } from "./subscribers-cli.ts";
import { createSubscriptionOperations } from "./subscription-requests.ts";
import { type SubscriptionServer, startSubscriptionServer } from "./subscription-server.ts";
import {
  loadSubscriptionSettings,
  type SubscriptionSettings,
  type SubscriptionsOn,
  subscriptionStorePath,
} from "./subscription-settings.ts";
import type { ChannelConfig, Config, Schedule } from "./types.ts";

export const name = "pulse-notify";

/** Longest wait for the notifier to stop on SIGINT or SIGTERM. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface Stoppable {
  start(): void;
  stop(): Promise<void>;
  /** Absent in test fakes: `/readyz` then never reports failing polls. `/healthz` never reads it. */
  pollHealth?(): PollHealth;
  /** Installs a new effective channel set; absent in test fakes, which then keep their channels. */
  reconcile?(channels: readonly ChannelConfig[]): Promise<void>;
  /** Absent in test fakes: a resend command then ends `channel-unavailable`. */
  hasChannel?(id: string): boolean;
  /** Absent in test fakes: an admitted key then waits for the next start. */
  enqueueResent?(channelId: string, key: string): void;
}

/** The real clock, host, pid check and token for the state lock. */
export interface LockEnv {
  now: () => number;
  hostname: () => string;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  token: () => string;
}

function isRealPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const realLockEnv: LockEnv = {
  now: Date.now,
  hostname,
  pid: process.pid,
  isPidAlive: isRealPidAlive,
  token: randomUUID,
};

/** A timer that does not keep the process alive. */
const unrefSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface MainDeps {
  /** Called when the service must end by itself (lost state lock). */
  exit?: (code: number) => void;
  createNotifier?: (opts: NotifierOptions) => Stoppable;
  /** Where JSON log lines go, without the newline; defaults to stderr. */
  write?: (line: string) => void;
  /** Use this logger instead of building one from the settings. */
  logger?: Logger;
  /** Clock, host name, pid check and token for the state lock; defaults to the real ones. */
  lock?: Partial<LockEnv>;
  /** Timer for the lock heartbeat; defaults to an unreferenced real timer. */
  heartbeatSchedule?: Schedule;
  /** Timer for the channel poll and the report heartbeat; defaults to an unreferenced real timer. */
  channelSchedule?: Schedule;
  /** Timer for the resend command poll; defaults to an unreferenced real timer. */
  commandSchedule?: Schedule;
  /** `fetch` for the `/service/*` calls; defaults to the global one. */
  serviceFetch?: typeof fetch;
  /** Clock for the report and the applied stamps; defaults to `Date.now`. */
  now?: () => number;
  /** SMTP send of subscriber mail; defaults to the real one. */
  subscriptionSendMail?: SendMail;
  /** Sleep of the subscriber workers; defaults to a real timer. */
  subscriptionSleep?: Sleep;
}

export interface Running extends Stoppable {
  /**
   * Resolves with the health listener port, or `undefined` when it is off. Rejects with a
   * `StartupError` when the listener cannot bind.
   */
  listening: Promise<number | undefined>;
  /** Frees the state lock at once; for a stop that ran out of time. */
  releaseLock(): void;
  /**
   * Resolves with the subscription listener port, or `undefined` when subscriptions are off.
   * Settles before the notifier starts.
   */
  subscriptionsListening: Promise<number | undefined>;
  /** The mailbox guard's in-flight count; `0` when subscriptions are off. */
  subscriberGuardSize(): number;
}

function bindReason(err: unknown): string {
  const code =
    err instanceof Error ? (err.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" ? code : errorReason(err);
}

function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? "unknown error";
}

function openLedger(path: string, opts: ConstructorParameters<typeof Ledger>[1]): Ledger {
  try {
    return new Ledger(path, opts);
  } catch (err) {
    // A bad state file is a startup problem: one line, exit 2.
    throw new ConfigError(`cannot use state file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function lockDeps(
  env: Partial<LockEnv> | undefined,
  leaseSeconds: number,
  logger?: Logger,
): LockDeps {
  return { ...realLockEnv, ...env, leaseSeconds, logger };
}

export function main(env: Env = process.env, deps: MainDeps = {}): Running {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logRef: { logger?: Logger } = {};
  const state: {
    notifier?: Stoppable;
    channelLoop?: ChannelLoop;
    resendLoop?: ResendLoop | undefined;
    health?: OpsServer;
    ledger?: Ledger | undefined;
    lock?: LedgerLock | undefined;
    subscriptions?: Subscriptions | undefined;
    isShuttingDown: boolean;
  } = { isShuttingDown: false };
  // Stops the notifier, checkpoints and closes the ledger, then frees the state lock.
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    finishing ??= (async () => {
      // The channel loop stops first, so no install or report races the notifier stop.
      await state.channelLoop?.stop();
      await state.resendLoop?.stop();
      await state.notifier?.stop().catch(() => {});
      await state.subscriptions?.stop();
      await state.ledger?.flush().catch((err: unknown) => {
        logRef.logger?.error("ledger flush failed, pending keys are resent", {
          error: errorReason(err),
        });
      });
      state.ledger?.close();
      state.ledger = undefined;
      state.lock?.release();
    })();
    return finishing;
  };

  const settings = loadSettings(env);
  const budgetThreshold = loadBudgetThreshold(env);
  // Every subscription setting is checked before any file is opened (R3, R9).
  const subscriptionSettings = readSubscriptionSettings(env);
  // Token mode (Decision 11): the file is optional and may list no channel.
  const isTokenMode = settings.apiToken !== undefined;
  const source = { env, readFile: (path: string) => readFileSync(path, "utf8") };
  const fileConfig: Config =
    settings.configPath === undefined
      ? { channels: [] }
      : loadConfigFile(settings.configPath, source, { allowEmpty: isTokenMode });
  const write = deps.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger =
    deps.logger ?? createLogger({ level: settings.logLevel, write: (_level, line) => write(line) });
  logRef.logger = logger;
  const lock = acquireLock(
    settings.statePath,
    lockDeps(deps.lock, settings.lockLeaseSeconds, logger),
  );
  state.lock = lock;
  let ledger: Ledger;
  try {
    ledger = openLedger(settings.statePath, {});
  } catch (err) {
    lock.release();
    throw err;
  }
  state.ledger = ledger;
  if (ledger.migration) logger.info("ledger migrated", { ...ledger.migration });
  const now = deps.now ?? Date.now;
  const notifierRef: { current?: Stoppable } = {};
  const channels = createChannelSync(settings, env, {
    ledger,
    logger,
    now,
    fileChannels: fileConfig.channels,
    // The notifier exists only after the cold-start set below; a test fake may not reconcile.
    install: (next) => notifierRef.current?.reconcile?.(next),
    ...(deps.serviceFetch ? { fetch: deps.serviceFetch } : {}),
  });
  // Cold start: the last applied database channels work while the api is down.
  const config: Config = { channels: channels.sync.restore() };
  const metrics = new Metrics(
    config.channels.map((c) => c.id),
    () => ledger.pending().length,
    () => notifierRef.current?.pollHealth?.().consecutiveFailedPolls ?? 0,
  );
  let subscriptions: Subscriptions | undefined;
  if (subscriptionSettings.isOn) {
    try {
      subscriptions = openSubscriptions(subscriptionSettings, {
        settings,
        logger,
        metrics,
        now,
        lock: lockDeps(deps.lock, settings.lockLeaseSeconds, logger),
        sendMail: deps.subscriptionSendMail ?? smtpSendMail,
        sleep: deps.subscriptionSleep ?? realSleep,
      });
    } catch (err) {
      ledger.close();
      state.ledger = undefined;
      lock.release();
      state.lock = undefined;
      throw err;
    }
    state.subscriptions = subscriptions;
  }
  const options: NotifierOptions = {
    config,
    apiUrl: settings.apiUrl,
    ledger,
    logger,
    metrics,
    pollMs: settings.pollMs,
    retryDelayMs: settings.retryDelayMs,
    retryMaxDelayMs: settings.retryMaxDelayMs,
    retryAttempts: settings.retryAttempts,
    timeoutMs: settings.timeoutMs,
    apiMaxBytes: settings.apiMaxBytes,
    stateRetentionDays: settings.stateRetentionDays,
    smtpClientName: settings.smtpClientName,
    hostname: deps.lock?.hostname ?? hostname,
    budgetThreshold,
    ...(subscriptions ? { onManualRead: subscriptions.onManualRead } : {}),
  };
  let notifier: Stoppable;
  try {
    notifier = deps.createNotifier ? deps.createNotifier(options) : new Notifier(options);
  } catch (err) {
    // The constructor drops incidents of warning-only channels; a failure must leave no lock.
    void subscriptions?.stop();
    ledger.close();
    state.ledger = undefined;
    lock.release();
    state.lock = undefined;
    throw err;
  }
  state.notifier = notifier;
  const loop = startChannelLoop(channels, {
    ledger,
    now,
    logger,
    intervalMs: settings.channelsPollMs,
    schedule: deps.channelSchedule ?? unrefSchedule,
  });
  state.channelLoop = loop;
  const resendLoop =
    channels.service === undefined
      ? undefined
      : startResendLoop(
          resendDeps(channels.service, ledger, logger, () => notifierRef.current),
          settings.commandPollMs,
          deps.commandSchedule ?? unrefSchedule,
        );
  state.resendLoop = resendLoop;
  notifierRef.current = notifier;
  const heartbeat: HeartbeatOptions = {
    logger,
    isStopped: () => state.isShuttingDown,
    onLost: () => {
      // Another process owns the lock now: stop without writing, so two writers never meet.
      state.isShuttingDown = true;
      state.lock = undefined;
      ledger.close();
      state.ledger = undefined;
      void loop.stop();
      void resendLoop?.stop();
      void notifier.stop().catch(() => {});
      void subscriptions?.stop();
      exit(2);
    },
  };
  const heartbeatSchedule = deps.heartbeatSchedule ?? unrefSchedule;
  startHeartbeat(lock, settings.lockLeaseSeconds, heartbeatSchedule, heartbeat);
  // The store lock is a lease too; losing it stops the whole service like the state lock.
  if (subscriptions) {
    startHeartbeat(subscriptions.lock, settings.lockLeaseSeconds, heartbeatSchedule, heartbeat);
  }
  let isStarted = false;
  const startNotifier = (): void => {
    notifier.start();
    loop.start();
    resendLoop?.start();
    isStarted = true;
    logger.info("pulse-notify started", {
      channels: config.channels.map((c) => c.id),
      apiUrl: redactUrl(settings.apiUrl),
    });
  };
  const startService = (): void => {
    subscriptions?.startWorkers();
    startNotifier();
  };
  const startListeners = (): Promise<number | undefined> => {
    if (settings.healthPort === undefined) {
      startService();
      return Promise.resolve(undefined);
    }
    const { healthHost, healthPort, healthMaxFailedPolls } = settings;
    // Liveness is the lifecycle only: a failing feed must not get a working notifier restarted.
    const liveness = (): Readiness => {
      if (state.isShuttingDown) return { ready: false, reason: "shutting down" };
      if (!isStarted) return { ready: false, reason: "starting" };
      return { ready: true };
    };
    const readiness = (): Readiness => {
      if (state.isShuttingDown) return { ready: false, reason: "shutting down" };
      if (!isStarted) return { ready: false, reason: "starting" };
      const failed = notifier.pollHealth?.().consecutiveFailedPolls ?? 0;
      return failed >= healthMaxFailedPolls
        ? { ready: false, reason: `polls failing (${failed} in a row)` }
        : { ready: true };
    };
    // The notifier starts only once the listener is bound, so a bind error does no service work.
    return startOpsServer({
      host: healthHost,
      port: healthPort,
      live: liveness,
      ready: readiness,
      metrics: () => metrics.render(),
      allowHead: true,
    }).then(
      (server) => {
        state.health = server;
        if (state.isShuttingDown) {
          void server.close();
        } else {
          startService();
        }
        return server.port;
      },
      (err: unknown) => {
        void state.subscriptions?.stop();
        lock.release();
        throw new StartupError(
          `cannot listen on ${healthHost}:${healthPort} (PULSE_HEALTH_HOST/PULSE_HEALTH_PORT): ${bindReason(err)}`,
          { cause: err },
        );
      },
    );
  };
  let listening: Promise<number | undefined>;
  let subscriptionsListening: Promise<number | undefined> = Promise.resolve(undefined);
  if (subscriptions === undefined) {
    listening = startListeners();
  } else {
    // The subscription listener binds before the health listener and the notifier (R4).
    const bound = subscriptions.listen();
    subscriptionsListening = bound;
    listening = bound.then(
      () => (state.isShuttingDown ? undefined : startListeners()),
      async (err: unknown) => {
        state.isShuttingDown = true;
        await finish();
        throw err;
      },
    );
    // Callers that await only `listening` still see the failure; this copy must not be unhandled.
    subscriptionsListening.catch(() => {});
  }
  const stop = async (): Promise<void> => {
    state.isShuttingDown = true;
    await Promise.all([finish(), state.health?.close()]);
  };
  const running: Running = {
    start: () => notifier.start(),
    stop,
    listening,
    subscriptionsListening,
    subscriberGuardSize: () => subscriptions?.guard.size() ?? 0,
    releaseLock: () => {
      state.lock?.release();
      state.subscriptions?.lock.release();
    },
  };
  if (notifier.pollHealth) {
    running.pollHealth = () => notifier.pollHealth?.() ?? { consecutiveFailedPolls: 0 };
  }
  return running;
}

/** A sleep that ends early, without error, when the signal aborts. */
const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/** The running subscription service (R3-R5): store, lock, workers, listener. */
export interface Subscriptions {
  /** Hands each good manual read to detection; the notifier's `onManualRead`. */
  onManualRead: (read: ManualRead) => void;
  /** Binds the listener; rejects with a `StartupError`. */
  listen: () => Promise<number>;
  /** Starts both workers, after the listener is bound. */
  startWorkers: () => void;
  guard: MailboxGuard;
  /** The store's lease lock `<store>.lock`. */
  lock: LedgerLock;
  /** Guard stopping, workers, listener, cleanup, store, then the store lock. Runs once. */
  stop: () => Promise<void>;
}

interface SubscriptionDeps {
  settings: Settings;
  logger: Logger;
  metrics: Metrics;
  now: () => number;
  lock: LockDeps;
  sendMail: SendMail;
  sleep: Sleep;
}

/**
 * Opens the store under its own lock, runs the first cleanup and builds the workers and the
 * listener. Nothing answers or sends until `listen` and `startWorkers`. A failure unwinds.
 */
function openSubscriptions(subs: SubscriptionsOn, deps: SubscriptionDeps): Subscriptions {
  const { logger, now } = deps;
  const logError = (message: string, fields?: Record<string, unknown>): void =>
    logger.error(message, fields);
  const lock = acquireLock(subs.statePath, deps.lock);
  let store: SubscriberStore;
  try {
    // The shared lock code keeps the umask mode; the store's lock is private like the store (R3).
    chmodSync(`${subs.statePath}.lock`, 0o600);
    store = SubscriberStore.open(subs.statePath, { logger });
  } catch (err) {
    lock.release();
    throw new ConfigError(`cannot use subscription store ${subs.statePath}: ${errorName(err)}`, {
      cause: err,
    });
  }
  const guard = createMailboxGuard();
  const clientName = subs.smtp.clientName ?? deps.settings.smtpClientName;
  const smtp = clientName === undefined ? subs.smtp : { ...subs.smtp, clientName };
  const mail = { from: subs.from, subjectPrefix: subs.subjectPrefix, statusUrl: subs.statusUrl };
  const retry = {
    retryDelayMs: deps.settings.retryDelayMs,
    retryMaxDelayMs: deps.settings.retryMaxDelayMs,
  };
  const refs: { worker?: ConfirmationWorker } = {};
  const series = deps.metrics.enableSubscriptions({
    subscribers: () => {
      const c = store.counts();
      return { pending: c.pending, confirmed: c.total - c.pending };
    },
    eventsPending: () => store.pendingEventCount(),
    confirmationsQueued: () => refs.worker?.size() ?? 0,
  });
  const worker = new ConfirmationWorker({
    readRow: (id) => store.subscriptionById(id),
    guard,
    sendMail: deps.sendMail,
    smtp,
    timeoutMs: subs.sendTimeoutMs,
    mail,
    now,
    sleep: deps.sleep,
    ...retry,
    onOutcome: (o) => series.mailDone("confirmation", o),
    logError,
  });
  refs.worker = worker;
  const incidents = new IncidentWorker({
    store,
    guard,
    sendMail: deps.sendMail,
    smtp,
    timeoutMs: subs.sendTimeoutMs,
    mail,
    key: subs.key,
    now,
    sleep: deps.sleep,
    retryAttempts: deps.settings.retryAttempts,
    ...retry,
    onOutcome: (o) => series.mailDone("incident", o),
    logError,
  });
  const detection = createSubscriberDetection({
    store,
    wake: () => incidents.wake(),
    onDetected: () => series.detectionDone(),
    logError,
  });
  // Cleanup runs once here, before the listener answers (R3), then on its own timer.
  const cleanup: CleanupTimer = startCleanup({
    store,
    now,
    retentionMs: deps.settings.stateRetentionDays * 86_400_000,
    listedIds: detection.listedIds,
    onDeleted: (ids) => {
      for (const id of ids) worker.cancel(id);
    },
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    logError,
  });
  const ops = createSubscriptionOperations({
    store,
    queue: worker,
    key: subs.key,
    max: subs.max,
    maxPending: subs.maxPending,
    confirmPerHour: subs.confirmPerHour,
    onLimited: (limit) => series.limited(limit),
  });
  let server: SubscriptionServer | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // The guard stops first, so no worker takes a mailbox while the others end.
      guard.stop();
      await Promise.all([incidents.stop(), worker.stop()]);
      await server?.close();
      cleanup.stop();
      try {
        store.close();
      } catch (err) {
        logger.error("subscription store close failed", { error: errorName(err) });
      }
      lock.release();
    })();
    return stopping;
  };
  return {
    onManualRead: detection.onManualRead,
    guard,
    lock,
    startWorkers: () => {
      worker.start();
      incidents.start();
    },
    listen: () =>
      startSubscriptionServer({
        host: subs.host,
        port: subs.port,
        token: subs.token,
        ops,
        now,
        logError,
        onRequest: (route, outcome) => series.requestDone(route, outcome),
      }).then(
        (s) => {
          server = s;
          if (stopping !== undefined) void s.close();
          return s.port;
        },
        (err: unknown) => {
          throw new StartupError(
            `cannot listen on ${subs.host}:${subs.port} (PULSE_NOTIFY_SUBSCRIPTIONS_HOST/PULSE_NOTIFY_SUBSCRIPTIONS_PORT): ${bindReason(err)}`,
            { cause: err },
          );
        },
      ),
    stop,
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** Reads the subscription settings; a refusal is a `ConfigError` (exit 2) before any file. */
function readSubscriptionSettings(env: Env): SubscriptionSettings {
  try {
    return loadSubscriptionSettings(env, { readFile: (path) => readFileSync(path, "utf8") });
  } catch (err) {
    if (err instanceof StartupError) throw new ConfigError(err.message, { cause: err });
    throw err;
  }
}

/** Longest time between two service reports (R1). */
export const REPORT_HEARTBEAT_MS = 60_000;

interface ChannelSources {
  sync: ChannelSync;
  /** The raw file channels by id, for the report refs; updated with each applied file. */
  files: { raw: Map<string, Readonly<Record<string, unknown>>> };
  /** `undefined` without a token: then notify makes no service call at all. */
  service: ServiceOptions | undefined;
  startedAt: number;
}

interface SyncDeps {
  ledger: Ledger;
  logger: Logger;
  now: () => number;
  fileChannels: readonly ChannelConfig[];
  install: (channels: readonly ChannelConfig[]) => Promise<void> | void;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The raw channel objects of a file by id; an unparsable file gives none. */
function rawFileChannels(text: string): Map<string, Readonly<Record<string, unknown>>> {
  const out = new Map<string, Readonly<Record<string, unknown>>>();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // parseConfig reports the same text as invalid; the report then shows no refs.
    return out;
  }
  const list = isRecord(json) ? json.channels : undefined;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (isRecord(item) && typeof item.id === "string") out.set(item.id, item);
  }
  return out;
}

function createChannelSync(settings: Settings, env: Env, deps: SyncDeps): ChannelSources {
  const { configPath, apiToken } = settings;
  const readFile = configPath === undefined ? undefined : () => readFileSync(configPath, "utf8");
  const service: ServiceOptions | undefined =
    apiToken === undefined
      ? undefined
      : { baseUrl: settings.apiUrl, token: apiToken, fetch: deps.fetch };
  const files = {
    raw: readFile === undefined ? new Map() : rawFileChannels(safeRead(readFile)),
  };
  const source = { env, readFile: (path: string) => readFileSync(path, "utf8") };
  const sync = new ChannelSync(
    {
      ledger: deps.ledger,
      install: deps.install,
      readFile,
      parseFile: (text) => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (err) {
          throw new ConfigError(`config file ${configPath} is not valid JSON`, { cause: err });
        }
        const parsed = parseConfig(json, configPath, source, {
          allowEmpty: apiToken !== undefined,
        });
        files.raw = rawFileChannels(text);
        return parsed.channels;
      },
      fetchChannels:
        service === undefined
          ? undefined
          : (etag) =>
              getService(
                service,
                "service/notify/channels",
                (raw) => ({ ok: true, value: raw }),
                etag,
              ),
      secrets: {
        env,
        secretDir: settings.secretDir,
        realpath: realpathSync,
        readFile: (path) => readFileSync(path, "utf8"),
      },
      now: deps.now,
      logger: deps.logger,
    },
    deps.fileChannels,
  );
  return { sync, files, service, startedAt: deps.now() };
}

function safeRead(read: () => string): string {
  try {
    return read();
  } catch {
    // The startup load already read this file; a race here only empties the report refs.
    return "";
  }
}

/** The `/service/notify/resends` calls of Decision 14. */
function resendDeps(
  service: ServiceOptions,
  ledger: Ledger,
  logger: Logger,
  notifier: () => Stoppable | undefined,
): ResendCommandDeps {
  return {
    ledger,
    logger,
    claim: async () => {
      const result = await sendService(service, "POST", "service/notify/resends/claim", {}, (raw) =>
        validateResendClaimResponse(raw),
      );
      if (!result.ok) throw new ResendServiceError(`claim failed: ${result.error.kind}`);
      return result.value?.commands ?? [];
    },
    postResult: async (id, state): Promise<PostOutcome> => {
      const result = await sendService(
        service,
        "POST",
        `service/notify/resends/${encodeURIComponent(id)}/result`,
        { state },
        (raw) => ({ ok: true, value: raw }),
      );
      if (result.ok) return "acknowledged";
      const { error } = result;
      if (error.kind === "http" && (error.status === 404 || error.status === 409)) return "refused";
      return "retry";
    },
    isInstalled: (id) => notifier()?.hasChannel?.(id) ?? false,
    enqueue: (channelId, key) => notifier()?.enqueueResent?.(channelId, key),
  };
}

/** A resend call failed; the text holds the failure kind only, never an answer. */
class ResendServiceError extends Error {
  override readonly name = "ResendServiceError";
}

export interface ChannelLoop {
  start(): void;
  stop(): Promise<void>;
}

interface LoopDeps {
  ledger: Ledger;
  now: () => number;
  logger: Logger;
  intervalMs: number;
  schedule: Schedule;
}

/**
 * Polls the channel file and the database channels, installs the effective set, and reports
 * after every attempt plus at least every `REPORT_HEARTBEAT_MS`, measured from start to start.
 * Reports run one at a time: a report due while one is in flight waits, and all waiting reports
 * are sent as one follow-up built when it starts. Without a token it only re-reads the file.
 */
function startChannelLoop(sources: ChannelSources, deps: LoopDeps): ChannelLoop {
  const { sync, service } = sources;
  let isRunning = false;
  let cancelPoll: (() => void) | undefined;
  let cancelBeat: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let inFlight: Promise<void> | undefined;
  let followUp: Promise<void> | undefined;
  const report = async (): Promise<void> => {
    if (service === undefined) return;
    const view = sync.state();
    const fileChannels: FileChannelSource[] = view.fileChannels.map((c) => ({
      id: c.id,
      type: c.type,
      raw: sources.files.raw.get(c.id) ?? {},
    }));
    const body = buildServiceReport({
      at: deps.now(),
      startedAt: sources.startedAt,
      appliedRevision: view.appliedRevision,
      fileChannels,
      shadowedIds: view.shadowedIds,
      rejected: view.rejected,
      failed: deps.ledger.failed(),
    });
    try {
      const result = await sendService(service, "PUT", "service/notify/report", body, (raw) => ({
        ok: true,
        value: raw,
      }));
      if (!result.ok) deps.logger.warn("service report failed", { reason: result.error.kind });
    } catch (err) {
      deps.logger.warn("service report failed", errorFields(err));
    }
  };
  /** Starts a report in the free slot; the promise never rejects. */
  const startReport = (): Promise<void> => {
    const sent: Promise<void> = report()
      .catch((err: unknown) => {
        deps.logger.warn("service report failed", errorFields(err));
      })
      .finally(() => {
        if (inFlight === sent) inFlight = undefined;
      });
    inFlight = sent;
    return sent;
  };
  /** Starts a report, or joins the one follow-up that waits for the report in flight. */
  const requestReport = (): Promise<void> => {
    if (service === undefined) return Promise.resolve();
    const current = inFlight;
    if (current === undefined) return startReport();
    followUp ??= current.then(() => {
      followUp = undefined;
      // A stop drops the waiting report; its callers resolve without a send.
      if (!isRunning) return;
      return inFlight ?? startReport();
    });
    return followUp;
  };
  const cycle = async (): Promise<void> => {
    await sync.poll();
    await requestReport();
  };
  const nextPoll = (ms: number): void => {
    if (!isRunning) return;
    cancelPoll = deps.schedule(() => {
      running = cycle().finally(() => {
        running = undefined;
        nextPoll(deps.intervalMs);
      });
    }, ms);
  };
  const nextBeat = (): void => {
    if (!isRunning || service === undefined) return;
    cancelBeat = deps.schedule(() => {
      // The next tick is armed before the report, so a slow report never stretches the cadence.
      nextBeat();
      void requestReport();
    }, REPORT_HEARTBEAT_MS);
  };
  return {
    start: () => {
      if (isRunning) return;
      isRunning = true;
      nextPoll(0);
      nextBeat();
    },
    stop: async () => {
      isRunning = false;
      cancelPoll?.();
      cancelBeat?.();
      // A report in flight must end before the ledger closes and the lock is released.
      await Promise.all([running, inFlight, followUp]);
    },
  };
}

interface HeartbeatOptions {
  logger: Logger;
  isStopped: () => boolean;
  onLost: () => void;
}

/** Rewrites the lock heartbeat every lease/6 seconds until the service stops. */
function startHeartbeat(
  lock: LedgerLock,
  leaseSeconds: number,
  schedule: Schedule,
  opts: HeartbeatOptions,
): void {
  const intervalMs = heartbeatIntervalSeconds(leaseSeconds) * 1000;
  const beat = (): void => {
    if (opts.isStopped()) return;
    try {
      lock.heartbeat();
    } catch (err) {
      if (err instanceof LockLostError) {
        opts.logger.error("state lock lost, stopping", { error: err.message });
        opts.onLost();
        return;
      }
      opts.logger.warn("state lock heartbeat failed", { error: errorReason(err) });
    }
    schedule(beat, intervalMs);
  };
  schedule(beat, intervalMs);
}

export interface CliDeps {
  /** Where output lines go; defaults to stdout. */
  write?: (line: string) => void;
  /** Where errors go; defaults to stderr. */
  writeError?: (line: string) => void;
  lock?: Partial<LockEnv>;
  now?: () => number;
}

/**
 * Runs `pulse-notify failed ...` on the state file under its lock and returns the exit code:
 * 0 done, 1 refused or bad request, 2 state file in use or unusable. Starts no service.
 */
export async function runCli(
  args: string[],
  env: Env = process.env,
  deps: CliDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line));
  const statePath = readString(env, "PULSE_NOTIFY_STATE") ?? "./notify-state.json";
  let lock: LedgerLock | undefined;
  let ledger: Ledger | undefined;
  try {
    lock = acquireLock(statePath, lockDeps(deps.lock, loadLockLeaseSeconds(env)));
    ledger = openLedger(statePath, deps.now ? { now: deps.now } : {});
    const result = runFailed(args, ledger);
    await ledger.flush();
    for (const line of result.lines) write(`${line}\n`);
    return result.code;
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof StartupError)) throw err;
    writeError(`pulse-notify: ${err.message}\n`);
    return 2;
  } finally {
    ledger?.close();
    lock?.release();
  }
}

export interface RunDeps {
  /** Signals, exit and stderr; defaults to the real process. */
  proc?: Parameters<typeof runService>[0]["proc"];
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  main?: MainDeps;
}

/** A level that does not parse is reported by `loadSettings`; until then log at info. */
function startupLogLevel(env: Env): LogLevel {
  try {
    return readLogLevel(env);
  } catch {
    // The same bad value fails `loadSettings` with a clear startup error.
    return "info";
  }
}

/** Starts the service under `runService`: signals, startup errors and the shutdown bound. */
export function run(env: Env = process.env, deps: RunDeps = {}): Promise<void> {
  const proc = deps.proc ?? process;
  const write = deps.main?.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger = createLogger({
    level: startupLogLevel(env),
    write: (_level, line) => write(line),
  });
  let running: Running | undefined;
  return runService({
    service: "notify",
    log: logger,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    proc: {
      on: (signal, fn) => proc.on(signal, fn),
      stderr: proc.stderr,
      exit: (code) => {
        // The lock is a lease; free it when the stop ran out of time.
        running?.releaseLock();
        proc.exit(code);
      },
    },
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
    start: async () => {
      try {
        running = main(env, {
          ...deps.main,
          logger,
          exit: deps.main?.exit ?? ((code) => proc.exit(code)),
        });
        await running.listening;
      } catch (err) {
        if (err instanceof ConfigError) throw new StartupError(err.message, { cause: err });
        throw err;
      }
    },
    stop: async () => {
      await running?.stop();
    },
  });
}

/**
 * Runs `pulse-notify subscribers delete <address>` (D18) under the store lock and returns the
 * exit code: 0 done, 1 bad arguments or address, 2 store in use or unusable.
 */
export function runSubscribersCli(
  args: string[],
  env: Env = process.env,
  deps: CliDeps = {},
): number {
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line));
  let result: ReturnType<typeof runSubscribers>;
  try {
    result = runSubscribers(args, {
      storePath: subscriptionStorePath(env),
      lock: lockDeps(deps.lock, loadLockLeaseSeconds(env)),
    });
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof StartupError)) throw err;
    writeError(`pulse-notify: ${err.message}\n`);
    return 2;
  }
  const out = result.code === 0 ? write : writeError;
  for (const line of result.lines) out(`${line}\n`);
  return result.code;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "failed") {
      process.exitCode = await runCli(process.argv.slice(3));
    } else if (process.argv[2] === "subscribers") {
      process.exitCode = runSubscribersCli(process.argv.slice(3));
    } else {
      await run();
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StartupError) {
      process.stderr.write(`pulse-notify: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
