import type { ResendCommand } from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import { errorFields } from "./errors.ts";
import type { Ledger, ResendCommandRow, ResendCommandState } from "./ledger.ts";

/** Most result posts per poll (Decision 14). */
export const RESEND_POST_MAX = 20;

/**
 * The api's answer to one result post: `acknowledged` for `204`, `refused` for `404` or `409`
 * (never posted again), `retry` for a timeout, a network error or any other status.
 */
export type PostOutcome = "acknowledged" | "refused" | "retry";

export interface ResendCommandDeps {
  ledger: Ledger;
  /** Claims up to 20 queued commands; throws on any failure. */
  claim: () => Promise<readonly ResendCommand[]>;
  postResult: (id: string, state: ResendCommandState) => Promise<PostOutcome>;
  isInstalled: (channelId: string) => boolean;
  /** Hands an admitted key to the running worker, after the admission committed. */
  enqueue: (channelId: string, key: string) => void;
  logger: Logger;
}

/**
 * One command poll: claim, admit each unseen command in one ledger transaction, then post the
 * oldest results the api has not acknowledged. Never rejects.
 */
export async function pollResendCommands(deps: ResendCommandDeps): Promise<void> {
  const repost = new Set<string>();
  let commands: readonly ResendCommand[] = [];
  try {
    commands = await deps.claim();
  } catch (err) {
    deps.logger.warn("resend claim failed, the next poll retries", errorFields(err));
  }
  for (const command of commands) admitCommand(deps, command, repost);
  await postResults(deps, repost);
}

function admitCommand(deps: ResendCommandDeps, command: ResendCommand, repost: Set<string>): void {
  const { ledger, logger } = deps;
  let handled: { row: ResendCommandRow; isNew: boolean };
  try {
    handled = ledger.admitResendCommand(command, deps.isInstalled(command.channelId));
  } catch (err) {
    // Nothing was written; the api requeues the claim after its timeout.
    logger.error("resend admission failed", { command: command.id, ...errorFields(err) });
    return;
  }
  // The api claimed it again, so it lost our answer: post the stored state once more.
  if (!handled.isNew) {
    repost.add(command.id);
    return;
  }
  logger.info("resend command admitted", {
    command: command.id,
    channel: command.channelId,
    state: handled.row.state,
  });
  if (handled.row.state === "admitted") deps.enqueue(command.channelId, command.key);
}

async function postResults(deps: ResendCommandDeps, repost: ReadonlySet<string>): Promise<void> {
  const { ledger, logger } = deps;
  const due = ledger
    .resendCommands()
    .filter((r) => r.postedState !== r.state || repost.has(r.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, RESEND_POST_MAX);
  for (const row of due) {
    let outcome: PostOutcome;
    try {
      outcome = await deps.postResult(row.id, row.state);
    } catch (err) {
      logger.warn("resend result post failed, the next poll retries", {
        command: row.id,
        ...errorFields(err),
      });
      continue;
    }
    if (outcome === "retry") continue;
    if (outcome === "refused") {
      logger.warn("resend result refused by the api", {
        command: row.id,
        state: row.state,
        postedState: row.postedState ?? null,
      });
    }
    try {
      ledger.markResendPosted(row.id, row.state);
    } catch (err) {
      logger.error("ledger write failed, the next poll posts again", {
        command: row.id,
        ...errorFields(err),
      });
    }
  }
}

export interface ResendLoop {
  start(): void;
  /** Cancels the next poll and waits for the poll in flight. */
  stop(): Promise<void>;
}

/** Runs `pollResendCommands` every `intervalMs`, the first one at once. */
export function startResendLoop(
  deps: ResendCommandDeps,
  intervalMs: number,
  schedule: (fn: () => void, ms: number) => () => void,
): ResendLoop {
  let isRunning = false;
  let cancel: (() => void) | undefined;
  let running: Promise<void> | undefined;
  const next = (ms: number): void => {
    if (!isRunning) return;
    cancel = schedule(() => {
      running = pollResendCommands(deps).finally(() => {
        running = undefined;
        next(intervalMs);
      });
    }, ms);
  };
  return {
    start: () => {
      if (isRunning) return;
      isRunning = true;
      next(0);
    },
    stop: async () => {
      isRunning = false;
      cancel?.();
      await running;
    },
  };
}
