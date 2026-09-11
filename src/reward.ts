import { digest, published, type Run } from "./maze/index.ts";
import { NO_BADGE, type Registrar, type Scribe } from "./arc/index.ts";
import type { Runs } from "./storage.ts";
import { runHref } from "./paths.ts";

/**
 * What a solve earns, paid out before the solving step answers.
 *
 * It used to start after the answer and was not waited for, so an agent would not sit through a
 * transaction it had not asked for. On a host that stops the function once it has answered, that
 * meant it never ran: on 10 September a solve on the public maze wrote no reputation and minted no
 * badge, and nothing said so. Now the last step takes a few seconds longer, and its answer says what
 * was earned, so the agent can tell its owner rather than report a win and nothing more.
 *
 * Two parts, and each answers for itself. The reputation record is what a machine reads; the badge is
 * the half a person screenshots. Either can be missing for an ordinary reason, or fail, without
 * touching the other.
 */

export type Part<Given> =
  | ({ readonly status: "given" } & Given)
  | { readonly status: "none"; readonly why: string }
  | { readonly status: "failed"; readonly why: string };

export interface Reward {
  readonly reputation: Part<{ readonly score: number; readonly tx: string }>;
  readonly badge: Part<{ readonly number: string; readonly holder: string; readonly tx: string }>;
}

/** Said to the agent, which says it to a person, so in words rather than codes. */
export const WHY = {
  noIdentity: "No ERC-8004 identity was declared for this run, or it does not belong to the wallet that paid.",
  notWriting: "This maze is not writing reputation right now.",
  notMinting: "This maze is not minting badges right now.",
  already: "This agent was already rewarded in this round. One reward per agent per round.",
  cohortFull: "No badge: every place in the cohort is taken.",
  alreadyHolds: "No badge: the identity's owner already holds one. One per holder.",
  unconfirmed: "Arc did not answer whether this identity belongs to the wallet that paid, so nothing " +
    "was written yet. The run is kept, so it can be paid out once Arc answers.",
  reputationFailed: "The reputation record was not written. The run is kept, so it can be written again.",
  badgeFailed: "The badge was not minted. The run is kept, so it can be admitted again.",
  unreserved: "The reward could not be reserved just now. The run is kept, so it can be paid out again.",
} as const;

export interface Rewarding {
  readonly runs: Runs;
  /** Absent means this deployment writes no reputation. */
  readonly scribe?: Scribe;
  /** Absent means this deployment mints no badges. Independent of the scribe on purpose. */
  readonly registrar?: Registrar;
  /** The public address the reputation record quotes, for ever. */
  readonly publicUrl: string;
}

const none = (why: string) => ({ status: "none", why }) as const;
const failed = (why: string) => ({ status: "failed", why }) as const;

/**
 * Pay out a solved run, once per agent per round.
 *
 * The caller writes the run to the store first and waits for it, because the reputation record
 * quotes the run's address and commits to its digest. A record citing a run nobody can fetch is worse
 * than no record: it reads as evidence and is not.
 */
export async function payOut(run: Run, using: Rewarding): Promise<Reward> {
  if (run.outcome !== "solved") throw new Error(`run ${run.id} has not solved, so it has earned nothing`);
  return kept(run, await decide(run, using), using.runs);
}

/**
 * A solve whose identity could not be checked just now: nothing paid, and said so, so it can be paid
 * out once Arc answers. Paying anyway could write reputation onto a stranger's identity.
 */
export async function withhold(run: Run, using: Rewarding): Promise<Reward> {
  return kept(run, { reputation: failed(WHY.unconfirmed), badge: failed(WHY.unconfirmed) }, using.runs);
}

/** Kept beside the run so its page can say it later. A store that will not keep it costs only that. */
async function kept(run: Run, reward: Reward, runs: Runs): Promise<Reward> {
  await runs.keepReward(run.id, reward).catch((cause: unknown) =>
    console.error(`what run ${run.id} earned could not be kept beside it:`, cause));
  return reward;
}

async function decide(run: Run, using: Rewarding): Promise<Reward> {
  const agentId = run.agentId;
  if (agentId === null) return { reputation: none(WHY.noIdentity), badge: none(WHY.noIdentity) };
  const { runs, scribe, registrar } = using;
  if (scribe === undefined && registrar === undefined) {
    return { reputation: none(WHY.notWriting), badge: none(WHY.notMinting) };
  }

  // One record per agent per round: nothing else stops an agent solving the same maze again and
  // collecting a fresh score each time, and reputation that can be bought in bulk is not reputation.
  // Held in the shared store, so it holds whichever copy of the server the solve lands on.
  let reserved: boolean;
  try {
    reserved = await runs.reserveReward(agentId, run.roundId, run.id);
  } catch (cause) {
    console.error(`the reward for run ${run.id} could not be reserved:`, cause);
    return { reputation: failed(WHY.unreserved), badge: failed(WHY.unreserved) };
  }
  if (!reserved) return { reputation: none(WHY.already), badge: none(WHY.already) };

  const [reputation, badge] = await Promise.all([
    writeReputation(run, agentId, using),
    admitToCohort(run, agentId, registrar),
  ]);

  if (reputation.status === "given") {
    // Written, so the round's reward is taken for good, whatever became of the badge: an agent must
    // never collect two records for one round.
    await runs.settleReward(agentId, run.roundId).catch((cause: unknown) =>
      console.error(`the reward for run ${run.id} was written, but could not be kept taken:`, cause));
  } else if (reputation.status === "failed" || badge.status === "failed") {
    // Handed back, so a later solve in the round can try again.
    await runs.releaseReward(agentId, run.roundId).catch((cause: unknown) =>
      console.error(`the reward for run ${run.id} could not be handed back:`, cause));
  }
  return { reputation, badge };
}

async function writeReputation(run: Run, agentId: bigint, using: Rewarding): Promise<Reward["reputation"]> {
  if (using.scribe === undefined) return none(WHY.notWriting);
  const record = published(run);
  try {
    const written = await using.scribe.write(agentId, record, `${using.publicUrl}${runHref(run.id)}`, digest(record));
    console.log(`reputation: agent ${written.agentId} scored ${written.value}, ${written.hash}`);
    return { status: "given", score: written.value, tx: written.hash };
  } catch (cause) {
    console.error(`reputation for run ${run.id} was not written:`, cause);
    return failed(WHY.reputationFailed);
  }
}

async function admitToCohort(run: Run, agentId: bigint, registrar: Registrar | undefined): Promise<Reward["badge"]> {
  if (registrar === undefined) return none(WHY.notMinting);
  try {
    const admitted = await registrar.admit(agentId);
    // A full cohort and a holder who already has one are ordinary answers, not failures, and each
    // is said as itself.
    if (admitted === NO_BADGE.full) return none(WHY.cohortFull);
    if (admitted === NO_BADGE.held) return none(WHY.alreadyHolds);
    console.log(`cohort: #${admitted.tokenId} to ${admitted.holder}, ${admitted.hash}`);
    return { status: "given", number: String(admitted.tokenId), holder: admitted.holder, tx: admitted.hash };
  } catch (cause) {
    console.error(`badge admission failed for run ${run.id}, agent ${agentId}:`, cause);
    return failed(WHY.badgeFailed);
  }
}
