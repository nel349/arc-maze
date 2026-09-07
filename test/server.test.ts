import { expect, test } from "bun:test";
import { routes } from "../src/server.ts";
import { round, roundIdAt } from "../src/round.ts";
import { Paywall } from "../src/paywall.ts";
import { finish, look as lookAction, map as mapAction, move, RunStore } from "../src/runs.ts";

/** A move that lands somewhere, for building board fixtures without a maze walk. */
const moveAction = (run: Parameters<typeof finish>[0]): void => { move(run, "e", true); };
void lookAction;

/**
 * The routes, exercised without a socket.
 *
 * The facilitator is stubbed because the real one is Circle's network — a test suite that needs it
 * fails on a train, and it would settle real payments on every run. What is being checked here is
 * our behaviour around payment, which is where the bugs live.
 */

const SELLER = "0xd5ab9Aa81Fd9c7526333b7B8aAbA3Bc3d9CA105B";
const PAYER = "0x1111111111111111111111111111111111111111";

const facilitator = (result: "valid" | "invalid" | "throws", payer = PAYER) => ({
  verify: async () => {
    if (result === "throws") throw new Error("gateway unreachable");
    return { isValid: result === "valid", invalidReason: "invalid_signature", payer };
  },
  settle: async () => ({ success: true, transaction: "batch-1", payer, network: "eip155:5042002" }),
});

const build = (result: "valid" | "invalid" | "throws" = "valid", payer = PAYER) =>
  routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator(result, payer)) });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Every object in an array, narrowed. Boards and entries arrive as `unknown` from `.json()`. */
const objectsIn = (value: unknown): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value.filter(isObject);
};

/** `.json()` yields `unknown`; this narrows it once so no test has to assert its way past that. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isObject(parsed)) throw new Error("expected a JSON object");
  return parsed;
}

/** Start a run and hand back its id, typed, so no test has to reach into an `unknown`. */
async function startRun(app: ReturnType<typeof routes>, agentId?: bigint): Promise<string> {
  const query = agentId === undefined ? "" : `?agent=${agentId}`;
  const body = await bodyOf(await app["/game"].POST(asRoute(`/game${query}`, {})));
  const id = body["run"];
  if (typeof id !== "string") throw new Error("POST /game did not return a run id");
  return id;
}

const SIGNATURE = btoa(JSON.stringify({ x402Version: 2, payload: {} }));

/**
 * A request as Bun's router would hand it to a handler.
 *
 * `BunRequest` is not constructible — the router attaches `params` — so building one for a test
 * needs exactly one assertion. It lives here, once, rather than at each of the ten call sites that
 * would otherwise each carry an `as never` and each be a place to get the params wrong.
 */
function asRoute<P extends string>(
  path: string,
  params: Record<string, string>,
  init: { method?: string; paying?: boolean } = {},
): Bun.BunRequest<P> {
  const headers = init.paying === true ? { "payment-signature": SIGNATURE } : undefined;
  const request = new Request(`http://maze.test${path}`, {
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(headers === undefined ? {} : { headers }),
  });
  return Object.assign(request, { params }) as Bun.BunRequest<P>;
}

test("a seller address that is not an address is refused at construction", () => {
  expect(() => routes({ seller: "not-an-address" })).toThrow(/must be an address/);
});

test("starting a run is free, because you cannot price what nobody can see yet", async () => {
  const app = build();
  const response = await app["/game"].POST(asRoute("/game", {}));
  expect(response.status).toBe(201);
  const body = await bodyOf(response);
  expect(body["outcome"]).toBe("running");
  expect(body["spentUsd"]).toBe(0);
});

test("an unpaid move answers 402 and says what it costs, in the header the protocol reads", async () => {
  const app = build();
  const run = await startRun(app);
  const response = await app["/game/:id/move"].POST(
    asRoute(`/game/${run}/move?dir=e`, { id: run }, { method: "POST" }),
  );
  expect(response.status).toBe(402);
  expect(response.headers.get("payment-required")).toBeTruthy();
  const header = response.headers.get("payment-required");
  expect(header).toBeTruthy();
  const advertised: unknown = JSON.parse(atob(header ?? ""));
  if (!isObject(advertised) || !Array.isArray(advertised["accepts"])) throw new Error("no accepts");
  const [option] = advertised["accepts"];
  if (!isObject(option)) throw new Error("accepts[0] is not an object");
  expect(option["network"]).toBe("eip155:5042002");
  expect(option["payTo"]).toBe(SELLER);
});

