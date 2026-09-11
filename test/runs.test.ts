import { expect, test } from "bun:test";
import { round } from "../src/maze/index.ts";
import {
  digest, DIRECTION_NAMES, DIRECTIONS, discovered, finish, look, map, move, moved, published,
  RunStore, verify, WIDTH, type Direction, type PublishedRun,
} from "../src/maze/index.ts";

import { isRunId, revive, summaryOf } from "../src/maze/index.ts";

const ROUND = "2026-09-07T00";
const PAYER = "0x1111111111111111111111111111111111111111";

/** A fresh store per test, so no test can depend on the ones before it. */
const start = (): ReturnType<RunStore["start"]> =>
  new RunStore().start({ roundId: ROUND, payer: PAYER });

/** Walk the known-best route, recording each move as the server would. */
function solved() {
  const run = start();
  for (const direction of round(ROUND).optimalRoute) move(run, direction, true);
  return published(finish(run, "solved"));
}

test("a real solve verifies", () => {
  const result = verify(solved());
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.steps).toBe(round(ROUND).optimalSteps);
});

test("the charge matches the actions", () => {
  const record = solved();
  expect(record.spentUsd).toBe(Number((record.steps * 0.001).toFixed(6)));
});

test("a tampered total is caught", () => {
  const cheaper: PublishedRun = { ...solved(), spentUsd: 0.001 };
  expect(verify(cheaper).ok).toBe(false);
  expect(verify(cheaper).problems.join(" ")).toMatch(/spend says/);
});

test("claiming a solve you did not reach is caught", () => {
  const run = start();
  move(run, round(ROUND).optimalRoute[0]!, true);
  const lie = published(finish(run, "solved"));
  expect(verify(lie).ok).toBe(false);
  expect(verify(lie).problems.join(" ")).toMatch(/claims solved/);
});

test("a step quietly removed from the middle is caught", () => {
  const record = solved();
  const actions = record.actions.filter((_, i) => i !== 3);
  const shortened: PublishedRun = {
    ...record,
    actions,
    steps: actions.length,
    spentUsd: Number((actions.length * 0.001).toFixed(6)),
  };
  expect(verify(shortened).ok).toBe(false);
});

test("walking into a wall costs money and gets you nowhere", () => {
  const run = start();
  // North from the start cell is the outside of the maze, so it can never be open.
  move(run, "n", false);
  const result = verify(published(finish(run, "gave-up")));
  expect(result.problems).toEqual([]);
  expect(result.steps).toBe(0);
  expect(result.spentUsd).toBe(0.001);
});

test("looking and buying the map cost what the tariff says", () => {
  const run = start();
  look(run);
  map(run);
  expect(published(run).spentUsd).toBe(0.012);
  expect(verify(published(finish(run, "gave-up"))).ok).toBe(true);
});

test("the digest ignores key order, or the chain commits to a moving target", () => {
  const record = solved();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  expect(digest(record)).toBe(digest(reordered));
});

test("the digest changes when the record does", () => {
  const record = solved();
  expect(digest(record)).not.toBe(digest({ ...record, steps: record.steps + 1 }));
});

test("a published run carries no position, since anything derivable can drift", () => {
  expect("at" in solved()).toBe(false);
});

test("the store bounds itself rather than growing until the process dies", () => {
  const store = new RunStore(3);
  for (let i = 0; i < 5; i++) {
    finish(store.start({ roundId: ROUND, payer: PAYER }), "gave-up");
  }
  // Exactly the limit, not merely "no more than": an eviction that emptied the store would also
  // satisfy an upper bound, and losing every run is not what bounding one means.
  expect(store.size).toBe(3);
});

test("eviction never takes a maze away from an agent mid-step", () => {
  const store = new RunStore(2);
  const running = store.start({ roundId: ROUND, payer: PAYER });
  // Fill well past the limit with finished runs; the live one must survive all of it.
  for (let i = 0; i < 10; i++) {
    finish(store.start({ roundId: ROUND, payer: PAYER }), "gave-up");
  }
  expect(store.get(running.id)).toBeDefined();
  expect(store.get(running.id)?.outcome).toBe("running");
});

test("a round's runs are the ones that started in it", () => {
  const store = new RunStore();
  store.start({ roundId: ROUND, payer: PAYER });
  store.start({ roundId: "2026-09-07T01", payer: PAYER });
  expect(store.forRound(ROUND)).toHaveLength(1);
  expect(store.forRound("2026-09-07T01")).toHaveLength(1);
});

// ---- what a run has paid to see --------------------------------------------

