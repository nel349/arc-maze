import { expect, test } from "bun:test";
import { payOut, withhold, WHY, type Rewarding } from "../src/reward.ts";
import { runsInMemory, type Runs } from "../src/storage.ts";
import { digest, finish, move, moved, published, round, RunStore, type Run } from "../src/maze/index.ts";
import { NO_BADGE, type Registrar, type Scribe } from "../src/arc/index.ts";

/**
 * What a solve earns, part by part.
 *
 * The chain is not reached here: the scribe and the registrar are the two things that write to it,
 * and each is replaced by one that records what it was asked and answers the way the real one can,
 * including failing. What is checked is what this module does around them, which is where the bug
 * that lost the reward on 10 September was.
 */

const ROUND = "2026-09-07T05";
const PUBLIC = "https://maze.test";
const HOLDER = "0xc3BB7bc7E375f7ffA34E652F560Dc802F7A76cFa";

/** A run that really walks the round's shortest route, as the router walks it. */
function solved(agentId: bigint | null = 892655n, roundId = ROUND): Run {
  const run = new RunStore().start({
    roundId, payer: "0x1111111111111111111111111111111111111111",
    ...(agentId === null ? {} : { agentId }),
  });
  for (const direction of round(roundId).optimalRoute) {
    run.at = moved(run.at.x, run.at.y, direction);
    move(run, direction, true);
  }
  return finish(run, "solved");
}

function scribeThat(answers: "writes" | "fails") {
  const asked: { readonly agentId: bigint; readonly url: string; readonly digest: string }[] = [];
  const scribe: Scribe = {
    write: async (agentId, _record, url, hash) => {
      asked.push({ agentId, url, digest: hash });
      if (answers === "fails") throw new Error("the RPC is having a bad minute");
      return { agentId, value: 100, hash: "0xfeed" };
    },
  };
  return { scribe, asked };
}

function registrarThat(answers: "admits" | "is-full" | "holds-one" | "fails") {
  const asked: bigint[] = [];
  const registrar: Registrar = {
    admit: async (agentId) => {
      asked.push(agentId);
      if (answers === "fails") throw new Error("the admitter is out of gas");
      if (answers === "is-full") return NO_BADGE.full;
      if (answers === "holds-one") return NO_BADGE.held;
      return { holder: HOLDER, tokenId: 1n, hash: "0xbadge" };
    },
  };
  return { registrar, asked };
}

/** The memory store, recording which way each reservation went. */
function watchedRuns() {
  const inner = runsInMemory();
  const calls: string[] = [];
  const runs: Runs = {
    ...inner,
    settleReward: async (agentId, roundId) => {
      calls.push(`settle ${agentId}@${roundId}`);
      await inner.settleReward(agentId, roundId);
    },
    releaseReward: async (agentId, roundId) => {
      calls.push(`release ${agentId}@${roundId}`);
      await inner.releaseReward(agentId, roundId);
    },
  };
  return { runs, calls };
}

const using = (runs: Runs, parts: { scribe?: Scribe; registrar?: Registrar }): Rewarding => ({
  runs, publicUrl: PUBLIC,
  ...(parts.scribe === undefined ? {} : { scribe: parts.scribe }),
  ...(parts.registrar === undefined ? {} : { registrar: parts.registrar }),
});

test("a solve with an identity is written and admitted, and the answer says what it earned", async () => {
  const run = solved();
  const { scribe, asked } = scribeThat("writes");
  const { registrar } = registrarThat("admits");

  const reward = await payOut(run, using(runsInMemory(), { scribe, registrar }));

  expect(reward.reputation).toEqual({ status: "given", score: 100, tx: "0xfeed" });
  expect(reward.badge).toEqual({ status: "given", number: "1", holder: HOLDER, tx: "0xbadge" });
  // The record on chain quotes the run's public address and commits to exactly this record.
  expect(asked).toEqual([{ agentId: 892655n, url: `${PUBLIC}/run/${run.id}`, digest: digest(published(run)) }]);
});

test("without an identity nothing is written, and the reason is given", async () => {
  const { scribe, asked } = scribeThat("writes");
  const reward = await payOut(solved(null), using(runsInMemory(), { scribe }));
  expect(reward).toEqual({
    reputation: { status: "none", why: WHY.noIdentity },
    badge: { status: "none", why: WHY.noIdentity },
  });
  expect(asked).toEqual([]);
});

/**
 * The server has always said an agent that earns a badge should get one whether or not the
 * deployment can sign feedback. The old payout returned early without a reputation key, so it minted
 * nothing either.
 */
test("a badge does not depend on the reputation key", async () => {
  const { registrar, asked } = registrarThat("admits");
  const reward = await payOut(solved(), using(runsInMemory(), { registrar }));
  expect(reward.reputation).toEqual({ status: "none", why: WHY.notWriting });
  expect(reward.badge.status).toBe("given");
  expect(asked).toEqual([892655n]);
});

test("one reward per agent per round, and a new round is a new chance", async () => {
  const runs = runsInMemory();
  const { scribe, asked } = scribeThat("writes");

  expect((await payOut(solved(), using(runs, { scribe }))).reputation.status).toBe("given");
  expect(await payOut(solved(), using(runs, { scribe }))).toEqual({
    reputation: { status: "none", why: WHY.already },
    badge: { status: "none", why: WHY.already },
  });
  expect((await payOut(solved(892655n, "2026-09-07T06"), using(runs, { scribe }))).reputation.status).toBe("given");
  expect(asked).toHaveLength(2);
});

