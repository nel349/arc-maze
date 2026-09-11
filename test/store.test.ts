import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runsInMemory, type Runs } from "../src/storage.ts";
import { runsInUpstash, upstash, type Upstash } from "../src/archive.ts";
import { routes } from "../src/routes.ts";
import { Paywall } from "../src/arc/index.ts";
import {
  canMove, digest, look, move, moved, published, round, roundIdAt, verify, type Direction, type Run,
} from "../src/maze/index.ts";

/**
 * One contract, two stores, the same tests.
 *
 * Every other test in this suite runs on the memory store. If the shared store behaved differently,
 * all of them would pass and the public maze would not, so the contract is checked against both.
 *
 * The shared store here is the real one: Upstash, reached with the credentials the server uses, which
 * Bun reads from `.env`. Every key these tests write starts with a fresh prefix, and all of them are
 * removed at the end. Without the credentials that half cannot run, and it says so.
 */

const storeUrl = process.env["UPSTASH_REDIS_REST_URL"];
const storeToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
const db: Upstash | null = storeUrl !== undefined && storeToken !== undefined
  ? upstash(storeUrl, storeToken)
  : null;
if (db === null) {
  console.warn("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set, so the shared-store " +
    "half of test/store.test.ts did not run.");
}

/** Everything this file writes to the real store starts with this, and is removed afterwards. */
const PREFIX = `test:${randomUUID()}:`;
/** A key space of its own for each test, so no test sees another's runs. */
const fresh = (): string => `${PREFIX}${randomUUID()}:`;

/** The real store answers over the network, a few dozen times per test. */
const SHARED_TIMEOUT_MS = 30_000;

const STORES: readonly { readonly name: string; readonly make: () => Runs; readonly timeout?: number }[] = [
  { name: "in memory", make: () => runsInMemory() },
  ...(db === null ? [] : [{ name: "shared", make: () => runsInUpstash(db, fresh()), timeout: SHARED_TIMEOUT_MS }]),
];

afterAll(async () => {
  if (db === null) return;
  let cursor = "0";
  do {
    const answer = await db.command(["SCAN", cursor, "MATCH", `${PREFIX}*`, "COUNT", 500]);
    if (!Array.isArray(answer)) throw new Error("SCAN answered something other than a cursor and keys");
    const [next, keys] = answer as [string, string[]];
    if (keys.length > 0) await db.command(["DEL", ...keys]);
    cursor = next;
  } while (cursor !== "0");
});

const R = roundIdAt();
const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

/** One step, as the router takes it: into a wall costs and goes nowhere, anywhere else moves. */
function step(run: Run, direction: Direction): void {
  const open = canMove(round(run.roundId).cells, run.at.x, run.at.y, direction);
  if (open) run.at = moved(run.at.x, run.at.y, direction);
  move(run, direction, open, "batch-1");
}

for (const { name, make, timeout } of STORES) {
  test(`${name}: a run starts with nobody's name on it, and reads back as it was`, async () => {
    const runs = make();
    const run = await runs.start({ roundId: R, agentId: 892655n });
    const back = await runs.get(run.id);
    expect(back === null ? null : published(back)).toEqual(published(run));
    expect(await runs.record(run.id)).toEqual(published(run));
    expect(back?.payer).toBeNull();
    expect(back?.agentId).toBe(892655n);
    expect(await runs.get(randomUUID())).toBeNull();
  }, timeout);

  test(`${name}: one paid action holds a run at a time`, async () => {
    const runs = make();
    const { id } = await runs.start({ roundId: R });
    expect(await runs.hold(id)).toBe(true);
    expect(await runs.hold(id)).toBe(false);
    await runs.release(id);
    expect(await runs.hold(id)).toBe(true);
    await runs.release(id);
  }, timeout);

  test(`${name}: a run belongs to its first payer, who is counted once per run`, async () => {
    const runs = make();
    const first = await runs.start({ roundId: R });
    const second = await runs.start({ roundId: R });

    expect(await runs.claim(first, PAYER)).toEqual({ ok: true, runsThisRound: 1 });
    // A retry by the same payer is not a second run, and not an accusation of theft.
    expect(await runs.claim(first, PAYER)).toEqual({ ok: true, runsThisRound: 1 });
    expect(await runs.claim(first, OTHER)).toEqual({ ok: false });
    expect(await runs.claim(second, PAYER)).toEqual({ ok: true, runsThisRound: 2 });

    // And the claim is stored, not only held by whoever made it.
    expect((await runs.get(first.id))?.payer).toBe(PAYER);
  }, timeout);

  test(`${name}: what is written back is what the next reader finds, walls and all`, async () => {
    const runs = make();
    const run = await runs.start({ roundId: R, agentId: 42n });
    await runs.claim(run, PAYER);
    step(run, "n");                                   // the outside of the maze: a wall, and paid for
    look(run, "batch-1");
    for (const direction of round(R).optimalRoute.slice(0, 5)) step(run, direction);
    await runs.save(run);

    const back = await runs.get(run.id);
    if (back === null) throw new Error("the run was not there to read back");
    expect(back.at).toEqual(run.at);
    expect(back.steps).toBe(5);
    expect(back.spentUsd).toBe(run.spentUsd);
    expect(back.settlements).toBe(7);
    expect(back.actions).toEqual(run.actions);        // including which moves went nowhere
    expect(verify(published(back)).problems).toEqual([]);
  }, timeout);

  test(`${name}: only runs somebody paid for are listed, and without their actions`, async () => {
    const runs = make();
    const paid = await runs.start({ roundId: R });
    await runs.start({ roundId: R });                // started and never paid for
    await runs.claim(paid, PAYER);
    look(paid, "batch-1");
    await runs.save(paid);

    const inRound = await runs.inRound(R);
    expect(inRound.map((r) => r.id)).toEqual([paid.id]);
    expect(inRound[0]?.spentUsd).toBe(0.002);
    expect(inRound[0]).not.toHaveProperty("actions");
    expect((await runs.every()).map((r) => r.id)).toEqual([paid.id]);
    expect(await runs.inRound("2026-09-07T00")).toEqual([]);
  }, timeout);

  test(`${name}: an agent's reward in a round can be taken once, and given back`, async () => {
    const runs = make();
    expect(await runs.reserveReward(42n, R, "run-a")).toBe(true);
    expect(await runs.reserveReward(42n, R, "run-b")).toBe(false);
    expect(await runs.reserveReward(42n, "2026-09-07T00", "run-c")).toBe(true);
    expect(await runs.reserveReward(43n, R, "run-d")).toBe(true);
    await runs.releaseReward(42n, R);
    expect(await runs.reserveReward(42n, R, "run-e")).toBe(true);
  }, timeout);
}