/**
 * The drawing on a run page must show what the agent bought, not what is true. An agent that has
 * spent nothing knows nothing, and every fact after that has a price attached to it.
 */
const knows = (run: ReturnType<typeof published>, x: number, y: number, d: Direction): boolean =>
  ((discovered(run).walls[y * WIDTH + x] ?? 0) & DIRECTIONS[d]) !== 0;

test("a run that has bought nothing knows nothing", () => {
  const fresh = published(start());
  expect(discovered(fresh).walls.every((w) => w === 0)).toBe(true);
  expect(discovered(fresh).visited.size).toBe(1);   // it is standing somewhere
});

test("a move settles the wall it crossed, and only that one", () => {
  const run = start();
  const first = round(ROUND).optimalRoute[0]!;
  move(run, first, true);
  const record = published(run);

  expect(knows(record, 0, 0, first)).toBe(true);
  // The other three walls of the starting cell were never tested.
  for (const d of DIRECTION_NAMES) {
    if (d !== first) expect(knows(record, 0, 0, d)).toBe(false);
  }
});

test("walking into a wall is knowledge too — it was paid for", () => {
  const run = start();
  move(run, "n", false);            // north out of the start cell is the outside
  expect(knows(published(run), 0, 0, "n")).toBe(true);
});

test("a look settles every wall of the cell it was bought in", () => {
  const run = start();
  look(run);
  const record = published(run);
  for (const d of DIRECTION_NAMES) expect(knows(record, 0, 0, d)).toBe(true);
  // and tells it nothing about anywhere else
  expect(knows(record, 3, 3, "n")).toBe(false);
});

test("the map settles all of them, which is what ten steps buys", () => {
  const run = start();
  map(run);
  expect(discovered(published(run)).walls.every((w) => w === (1 | 2 | 4 | 8))).toBe(true);
});

test("a wall learned from one side is known from the other, since it is one wall", () => {
  const run = start();
  const first = round(ROUND).optimalRoute[0]!;
  move(run, first, true);
  const record = published(run);
  const to = moved(0, 0, first);
  // Standing in the new cell, the way back is not a mystery.
  expect(knows(record, to.x, to.y, first === "s" ? "n" : first === "n" ? "s" : first === "e" ? "w" : "e")).toBe(true);
});

// ---- what the store counts, and what it throws away -------------------------

/**
 * The cap exists so one agent cannot occupy a board. It must therefore count *this* payer in
 * *this* round — an `||` in place of the `&&` counts everybody's runs against everybody, which
 * turns a fairness rule into a way for one payer to lock every other agent out of the round.
 */
test("the per-payer cap counts one payer in one round, not everyone everywhere", () => {
  const OTHER_ROUND = "2026-09-07T01";
  const OTHER_PAYER = "0x2222222222222222222222222222222222222222";
  const store = new RunStore();

  store.start({ roundId: ROUND, payer: PAYER });
  store.start({ roundId: ROUND, payer: PAYER });
  store.start({ roundId: OTHER_ROUND, payer: PAYER });
  store.start({ roundId: ROUND, payer: OTHER_PAYER });

  expect(store.countFor(ROUND, PAYER)).toBe(2);
  expect(store.countFor(OTHER_ROUND, PAYER)).toBe(1);
  // The one that matters: another agent's runs are not held against this one.
  expect(store.countFor(ROUND, OTHER_PAYER)).toBe(1);
});

test("the cap does not care what case the payer's address arrived in", () => {
  const store = new RunStore();
  store.start({ roundId: ROUND, payer: PAYER.toUpperCase().replace("0X", "0x") });
  expect(store.countFor(ROUND, PAYER)).toBe(1);
});

/**
 * Eviction order, which the store's own comment calls out as the thing that regressed before: a run
 * somebody has paid for and is still walking must never be the one dropped. Ordered deliberately so
 * the in-flight run is met *first* — otherwise the loop reaches the finished one first and both the
 * right rule and the wrong one delete the same entry.
 */
test("a paid run still in progress outlives a finished one when room runs out", () => {
  const store = new RunStore(3);
  const oldest = store.start({ roundId: ROUND, payer: PAYER });
  finish(oldest, "solved");
  const newer = store.start({ roundId: ROUND, payer: "0x2222222222222222222222222222222222222222" });
  finish(newer, "solved");
  const inFlight = store.start({ roundId: ROUND, payer: "0x3333333333333333333333333333333333333333" });

  store.start({ roundId: ROUND, payer: "0x4444444444444444444444444444444444444444" });

  // Two finished runs, deliberately: with only one, "take the first finished" and "take the last
  // finished" delete the same entry, and the rule being defended is which end of the queue goes.
  expect(store.get(oldest.id)).toBeUndefined();
  expect(store.get(newer.id)).toBeDefined();
  expect(store.get(inFlight.id)).toBeDefined();
});

