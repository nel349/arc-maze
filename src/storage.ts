import {
  claim as claimRun, published, RunStore, summaryOf,
  type PublishedRun, type RoundId, type Run, type RunSummary,
} from "./maze/index.ts";
import type { Reward } from "./reward.ts";

/**
 * Where runs are kept, so that whichever copy of the server answers, it is the same run.
 *
 * The maze runs on a host that starts several copies of the server and recycles them. With every run
 * held in the memory of the copy that started it, a run could be "no such run" on the next copy after
 * the agent had paid; a round's board showed only the runs one copy had seen; and "all time" meant
 * "since this copy started". The pages could not say so, because they could not know.
 *
 * So there are two of these with one contract. In memory, below, for a laptop and for the tests,
 * where one process is the whole world. And the shared store in `archive.ts`, which every copy reads
 * and writes, for a hostname.
 *
 * **One paid action at a time per run.** `hold` is taken before the agent is charged and released
 * once the run is written back. Two steps on one run at once used to both be charged and both be
 * applied, and the second could land after the run had already solved. Now the second is refused
 * before it pays.
 *
 * **Only runs that have bought something are listed.** Starting a run is free, so a list including
 * the unpaid ones could be filled by anybody for nothing, and a run nobody paid for was never played.
 */
export interface Runs {
  /** A new run in a round. Nobody has paid yet, so it has no payer. */
  start(input: { readonly roundId: RoundId; readonly agentId?: bigint }): Promise<Run>;
  get(id: string): Promise<Run | null>;
  /**
   * The run's published record exactly as it was kept, or null.
   *
   * Not the run brought back and published again: a record kept before a field existed would gain
   * it, and its digest would change. The reputation on chain commits to the kept contents, so those
   * are what a reader is handed.
   */
  record(id: string): Promise<PublishedRun | null>;
  /** Take the run for one paid action. False when another action on it is still being paid for. */
  hold(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
  /** Bind the run to whoever is paying, the first time, and count this payer's runs in the round. */
  claim(run: Run, payer: string): Promise<Claimed>;
  /** Write the run back after a paid action. From here it is on the boards and the list of runs. */
  save(run: Run): Promise<void>;
  /** The runs of one round that have bought something. */
  inRound(roundId: RoundId): Promise<readonly RunSummary[]>;
  /** Every run that has bought something, in any round. */
  every(): Promise<readonly RunSummary[]>;
  /**
   * Take the one reward an agent may earn in a round. False when it is already taken.
   *
   * Taken for a while at first, so a copy of the server that stops mid-payout does not keep the agent
   * out of its round for good, and for good once `settleReward` says a reputation was written.
   */
  reserveReward(agentId: bigint, roundId: RoundId, runId: string): Promise<boolean>;
  /** Keep the reward taken for good: a reputation was written, and a second must never be. */
  settleReward(agentId: bigint, roundId: RoundId): Promise<void>;
  /** Give it back after a reward that did not go through, so a later solve can try again. */
  releaseReward(agentId: bigint, roundId: RoundId): Promise<void>;
  /**
   * What a solve earned, kept beside its run.
   *
   * Not in the run's record: the reputation on chain commits to that record's digest, so nothing may
   * be added to it afterwards. Kept so the run's page and `GET /game/:id` can say what was earned
   * after the one answer that said it has gone, or never arrived.
   */
  keepReward(runId: string, reward: Reward): Promise<void>;
  /** What a run earned, or null when nothing was kept for it. */
  reward(runId: string): Promise<Reward | null>;
}

/**
 * Whose run it is, and how many this payer holds in the round.
 *
 * The count only exists when the run is the payer's: for somebody else's run there is nothing to
 * count, and a zero there would read as a fact.
 */
export type Claimed =
  | { readonly ok: false }
  /** `runsThisRound` counts this run too. */
  | { readonly ok: true; readonly runsThisRound: number };

/** How many rewards a laptop remembers. The oldest are for rounds long closed, which nobody can enter. */
const REWARDS_KEPT = 500;

/** How long a reward stays taken while it is paid out, matching the shared store's lease. */
const PAYOUT_LEASE_MS = 10 * 60 * 1000;

const rewardKey = (agentId: bigint, roundId: RoundId): string => `${agentId}@${roundId}`;

const bought = (run: Run): boolean => run.actions.length > 0;

/**
 * One process is the whole world.
 *
 * The run handed out is the stored object itself, so an action applied to it is already stored and
 * `save` has nothing to do. `RunStore` keeps its own bound and eviction order.
 */
export function runsInMemory(store: RunStore = new RunStore()): Runs {
  const holding = new Set<string>();
  /** When each reward was taken, so a lease can lapse. Emptied by the bound below, oldest first. */
  const rewarded = new Map<string, number>();
  /** The rewards kept for good: a reputation was written, and a second must never be. */
  const settled = new Set<string>();
  const earned = new Map<string, Reward>();

  return {
    start: async (input) => store.start(input),
    get: async (id) => store.get(id) ?? null,
    record: async (id) => {
      const run = store.get(id);
      return run === undefined ? null : published(run);
    },
    hold: async (id) => {
      if (holding.has(id)) return false;
      holding.add(id);
      return true;
    },
    release: async (id) => {
      holding.delete(id);
    },
    claim: async (run, payer) => claimRun(run, payer).ok
      ? { ok: true, runsThisRound: store.countFor(run.roundId, payer) }
      : { ok: false },
    save: async () => {
      // Already stored: see above.
    },
    inRound: async (roundId) => store.forRound(roundId).filter(bought).map(summaryOf),
    every: async () => store.all().filter(bought).map(summaryOf),
    reserveReward: async (agentId, roundId) => {
      const key = rewardKey(agentId, roundId);
      // Taken for a while, and for good once settled: a reservation whose payout stopped halfway
      // lapses, exactly as it does in the shared store, so a later solve can try again.
      const taken = rewarded.get(key);
      if (taken !== undefined && (settled.has(key) || Date.now() - taken < PAYOUT_LEASE_MS)) return false;
      rewarded.set(key, Date.now());
      // By key, oldest first: a Map keeps insertion order, and the mark of being kept goes with it.
      if (rewarded.size > REWARDS_KEPT) {
        const oldest = rewarded.keys().next();
        if (!oldest.done) {
          rewarded.delete(oldest.value);
          settled.delete(oldest.value);
        }
      }
      return true;
    },
    settleReward: async (agentId, roundId) => {
      // A real lease here too, so "taken for a while, then kept for good" is exercised by the suite
      // that runs everywhere rather than only against the shared store.
      settled.add(rewardKey(agentId, roundId));
    },
    releaseReward: async (agentId, roundId) => {
      const key = rewardKey(agentId, roundId);
      rewarded.delete(key);
      // Handed back means handed back: a reward kept for good is never released, and one that was
      // released must not keep a mark saying it was kept.
      settled.delete(key);
    },
    keepReward: async (runId, reward) => {
      earned.set(runId, reward);
      if (earned.size > REWARDS_KEPT) {
        const oldest = earned.keys().next();
        if (!oldest.done) earned.delete(oldest.value);
      }
    },
    reward: async (runId) => earned.get(runId) ?? null,
  };
}