// ------------------------------------------------------------------ the shared store only

if (db !== null) {
  test("shared: a run nobody pays for expires, and its first paid action keeps it for good", async () => {
    const prefix = fresh();
    const runs = runsInUpstash(db, prefix);
    const run = await runs.start({ roundId: R });
    const ttl = async (): Promise<unknown> => db.command(["TTL", `${prefix}run:${run.id}`]);
    expect(Number(await ttl())).toBeGreaterThan(0);

    await runs.claim(run, PAYER);
    // Claimed and nothing bought is still unpaid, so it still expires.
    expect(Number(await ttl())).toBeGreaterThan(0);

    look(run, "batch-1");
    await runs.save(run);
    expect(Number(await ttl())).toBe(-1);

    // Kept as the published record, under the key the verdict workflow reads.
    const raw = await db.command(["GET", `${prefix}run:${run.id}`]);
    expect(JSON.parse(String(raw))).toEqual(published(run));
  }, SHARED_TIMEOUT_MS);

  /**
   * The record ranked first on the all-time board was kept before runs carried an identity. The chain
   * commits to its exact contents, so it is handed back as kept rather than published again with the
   * field added, which would change its digest.
   */
  test("shared: a record kept before a field existed is handed back exactly as kept", async () => {
    const prefix = fresh();
    const runs = runsInUpstash(db, prefix);
    const run = await runs.start({ roundId: R });
    await runs.claim(run, PAYER);
    look(run, "batch-1");
    const { agentId: _agentId, ...legacy } = published(run);
    await db.command(["SET", `${prefix}run:${run.id}`, JSON.stringify(legacy)]);

    const record = await runs.record(run.id);
    expect(record).toEqual(legacy as never);
    expect(digest(record)).toBe(digest(legacy));
    expect((await runs.get(run.id))?.agentId).toBeNull();
  }, SHARED_TIMEOUT_MS);

  const SELLER = "0xd5ab9Aa81Fd9c7526333b7B8aAbA3Bc3d9CA105B";
  const SIGNATURE = btoa(JSON.stringify({ x402Version: 2, payload: {} }));
  const call = <P extends string>(path: string, params: Record<string, string>, paying = false): Bun.BunRequest<P> =>
    Object.assign(
      new Request(`http://maze.test${path}`, paying
        ? { method: "POST", headers: { "payment-signature": SIGNATURE } }
        : { method: "POST" }),
      { params },
    ) as Bun.BunRequest<P>;

  /**
   * The bug this store exists for.
   *
   * Three copies of the server, each with its own connection and nothing in memory in common, the way
   * the host runs them. The run is started on one, walked on two others taking turns, and read back on
   * a third. Before, the second copy answered "no such run" to a payment, and the third drew a board
   * without it.
   */
  test("shared: a run started on one copy of the server is played on another, and every page agrees", async () => {
    const prefix = fresh();
    const facilitator = {
      verify: async () => ({ isValid: true, payer: PAYER }),
      settle: async () => ({ success: true, transaction: "batch-1", payer: PAYER, network: "eip155:5042002" }),
    };
    const copy = () => routes({
      seller: SELLER,
      runs: runsInUpstash(upstash(storeUrl ?? "", storeToken ?? ""), prefix),
      paywall: new Paywall(facilitator),
    });
    const [starter, walkers, reader] = [copy(), [copy(), copy()] as const, copy()];

    const created = await starter["/game"].POST(call("/game", {}));
    const id = String(((await created.json()) as Record<string, unknown>)["run"]);

    for (const [index, direction] of round(R).optimalRoute.entries()) {
      const server = walkers[index % 2] ?? starter;
      const answer = await server["/game/:id/move"].POST(call(`/game/${id}/move?dir=${direction}`, { id }, true));
      expect(answer.status).toBe(200);
    }

    const record = (await (await reader["/run/:id"](call(`/run/${id}`, { id }))).json()) as Record<string, unknown>;
    expect(record["outcome"]).toBe("solved");
    expect(record["steps"]).toBe(round(R).optimalSteps);
    const audit = (await (await reader["/run/:id/verify"](call(`/run/${id}/verify`, { id }))).json()) as Record<string, unknown>;
    expect(audit["ok"]).toBe(true);

    const thisRound = (await (await reader["/round/:id"](call(`/round/${R}`, { id: R }))).json()) as {
      boards: { entries: { run: string }[] }[];
    };
    expect(thisRound.boards[0]?.entries.map((e) => e.run)).toEqual([id]);

    const every = (await (await reader["/runs"](call("/runs", {}))).json()) as { runs: { id: string }[] };
    expect(every.runs.map((r) => r.id)).toEqual([id]);
  }, 120_000);
}
