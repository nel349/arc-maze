import {
  claim as claimRun, newRun, published, revive, summaryOf,
  type PublishedRun, type RoundId, type Run, type RunSummary,
} from "./maze/index.ts";
import type { Runs } from "./storage.ts";

/**
 * The shared store: every run, kept where every copy of the server can reach it.
 *
 * It began as an archive for one kind of run, a solve that earned reputation, because that is the
 * one whose address is quoted on chain. Every other run lived in the memory of whichever copy of the
 * server started it, and the board page said it would forget. On a host that runs several copies and
 * recycles them, that was not forgetting but disagreeing: a run could be unknown to the copy that took
 * its next payment, and each copy drew its own board. So every run is kept here from its first call,
 * and every page reads from here.
 *
 * **One key per run, and it is the evidence.** `run:<id>` holds the published record: the record
 * `/run/:id` serves, and the key the verdict workflow reads. A live run is rebuilt from it by
 * replaying the maze (`revive`), so there is no second shape to keep true. Boards and the list of
 * runs read a short summary of each, kept beside it, so they never fetch every action ever bought.
 *
 * **A run nobody pays for expires.** Starting one is free, so it is written with an expiry, and its
 * first paid action makes it permanent.
 */

/**
 * How long an unpaid run is kept.
 *
 * A run can be started only in the open hour, and nothing stops its first payment arriving after the
 * hour turns. Two hours covers the hour it was started in and one more to begin paying.
 */
const UNPAID_RUN_TTL_S = 2 * 60 * 60;

/**
 * How long a payer's claims in a round are counted.
 *
 * They bound one payer's share of a board, and a round's runs can only be claimed while one of them
 * is still unpaid: at most the round's hour plus the expiry above. A day is comfortably past that.
 */
const CLAIMS_TTL_S = 24 * 60 * 60;

/**
 * How long one paid action may hold its run.
 *
 * Longer than any step takes, including a solve, which waits for two transactions before it answers.
 * Short enough that a copy of the server that dies mid-step does not lock its run for long.
 */
const HOLD_MS = 60_000;

/**
 * The one call this makes on the outside world.
 *
 * Narrower than `typeof fetch` on purpose: that type carries whatever else the runtime hangs off the
 * global (Bun adds `preconnect`), and a seam should ask for what it uses. `fetch` satisfies this; so
 * does a function written in four lines by a test.
 */
export type Send = (url: string, init?: RequestInit) => Promise<Response>;

/** A command as Redis spells it: the name, then its arguments in order. */
export type Command = readonly (string | number)[];

/**
 * Upstash Redis over its REST API, which is chosen for two properties rather than for Redis.
 *
 * It speaks HTTP, so there is no connection to pool or leak from somewhere that may be a fresh
 * instance on every request. And it needs no client library: every command here is a JSON array in a
 * POST body, which also keeps keys and values out of the URL, where they would reach logs.
 */
export interface Upstash {
  /** One command, and its result. */
  command(command: Command): Promise<unknown>;
  /** Several commands with nothing else run between them, and each one's result, in order. */
  transaction(commands: readonly Command[]): Promise<readonly unknown[]>;
}

/** What Upstash answers with: a result, or an error, and the error can arrive with a 200. */
interface Reply {
  readonly result?: unknown;
  readonly error?: string;
}

const isReply = (value: unknown): value is Reply =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function upstash(
  endpoint: string,
  token: string,
  /**
   * Injected so this can be tested without a socket: a test that has to bind a port fails on a busy
   * machine and leaves a listener behind when it crashes.
   */
  send: Send = fetch,
): Upstash {
  const base = endpoint.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  /** Failures are named by their commands, never their values: a value can be a whole record. */
  const named = (commands: readonly Command[]): string =>
    `upstash ${commands.map((command) => String(command[0])).join(", ")}`;

  /**
   * A failure is a failure however it arrives.
   *
   * Upstash reports a bad command as `{"error": …}`, and does so with a 200, so a status check alone
   * would read it as success: a run believed stored when it is not. A transaction refused before it
   * ran arrives as a 400 carrying the same shape, so the body is read before the status is judged.
   */
  const post = async (path: string, body: Command | readonly Command[], what: string): Promise<unknown> => {
    const response = await send(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isReply(parsed) && parsed.error !== undefined) throw new Error(`${what}: ${parsed.error}`);
    if (!response.ok) throw new Error(`${what}: ${response.status} ${response.statusText}`);
    if (parsed === undefined) throw new Error(`${what}: the answer was not JSON`);
    return parsed;
  };

  return {
    async command(command) {
      const what = named([command]);
      const reply = await post("", command, what);
      if (!isReply(reply)) throw new Error(`${what}: the answer was not a reply`);
      // A key that was never written comes back as a null result rather than as an error.
      return reply.result ?? null;
    },

    async transaction(commands) {
      const what = named(commands);
      const replies = await post("/multi-exec", commands, what);
      if (!Array.isArray(replies) || replies.length !== commands.length) {
        throw new Error(`${what}: expected one answer per command`);
      }
      // A command that fails while the transaction runs does not stop the others, and says so only
      // in its own answer. Any one of them failing is the whole thing failing.
      return replies.map((reply: unknown, index) => {
        if (!isReply(reply)) throw new Error(`${what}: answer ${index + 1} was not a reply`);
        if (reply.error !== undefined) {
          throw new Error(`${what}: ${String(commands[index]?.[0])} failed: ${reply.error}`);
        }
        return reply.result ?? null;
      });
    },
  };
}