// ---- the payment evidence in the record -------------------------------------

/**
 * A settlement is the proof that a step was paid for, and the record is what a stranger replays.
 * Inverting the optional-field test drops it from every action that has one and writes an explicit
 * `undefined` on every action that does not — and nothing here noticed either half.
 */
test("a settled action carries its settlement into the record, and counts", () => {
  const run = start();
  const first = round(ROUND).optimalRoute[0]!;
  move(run, first, true, "0xsettled");
  look(run, "0xalso-settled");
  // The map too: it is the most expensive thing sold, and it was the one path with no test.
  map(run, "0xmap-settled");

  const record = published(run);
  expect(record.actions[0]?.settlement).toBe("0xsettled");
  expect(record.actions[1]?.settlement).toBe("0xalso-settled");
  expect(record.actions[2]?.settlement).toBe("0xmap-settled");
  expect(record.settlements).toBe(3);
});

test("an unsettled action carries no settlement field at all, rather than an empty one", () => {
  const run = start();
  move(run, round(ROUND).optimalRoute[0]!, true);
  const [action] = published(run).actions;
  expect(action !== undefined && "settlement" in action).toBe(false);
  expect(published(run).settlements).toBe(0);
});

/**
 * The unfinished list is ranked from one, like the list above it. Nothing read those numbers, so
 * they were free to start anywhere — and a board whose second list starts at 2 reads as though the
 * top entry were missing.
 */
test("the unfinished list is numbered from one", async () => {
  const { board } = await import("../src/maze/index.ts");
  const store = new RunStore();
  const quit = store.start({ roundId: ROUND, payer: PAYER });
  finish(quit, "gave-up");
  const ranked = board("fewest-steps", [quit].map(summaryOf), ROUND);
  expect(ranked.unfinished.map((e) => e.rank)).toEqual([1]);
});

/** Walk as the router walks: record the move, and stand somewhere new when it went anywhere. */
function walk(run: ReturnType<typeof start>, directions: readonly Direction[], settlement?: string): void {
  for (const direction of directions) {
    run.at = moved(run.at.x, run.at.y, direction);
    move(run, direction, true, settlement);
  }
}

/**
 * The shared store keeps the record and nothing else, and brings a run back by replaying it. If the
 * replay disagreed with the run that was written, the next step would be taken from the wrong square.
 */
test("a run brought back from its record is the run that was written, walls and all", () => {
  const run = start();
  run.agentId = 892655n;
  move(run, "n", false, "batch-1");      // the outside of the maze: paid for, and it went nowhere
  look(run, "batch-1");
  walk(run, round(ROUND).optimalRoute.slice(0, 4), "batch-2");

  expect(revive(published(run))).toEqual(run);
});

/**
 * The run ranked first on the all-time board would not open: its record was kept before runs carried
 * an identity, and it has no `agentId` at all. It cannot be rewritten to add one, because the chain
 * commits to its exact contents, so it has to be readable as it is.
 */
test("a record kept before runs carried an identity is read as having none", () => {
  const run = start();
  walk(run, round(ROUND).optimalRoute.slice(0, 2));
  const { agentId: _agentId, ...legacy } = published(run);

  const back = revive(legacy as PublishedRun);
  expect(back.agentId).toBeNull();
  expect(back.steps).toBe(2);
});

test("a run brought back carries on from where it stood, and still verifies", () => {
  const route = round(ROUND).optimalRoute;
  const run = start();
  walk(run, route.slice(0, 3));

  const back = revive(published(run));
  walk(back, route.slice(3));
  finish(back, "solved");

  expect(verify(published(back)).problems).toEqual([]);
  expect(back.steps).toBe(round(ROUND).optimalSteps);
});

test("a summary is the record without its actions", () => {
  const run = start();
  look(run);
  const { actions, ...rest } = published(run);
  expect(actions).toHaveLength(1);
  expect(summaryOf(run)).toEqual(rest);
});

test("only the shape a run id has ever had is looked up", () => {
  expect(isRunId(start().id)).toBe(true);
  expect(isRunId("25b9f044-09da-49bb-8545-04f46efc03de")).toBe(true);
  expect(isRunId("nope")).toBe(false);
  expect(isRunId("../../flushall")).toBe(false);
  expect(isRunId("probe-1789008111220")).toBe(false);
});

