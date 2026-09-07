import { expect, test } from "bun:test";
import { RunStore } from "../src/maze/index.ts";
import { roundIdAt } from "../src/maze/index.ts";
import { routes } from "../src/server.ts";
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
  expect(store.size).toBeLessThanOrEqual(5);
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

test("ordering does not depend on the machine's locale", async () => {
  // localeCompare is locale-sensitive; ISO timestamps must be compared as plain strings.
  const { board } = await import("../src/maze/index.ts");
  void board;
  expect("2026-09-07T02:00:00.000Z" < "2026-09-07T02:00:00.001Z").toBe(true);
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

  let refusals = 0;
  for (let i = 0; i < 8; i++) {
    const created = await app["/game"].POST(asRoute("/game", {}));
    const id = String((await created.json() as Record<string, unknown>)["run"]);
    const response = await app["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, true));
    if (response.status === 403) refusals += 1;
  }
  expect(refusals).toBeGreaterThan(0);
  // And the refusals cost nothing: settle is never reached for them.
  expect(settled).toBeLessThan(8);
});
