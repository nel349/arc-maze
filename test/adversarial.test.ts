import { expect, test } from "bun:test";
import { RunStore } from "../src/maze/index.ts";
import { roundIdAt } from "../src/maze/index.ts";
import { routes, RUNS_PER_PAYER_PER_ROUND } from "../src/server.ts";
import { Paywall } from "../src/arc/index.ts";

/**
 * The adversarial pass: what someone trying to break this would do.
 *
 * Each of these was a real defect when written. They are kept because the fixes are the kind that
 * quietly regress — an eviction rule, an ordering, the order of two calls.
 */

const R = roundIdAt();
const SELLER = "0xd5ab9Aa81Fd9c7526333b7B8aAbA3Bc3d9CA105B";
const SIGNATURE = btoa(JSON.stringify({ x402Version: 2, payload: {} }));

function asRoute<P extends string>(path: string, params: Record<string, string>, paying = false): Bun.BunRequest<P> {
  const init = paying ? { method: "POST", headers: { "payment-signature": SIGNATURE } } : { method: "POST" };
  return Object.assign(new Request(`http://maze.test${path}`, init), { params }) as Bun.BunRequest<P>;
}

test("free runs cannot grow the store without bound", () => {
  const store = new RunStore(5);
  for (let i = 0; i < 200; i++) store.start({ roundId: R });
  expect(store.size).toBe(5);
});

test("a stranger paying for someone else's run is not charged for it", async () => {
  let settled = 0;
  const spy = (payer: string) => ({
    verify: async () => ({ isValid: true, payer }),
    settle: async () => { settled += 1; return { success: true, transaction: "b", payer, network: "eip155:5042002" }; },
  });
  const store = new RunStore();
  const owner = routes({ seller: SELLER, runs: store, paywall: new Paywall(spy("0x1111111111111111111111111111111111111111")) });
  const stranger = routes({ seller: SELLER, runs: store, paywall: new Paywall(spy("0x2222222222222222222222222222222222222222")) });

  const created = await owner["/game"].POST(asRoute("/game", {}));
  const id = String((await created.json() as Record<string, unknown>)["run"]);
  await owner["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, true));
  const before = settled;

  const refused = await stranger["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, true));
  expect(refused.status).toBe(403);
  // Taking the money and then refusing is the bug: the stranger gets nothing for it.
  expect(settled).toBe(before);
});

test("a facilitator's internal error is not echoed to the caller", async () => {
  const leaky = {
    verify: async () => { throw new Error("connect ECONNREFUSED https://gateway:hunter2@internal:8080"); },
    settle: async () => ({ success: false, transaction: "", network: "eip155:5042002" }),
  };
  const app = routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(leaky) });
  const created = await app["/game"].POST(asRoute("/game", {}));
  const id = String((await created.json() as Record<string, unknown>)["run"]);
  const response = await app["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, true));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("hunter2");
});

test("a tie is broken by who arrived first, without asking the machine's locale", async () => {
  const { board, finish } = await import("../src/maze/index.ts");
  const store = new RunStore();

  // Identical play: same steps, same money. Only the finish time separates them, which is the
  // one case the tiebreak decides — and the case an earlier version got wrong by reaching for
  // `localeCompare`, which orders differently under different locales.
  const later = store.start({ roundId: R, payer: "0x1111111111111111111111111111111111111111" });
  const earlier = store.start({ roundId: R, payer: "0x2222222222222222222222222222222222222222" });
  finish(later, "solved");
  finish(earlier, "solved");
  later.finishedAt = "2026-09-07T02:00:00.001Z";
  earlier.finishedAt = "2026-09-07T02:00:00.000Z";

  const ranked = board("fewest-steps", [later, earlier], R);
  expect(ranked.entries.map((e) => e.run)).toEqual([earlier.id, later.id]);
  expect(ranked.entries.map((e) => e.rank)).toEqual([1, 2]);
});

test("a solved run that somehow has no finish time sorts last rather than first", async () => {
  const { board, finish } = await import("../src/maze/index.ts");
  const store = new RunStore();

  const timed = store.start({ roundId: R });
  const untimed = store.start({ roundId: R });
  finish(timed, "solved");
  finish(untimed, "solved");
  untimed.finishedAt = null;

  const ranked = board("least-spent", [untimed, timed], R);
  expect(ranked.entries[0]?.run).toBe(timed.id);
});

test("a scribe without a public url is refused, not written to the chain as a relative path", () => {
  const scribe = {
    write: async () => ({ agentId: 1n, value: 0, hash: "0x" as `0x${string}` }),
  };
  expect(() => routes({ seller: SELLER, scribe })).toThrow(/publicUrl is required/);
});

test("two moves in flight at once must not corrupt the run's own audit", async () => {
  const { round: roundOf } = await import("../src/maze/index.ts");
  const { published, verify } = await import("../src/maze/index.ts");
  const store = new RunStore();
  const payer = "0x1111111111111111111111111111111111111111";
  const app = routes({
    seller: SELLER, runs: store,
    paywall: new Paywall({
      // A facilitator that takes a moment, which is what lets two requests interleave.
      verify: async () => { await new Promise((r) => setTimeout(r, 5)); return { isValid: true, payer }; },
      settle: async () => ({ success: true, transaction: "b", payer, network: "eip155:5042002" }),
    }),
  });

  const created = await app["/game"].POST(asRoute("/game", {}));
  const id = String((await created.json() as Record<string, unknown>)["run"]);
  const first = roundOf(R).optimalRoute[0]!;

  // The same legal move, twice, concurrently.
  await Promise.all([
    app["/game/:id/move"].POST(asRoute(`/game/${id}/move?dir=${first}`, { id }, true)),
    app["/game/:id/move"].POST(asRoute(`/game/${id}/move?dir=${first}`, { id }, true)),
  ]);

  const run = store.get(id);
  if (!run) throw new Error("run vanished");
  const result = verify(published(run));
  expect(result.problems).toEqual([]);
});

/**
 * A board is read by a person deciding whether any of this is worth their time, and the one
 * number on it that invites sorting is "how far off perfect". An unfinished run has no route to
 * compare, and computing the arithmetic anyway published -18 for an agent that took no steps —
 * which reads as eighteen better than the shortest route that exists, and puts whoever did the
 * least at the top.
 */
test("a run that never got out reports no distance from perfect, rather than a flattering one", async () => {
  const { board, finish, move, round: roundOf } = await import("../src/maze/index.ts");
  const store = new RunStore();

  const quit = store.start({ roundId: R, payer: "0x1111111111111111111111111111111111111111" });
  finish(quit, "gave-up");

  const solved = store.start({ roundId: R, payer: "0x2222222222222222222222222222222222222222" });
  for (const dir of roundOf(R).optimalRoute) move(solved, dir, true);
  finish(solved, "solved");

  const ranked = board("fewest-steps", [quit, solved], R);

  expect(ranked.unfinished[0]?.overOptimal).toBeNull();
  expect(ranked.entries[0]?.overOptimal).toBe(0);

  // And nothing on either list can claim to have beaten the shortest route.
  for (const e of [...ranked.entries, ...ranked.unfinished]) {
    if (e.overOptimal !== null) expect(e.overOptimal).toBeGreaterThanOrEqual(0);
  }
});

test("an agent cannot farm the same round for reputation over and over", async () => {
  const written: bigint[] = [];
  const store = new RunStore();
  const payer = "0x1111111111111111111111111111111111111111";
  const app = routes({
    seller: SELLER, runs: store, publicUrl: "https://maze.test",
    verifyIdentity: async () => true,
    scribe: { write: async (agentId: bigint) => { written.push(agentId); return { agentId, value: 100, hash: "0x" as `0x${string}` }; } },
    paywall: new Paywall({
      verify: async () => ({ isValid: true, payer }),
      settle: async () => ({ success: true, transaction: "b", payer, network: "eip155:5042002" }),
    }),
  });
  const { round: roundOf } = await import("../src/maze/index.ts");

  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await app["/game"].POST(asRoute("/game?agent=42", {}));
    const id = String((await created.json() as Record<string, unknown>)["run"]);
    for (const dir of roundOf(R).optimalRoute) {
      await app["/game/:id/move"].POST(asRoute(`/game/${id}/move?dir=${dir}`, { id }, true));
    }
  }
  await Promise.resolve();
  expect(written).toHaveLength(1);
});