test("a reputation write that fails is reported, and the next solve in the round can try again", async () => {
  const runs = runsInMemory();
  const failing = scribeThat("fails");
  const { registrar } = registrarThat("admits");

  const first = await payOut(solved(), using(runs, { scribe: failing.scribe, registrar }));
  expect(first.reputation).toEqual({ status: "failed", why: WHY.reputationFailed });
  // Each part answers for itself: the badge went through regardless.
  expect(first.badge.status).toBe("given");

  const working = scribeThat("writes");
  const second = await payOut(solved(), using(runs, { scribe: working.scribe }));
  expect(second.reputation.status).toBe("given");
});

test("a full cohort is an answer, not a failure", async () => {
  const { scribe } = scribeThat("writes");
  const { registrar } = registrarThat("is-full");
  const reward = await payOut(solved(), using(runsInMemory(), { scribe, registrar }));
  expect(reward.badge).toEqual({ status: "none", why: WHY.cohortFull });
  expect(reward.reputation.status).toBe("given");
});

test("an owner who already holds a badge is told that, not that the cohort is full", async () => {
  const { scribe } = scribeThat("writes");
  const { registrar } = registrarThat("holds-one");
  const reward = await payOut(solved(), using(runsInMemory(), { scribe, registrar }));
  expect(reward.badge).toEqual({ status: "none", why: WHY.alreadyHolds });
  expect(reward.reputation.status).toBe("given");
});

/**
 * The solving step's answer said what was earned, once. It is also kept beside the run, so the run's
 * page and a later look at the run can say it after that answer has gone.
 */
test("what a solve earned is kept beside the run", async () => {
  const runs = runsInMemory();
  const run = solved();
  const { scribe } = scribeThat("writes");
  const { registrar } = registrarThat("admits");

  const reward = await payOut(run, using(runs, { scribe, registrar }));
  expect(await runs.reward(run.id)).toEqual(reward);
  expect(await runs.reward(solved().id)).toBeNull();
});

/**
 * The reservation is taken for a while and then either kept or handed back. Kept for good once a
 * reputation is written, since a second record in the round must never be; handed back when the write
 * failed, so a later solve can try again.
 */
/**
 * The store refusing to keep a written reward taken is the one failure that costs something real:
 * the reservation is on a lease, so a settle that never lands lets it lapse and a later solve writes
 * a second record. It is tried again, and the record already written is still reported as given.
 */
test("a reward that cannot be kept taken is tried again, and what was written is still reported", async () => {
  const inner = runsInMemory();
  let asked = 0;
  const runs: Runs = {
    ...inner,
    settleReward: async () => {
      asked += 1;
      throw new Error("the store is having a bad minute");
    },
  };

  const reward = await payOut(solved(), using(runs, { scribe: scribeThat("writes").scribe }));
  // A record that was written must not be reported as failed: it exists on chain either way.
  expect(reward.reputation.status).toBe("given");
  expect(asked).toBeGreaterThan(1);
});

test("a written reputation keeps the round's reward taken for good, and a failed one hands it back", async () => {
  const written = watchedRuns();
  await payOut(solved(), using(written.runs, { scribe: scribeThat("writes").scribe }));
  expect(written.calls).toEqual([`settle 892655@${ROUND}`]);

  const failed = watchedRuns();
  await payOut(solved(), using(failed.runs, { scribe: scribeThat("fails").scribe }));
  expect(failed.calls).toEqual([`release 892655@${ROUND}`]);
});

test("a solve whose identity could not be checked pays nothing, says why, and keeps that", async () => {
  const runs = runsInMemory();
  const run = solved();
  const { scribe, asked } = scribeThat("writes");

  const reward = await withhold(run, using(runs, { scribe }));
  expect(reward).toEqual({
    reputation: { status: "failed", why: WHY.unconfirmed },
    badge: { status: "failed", why: WHY.unconfirmed },
  });
  expect(await runs.reward(run.id)).toEqual(reward);
  expect(asked).toEqual([]);
  // Nothing was reserved, so the solve can still be paid out once Arc answers.
  expect(await runs.reserveReward(892655n, ROUND, run.id)).toBe(true);
});

test("a badge that fails to mint is reported, and a written reputation is not written twice", async () => {
  const runs = runsInMemory();
  const { scribe, asked } = scribeThat("writes");
  const { registrar } = registrarThat("fails");

  const reward = await payOut(solved(), using(runs, { scribe, registrar }));
  expect(reward.badge).toEqual({ status: "failed", why: WHY.badgeFailed });
  expect(reward.reputation.status).toBe("given");

  // The reservation is kept, because a reputation was written: a second solve must not add another.
  expect((await payOut(solved(), using(runs, { scribe, registrar }))).reputation.status).toBe("none");
  expect(asked).toHaveLength(1);
});

test("a store that cannot reserve the reward pays out nothing, and says why", async () => {
  const runs: Runs = {
    ...runsInMemory(),
    reserveReward: async () => { throw new Error("the store is having a bad minute"); },
  };
  const { scribe, asked } = scribeThat("writes");
  const reward = await payOut(solved(), using(runs, { scribe }));
  expect(reward).toEqual({
    reputation: { status: "failed", why: WHY.unreserved },
    badge: { status: "failed", why: WHY.unreserved },
  });
  expect(asked).toEqual([]);
});

test("a run that has not solved has earned nothing, and asking is a mistake", async () => {
  const run = new RunStore().start({ roundId: ROUND, agentId: 892655n });
  const { scribe } = scribeThat("writes");
  await expect(payOut(run, using(runsInMemory(), { scribe }))).rejects.toThrow(/has not solved/);
});