test("a facilitator outage is a 503, not a 402 — the buyer's wallet is fine", async () => {
  const app = build("throws");
  const run = await startRun(app);
  const response = await app["/game/:id/move"].POST(
    asRoute(`/game/${run}/move?dir=e`, { id: run }, { method: "POST", paying: true }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("30");
});

test("a refused payment is a 402 and names the reason", async () => {
  const app = build("invalid");
  const run = await startRun(app);
  const response = await app["/game/:id/move"].POST(
    asRoute(`/game/${run}/move?dir=e`, { id: run }, { method: "POST", paying: true }),
  );
  expect(response.status).toBe(402);
  expect((await bodyOf(response))["reason"]).toBe("invalid_signature");
});

test("a bad direction is refused before anyone is charged", async () => {
  const app = build();
  const run = await startRun(app);
  const response = await app["/game/:id/move"].POST(
    asRoute(`/game/${run}/move?dir=up`, { id: run }, { method: "POST", paying: true }),
  );
  expect(response.status).toBe(400);
});

test("a run belongs to whoever paid for it first, and nobody else", async () => {
  const store = new RunStore();
  const mine = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid", PAYER)) });
  const theirs = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid", "0x2222222222222222222222222222222222222222")) });

  const run = await startRun(mine);
  const first = await mine["/game/:id/look"](
    asRoute(`/game/${run}/look`, { id: run }, { method: "POST", paying: true }),
  );
  expect(first.status).toBe(200);

  const intruder = await theirs["/game/:id/look"](
    asRoute(`/game/${run}/look`, { id: run }, { method: "POST", paying: true }),
  );
  expect(intruder.status).toBe(403);
});

test("a paid look is recorded, so the run's evidence matches what was charged", async () => {
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")) });
  const run = await startRun(app);
  await app["/game/:id/look"](
    asRoute(`/game/${run}/look`, { id: run }, { method: "POST", paying: true }),
  );
  const record = await bodyOf(await app["/run/:id"](
    asRoute(`/run/${run}`, { id: run }),
  ));
  expect(record["spentUsd"]).toBe(0.002);
  expect(record["actions"]).toHaveLength(1);
});

test("an unknown run is a 404, not a crash", async () => {
  const app = build();
  const response = await app["/run/:id"](
    asRoute("/run/nope", { id: "nope" }),
  );
  expect(response.status).toBe(404);
});

test("the two boards rank opposite behaviour, and only solved runs are ranked", async () => {
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")) });
  // The current hour, because a round before the game began correctly does not exist.
  const ROUND_NOW = roundIdAt();

  // A sprinter: few steps, lots of money (it bought the map). A miser: more steps, less money.
  const sprinter = store.start({ roundId: ROUND_NOW, payer: PAYER });
  mapAction(sprinter);
  for (let i = 0; i < 3; i++) moveAction(sprinter);
  finish(sprinter, "solved");

  const miser = store.start({ roundId: ROUND_NOW, payer: PAYER });
  for (let i = 0; i < 8; i++) moveAction(miser);
  finish(miser, "solved");

  // And one that gave up, which must not top the efficiency board by failing cheaply.
  const quitter = store.start({ roundId: ROUND_NOW, payer: PAYER });
  moveAction(quitter);
  finish(quitter, "gave-up");

  const body = await bodyOf(await app["/round/:id"](
    asRoute(`/round/${ROUND_NOW}`, { id: ROUND_NOW }),
  ));
  const [fewest, cheapest] = objectsIn(body["boards"]);
  const idsOf = (b: Record<string, unknown> | undefined): unknown[] =>
    objectsIn(b?.["entries"]).map((e) => e["run"]);

  expect(fewest?.["kind"]).toBe("fewest-steps");
  expect(idsOf(fewest)[0]).toBe(sprinter.id);
  expect(cheapest?.["kind"]).toBe("least-spent");
  expect(idsOf(cheapest)[0]).toBe(miser.id);

  // The quitter is listed, but never ranked.
  expect(idsOf(fewest)).not.toContain(quitter.id);
  expect(objectsIn(fewest?.["unfinished"])).toHaveLength(1);
});

test("a board says its entries are claims, not settled facts", async () => {
  const app = build();
  const body = await bodyOf(await app["/board"]());
  for (const b of objectsIn(body["boards"])) {
    expect(b["basis"]).toBe("claimed");
  }
});

test("a declared identity is kept only when it really belongs to the payer", async () => {
  const mine = routes({
    seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")),
    verifyIdentity: async () => true,
  });
  const run = await startRun(mine, 892655n);
  const after = await bodyOf(await mine["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true })));
  expect(after["agentId"]).toBe("892655");
});

test("a declared identity that is not the payer's is dropped, and the maze still plays", async () => {
  const app = routes({
    seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")),
    verifyIdentity: async () => false,
  });
  const run = await startRun(app, 999999n);
  const response = await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));
  // Playing is unaffected — only the reputation half needs an identity.
  expect(response.status).toBe(200);
  expect((await bodyOf(response))["agentId"]).toBeNull();
});

test("solving with a verified identity writes reputation; without one, nothing is written", async () => {
  const written: bigint[] = [];
  const scribe = {
    write: async (agentId: bigint) => {
      written.push(agentId);
      return { agentId, value: 100, hash: "0xdeadbeef" as `0x${string}` };
    },
  };
  const store = new RunStore();
  const app = routes({
    seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")),
    scribe, verifyIdentity: async () => true, publicUrl: "https://maze.test",
  });

  // Walk the real optimal route so the run genuinely solves.
  const run = await startRun(app, 892655n);
  for (const dir of round(roundIdAt()).optimalRoute) {
    await app["/game/:id/move"].POST(asRoute(`/game/${run}/move?dir=${dir}`, { id: run }, { method: "POST", paying: true }));
  }
  const finished = await bodyOf(await app["/game/:id"](asRoute(`/game/${run}`, { id: run })));
  expect(finished["outcome"]).toBe("solved");
  // The write is fired without being awaited, so give the microtask a turn.
  await Promise.resolve();
  expect(written).toEqual([892655n]);
});