test("one payer cannot occupy every place on a board", async () => {
  const store = new RunStore();
  const payer = "0x1111111111111111111111111111111111111111";
  let settled = 0;
  const app = routes({
    seller: SELLER, runs: store,
    paywall: new Paywall({
      verify: async () => ({ isValid: true, payer }),
      settle: async () => { settled += 1; return { success: true, transaction: "b", payer, network: "eip155:5042002" }; },
    }),
  });

  const ATTEMPTS = RUNS_PER_PAYER_PER_ROUND + 3;
  let refusals = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const created = await app["/game"].POST(asRoute("/game", {}));
    const id = String((await created.json() as Record<string, unknown>)["run"]);
    const response = await app["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, true));
    if (response.status === 403) refusals += 1;
  }
  // Exactly the cap gets through, and exactly the excess is refused. "More than none" would pass
  // for a cap of one and for a cap of a thousand, which is not the rule being defended.
  expect(refusals).toBe(ATTEMPTS - RUNS_PER_PAYER_PER_ROUND);
  // And the refusals cost nothing: settle is never reached for them.
  expect(settled).toBe(RUNS_PER_PAYER_PER_ROUND);
});

test("a badge is offered on a solve, and a closed cohort is not an error", async () => {
  const admitted: bigint[] = [];
  const store = new RunStore();
  const payer = "0x1111111111111111111111111111111111111111";
  const { round: roundOf } = await import("../src/maze/index.ts");
  const app = routes({
    seller: SELLER, runs: store, publicUrl: "https://maze.test",
    verifyIdentity: async () => true,
    scribe: { write: async (agentId: bigint) => ({ agentId, value: 100, hash: "0x" as `0x${string}` }) },
    // A full cohort answers null rather than throwing: it is a state, not a failure.
    registrar: {
      admit: async (agentId: bigint) => { admitted.push(agentId); return null; },
      taken: async () => null,
    },
    paywall: new Paywall({
      verify: async () => ({ isValid: true, payer }),
      settle: async () => ({ success: true, transaction: "b", payer, network: "eip155:5042002" }),
    }),
  });
  const created = await app["/game"].POST(asRoute("/game?agent=42", {}));
  const id = String((await created.json() as Record<string, unknown>)["run"]);
  for (const dir of roundOf(R).optimalRoute) {
    await app["/game/:id/move"].POST(asRoute(`/game/${id}/move?dir=${dir}`, { id }, true));
  }
  await Promise.resolve();
  expect(admitted).toEqual([42n]);
  // And the run is still solved: nothing about the badge can affect the game.
  const run = store.get(id);
  expect(run?.outcome).toBe("solved");
});