/**
 * The hash that goes on chain must not change when its implementation does.
 *
 * `digest()` computes the `feedbackHash` committed to Arc's reputation registry, permanently. It
 * moved off `node:crypto` because the same code has to run inside a Chainlink enclave, which has
 * neither `node:crypto` nor `Buffer` — verified by compiling against it. A hash that quietly
 * changed in that move would orphan every record already written: the chain would hold a commitment
 * nobody could ever reproduce from the published run.
 *
 * So this compares the two implementations directly on the same canonical form. `node:crypto` is
 * imported here, in a test, precisely because it must not be imported in the maze.
 */
test("the on-chain digest is byte-for-byte what node:crypto produced", async () => {
  const { createHash } = await import("node:crypto");
  const { digest } = await import("../src/maze/runs.ts");

  const canonical = (value: unknown): string => {
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) {
      const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  };

  for (const sample of [
    { id: "abc", steps: 12, spentUsd: 0.022, at: { x: 5, y: 5 } },
    { nested: [1, 2, { z: null, a: "x" }], flag: true },
    { unicode: "café — ✓", empty: {}, list: [] },
    "plain string",
    42,
  ]) {
    expect(digest(sample))
      .toBe(`0x${createHash("sha256").update(canonical(sample)).digest("hex")}`);
  }
});

/**
 * And the maze itself is unchanged by the same move.
 *
 * The generator seeds a PRNG from the first sixteen bytes of the hash, read as four little-endian
 * words. `Buffer.readUInt32LE` did that before; the arithmetic that replaced it is the place a
 * silent difference would hide — a wrong byte order still produces a perfectly good maze, just a
 * different one, and every run ever recorded would then fail to replay.
 */
test("the maze generated from a round id is the same maze it always was", async () => {
  const { generate } = await import("../src/maze/index.ts");
  const { createHash } = await import("node:crypto");

  const seed = "2026-09-07T05";
  const bytes = createHash("sha256").update(seed).digest();
  const cells = generate(seed);

  // The four words the generator must have started from, computed the old way.
  expect(bytes.readUInt32LE(0)).toBe(
    ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) >>> 0,
  );
  // And the maze those words produce, pinned to a literal.
  //
  // Comparing `generate(seed)` with `generate(seed)` would only say the generator is deterministic,
  // which it would be even if every wall had moved. The literal is the assertion.
  expect(createHash("sha256").update(cells.join(",")).digest("hex").slice(0, 16)).toBe("356181353d8c24df");
});

/**
 * A verifier must answer, including about rubbish.
 *
 * `verify` promises in its own docstring to take nothing on trust, and that was true of a record's
 * *contents* and quietly false of its *shape*: anything missing its actions threw a raw TypeError
 * out of the one function whose job is to return a verdict. It reached two callers that both
 * mattered — a 500 from `/run/:id/verify` on the server, and "undefined is not an object" inside
 * the enclave that re-executes runs, which says nothing at all about the record being malformed.
 *
 * Bad shape is a verdict, not an exception.
 */
test("a record that is not a record is refused rather than thrown at", async () => {
  const { verify } = await import("../src/maze/runs.ts");
  type Unchecked = Parameters<typeof verify>[0];

  for (const [what, value] of [
    ["a string", "just a string"],
    ["null", null],
    ["nothing at all", {}],
    ["actions that are not a list", { round: "2026-09-07T05", actions: "nope" }],
    ["a round that does not exist", { round: "not-a-round", actions: [] }],
    ["a round that is a number", { round: 7, actions: [] }],
  ] as const) {
    const result = verify(value as unknown as Unchecked);
    expect(result.ok, `${what} should be refused`).toBe(false);
    expect(result.problems[0], `${what} should say why`).toContain("not a record");
    // And the shape of the answer holds, so a caller can read it without a second check.
    expect(result.steps).toBe(0);
    expect(result.spentUsd).toBe(0);
    expect(result.endedAt).toEqual({ x: 0, y: 0 });
  }
});

/** A real record still replays, so the guard did not swallow the ordinary case. */
test("and a genuine record still passes the same door", async () => {
  const { RunStore, move, moved, finish, atExit, published, round, verify } =
    await import("../src/maze/index.ts");

  const store = new RunStore();
  const run = store.start({ roundId: "2026-09-07T05", payer: "0x1111111111111111111111111111111111111111" });
  for (const direction of round("2026-09-07T05").optimalRoute) {
    const next = moved(run.at.x, run.at.y, direction);
    move(run, direction, true);
    (run as { at: { x: number; y: number } }).at = next;
  }
  if (atExit(run.at.x, run.at.y)) finish(run, "solved");

  const result = verify(published(run));
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.steps).toBeGreaterThan(0);
});