/** A hash read back as its values, which are the summaries this module wrote. */
function summaries(flat: unknown, what: string): RunSummary[] {
  // HGETALL answers field, value, field, value; the fields are run ids and each summary has its own.
  if (!Array.isArray(flat)) throw new Error(`${what}: expected fields and values`);
  const found: RunSummary[] = [];
  for (let index = 1; index < flat.length; index += 2) {
    const value: unknown = flat[index];
    if (typeof value !== "string") throw new Error(`${what}: a summary that is not text`);
    found.push(JSON.parse(value) as RunSummary);
  }
  return found;
}

/**
 * Where each thing lives, named once for the server and for the scripts that maintain the store.
 *
 * `prefix` goes in front of every key. It is empty in production, where `run:<id>` is also the key
 * the verdict workflow reads, and a fresh one in the test that runs against the real store, so what
 * that test writes can be found and removed.
 */
export function storeKeys(prefix = "") {
  return {
    /** The published record. */
    run: (id: string) => `${prefix}run:${id}`,
    /** Taken for the length of one paid action. */
    hold: (id: string) => `${prefix}hold:${id}`,
    /** The runs one payer has claimed in a round. */
    claims: (roundId: RoundId, payer: string) => `${prefix}claims:${roundId}:${payer}`,
    /** A round's runs, as summaries by run id. */
    round: (roundId: RoundId) => `${prefix}round:${roundId}`,
    /** Every run, as summaries by run id. */
    every: `${prefix}runs`,
    /** The run that took an agent's one reward in a round. */
    reward: (agentId: bigint, roundId: RoundId) => `${prefix}reward:${agentId}@${roundId}`,
  } as const;
}

/** Runs in the shared store, under the keys above. */
export function runsInUpstash(db: Upstash, prefix = ""): Runs {
  const key = storeKeys(prefix);
  const record = (run: Run): string => JSON.stringify(published(run));

  return {
    async start(input) {
      const run = newRun(input);
      await db.command(["SET", key.run(run.id), record(run), "EX", UNPAID_RUN_TTL_S]);
      return run;
    },

    async get(id) {
      const stored = await db.command(["GET", key.run(id)]);
      if (stored === null) return null;
      if (typeof stored !== "string") throw new Error(`run ${id} is stored as something other than a record`);
      return revive(JSON.parse(stored) as PublishedRun);
    },

    async hold(id) {
      return (await db.command(["SET", key.hold(id), "1", "NX", "PX", HOLD_MS])) === "OK";
    },

    async release(id) {
      await db.command(["DEL", key.hold(id)]);
    },

    async claim(run, payer) {
      const first = run.payer === null;
      if (!claimRun(run, payer).ok) return { ok: false };
      const claims = key.claims(run.roundId, payer.toLowerCase());
      const answers = await db.transaction([
        // Written before the agent is charged, which is when a claim has always taken effect. It
        // keeps its expiry: a run with a payer and nothing bought is still a run nobody paid for.
        ...(first ? [["SET", key.run(run.id), record(run), "KEEPTTL"]] : []),
        ["SADD", claims, run.id],
        ["EXPIRE", claims, CLAIMS_TTL_S],
        ["SCARD", claims],
      ]);
      return { ok: true, runsThisRound: Number(answers.at(-1)) };
    },

    async save(run) {
      const summary = JSON.stringify(summaryOf(run));
      await db.transaction([
        // A plain SET, which also lifts the expiry: from its first paid action a run is kept for good.
        ["SET", key.run(run.id), record(run)],
        ["HSET", key.round(run.roundId), run.id, summary],
        ["HSET", key.every, run.id, summary],
      ]);
    },

    async inRound(roundId) {
      return summaries(await db.command(["HGETALL", key.round(roundId)]), `round ${roundId}`);
    },

    /**
     * Every run's summary, in one read.
     *
     * About a quarter of a kilobyte each, so ten thousand runs is a few megabytes in one answer. Past
     * that this wants pages; it is said here rather than found out.
     */
    async every() {
      return summaries(await db.command(["HGETALL", key.every]), "every run");
    },

    async reserveReward(agentId, roundId, runId) {
      return (await db.command(["SET", key.reward(agentId, roundId), runId, "NX"])) === "OK";
    },

    async releaseReward(agentId, roundId) {
      await db.command(["DEL", key.reward(agentId, roundId)]);
    },
  };
}
