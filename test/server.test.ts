import { expect, test } from "bun:test";
import { ENDPOINTS, routes } from "../src/routes.ts";
import { STEPS, TERMS } from "../src/journey.ts";
import { runsInMemory } from "../src/storage.ts";
import { feed } from "../src/live/feed.ts";
import { cardSvg } from "../src/web/card.ts";
import { faviconSvg, MACHINE, PAPER } from "../src/web/brand.ts";
import { boardsFor, exits, HEIGHT, round, roundIdAt, WIDTH } from "../src/maze/index.ts";
import { Paywall, type Roster } from "../src/arc/index.ts";
import { finish, map as mapAction, move, RunStore } from "../src/maze/index.ts";

/** A move that lands somewhere, for building board fixtures without a maze walk. */
const moveAction = (run: Parameters<typeof finish>[0]): void => { move(run, "e", true); };

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
  routes({ seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator(result, payer)) });

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
  init: { method?: string; paying?: boolean; asBrowser?: boolean } = {},
): Bun.BunRequest<P> {
  const headers: Record<string, string> = {};
  if (init.paying === true) headers["payment-signature"] = SIGNATURE;
  if (init.asBrowser === true) headers["accept"] = "text/html,application/xhtml+xml";
  const request = new Request(`http://maze.test${path}`, {
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
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
  const header = response.headers.get("payment-required");
  expect(header).toBeTruthy();
  const advertised: unknown = JSON.parse(atob(header ?? ""));
  if (!isObject(advertised) || !Array.isArray(advertised["accepts"])) throw new Error("no accepts");
  const [option] = advertised["accepts"];
  if (!isObject(option)) throw new Error("accepts[0] is not an object");
  expect(option["network"]).toBe("eip155:5042002");
  expect(option["payTo"]).toBe(SELLER);
  // And for an agent that cannot pay at all yet, where the person's steps are. Without it the
  // refusal was a dead end: a price, and nothing about how to become able to pay it.
  const body = await bodyOf(response);
  expect(String(body["setup"])).toContain("/#how");
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
  const mine = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid", PAYER)) });
  const theirs = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid", "0x2222222222222222222222222222222222222222")) });

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
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")) });
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
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")) });
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
  const body = await bodyOf(await app["/board"](asRoute("/board", {})));
  for (const b of objectsIn(body["boards"])) {
    expect(b["basis"]).toBe("claimed");
  }
});

test("a declared identity is kept only when it really belongs to the payer", async () => {
  const mine = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")),
    verifyIdentity: async () => true,
  });
  const run = await startRun(mine, 892655n);
  const after = await bodyOf(await mine["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true })));
  expect(after["agentId"]).toBe("892655");
});

test("a declared identity that is not the payer's is dropped, and the maze still plays", async () => {
  const app = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")),
    verifyIdentity: async () => false,
  });
  const run = await startRun(app, 999999n);
  const response = await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));
  // Playing is unaffected — only the reputation half needs an identity.
  expect(response.status).toBe(200);
  expect((await bodyOf(response))["agentId"]).toBeNull();
});

/**
 * Solve the maze end to end, and report both the outcome and every identity the scribe was asked
 * to write. Two tests need exactly this, differing only in whether the identity checks out.
 */
async function solveWith(
  options: { readonly identityIsTheirs: boolean; readonly agentId?: bigint },
): Promise<{ readonly outcome: unknown; readonly written: readonly bigint[] }> {
  const written: bigint[] = [];
  const app = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")),
    scribe: {
      write: async (agentId: bigint) => {
        written.push(agentId);
        return { agentId, value: 100, hash: "0xdeadbeef" as `0x${string}` };
      },
    },
    verifyIdentity: async () => options.identityIsTheirs,
    publicUrl: "https://maze.test",
  });

  // Walk the real optimal route so the run genuinely solves.
  const run = await startRun(app, options.agentId);
  for (const dir of round(roundIdAt()).optimalRoute) {
    await app["/game/:id/move"].POST(asRoute(`/game/${run}/move?dir=${dir}`, { id: run }, { method: "POST", paying: true }));
  }
  const finished = await bodyOf(await app["/game/:id"](asRoute(`/game/${run}`, { id: run })));
  // No waiting afterwards: the solving step waits for the reward before it answers.
  return { outcome: finished["outcome"], written };
}

test("solving with a verified identity writes reputation", async () => {
  const { outcome, written } = await solveWith({ identityIsTheirs: true, agentId: 892655n });
  expect(outcome).toBe("solved");
  expect(written).toEqual([892655n]);
});

test("and solving without one writes nothing, though the maze plays the same", async () => {
  const declared = await solveWith({ identityIsTheirs: false, agentId: 892655n });
  expect(declared.outcome).toBe("solved");
  expect(declared.written).toEqual([]);

  // Nor does an agent that never declared an identity at all reach the registry.
  const silent = await solveWith({ identityIsTheirs: true });
  expect(silent.outcome).toBe("solved");
  expect(silent.written).toEqual([]);
});

/**
 * The map is the most expensive thing in the game — ten steps — and the only one an agent cannot
 * check against anything before it pays. If what comes back disagrees with the maze the server
 * walks it through, the agent plans a route into a wall and is charged for every step of it.
 */
test("the map an agent pays ten steps for is the maze it is actually standing in", async () => {
  const app = build();
  const run = await startRun(app);
  const response = await app["/game/:id/map"](
    asRoute(`/game/${run}/map`, { id: run }, { paying: true }),
  );
  expect(response.status).toBe(200);
  const body = await bodyOf(response);
  expect(body["spentUsd"]).toBe(0.01);

  const record = await bodyOf(await app["/run/:id"](asRoute(`/run/${run}`, { id: run })));
  const cells = round(String(record["round"])).cells;
  const sold = body["openings"];
  if (!Array.isArray(sold)) throw new Error("the map carried no openings");
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      expect(sold[y]?.[x]).toEqual(exits(cells, x, y));
    }
  }

  // And the drawing shows the agent where it stands, or a person watching cannot follow the run.
  expect(String(body["map"])).toContain("◆");
});

test("an unpaid map is refused at the price of a map, not sold at the price of a step", async () => {
  const app = build();
  const run = await startRun(app);
  const response = await app["/game/:id/map"](asRoute(`/game/${run}/map`, { id: run }));
  expect(response.status).toBe(402);
  const advertised: unknown = JSON.parse(atob(response.headers.get("payment-required") ?? ""));
  if (!isObject(advertised) || !Array.isArray(advertised["accepts"])) throw new Error("no accepts");
  const [option] = advertised["accepts"];
  if (!isObject(option)) throw new Error("accepts[0] is not an object");
  // Six decimals, the ERC-20 view's scale: $0.01 is 10000 units.
  expect(option["amount"]).toBe("10000");
});

/**
 * The audit endpoint is the whole trust claim — "replay any run yourself" — and until now nothing
 * called it. A verifier that silently agreed with everything would be worse than none.
 */
test("the audit endpoint replays a real run, and refuses to replay one that does not exist", async () => {
  const app = build();
  const run = await startRun(app);
  for (const dir of round(roundIdAt()).optimalRoute) {
    await app["/game/:id/move"].POST(
      asRoute(`/game/${run}/move?dir=${dir}`, { id: run }, { method: "POST", paying: true }),
    );
  }

  const audit = await bodyOf(await app["/run/:id/verify"](asRoute(`/run/${run}/verify`, { id: run })));
  expect(audit["ok"]).toBe(true);
  expect(audit["problems"]).toEqual([]);
  expect(audit["steps"]).toBe(round(roundIdAt()).optimalSteps);

  const missing = await app["/run/:id/verify"](asRoute("/run/nope/verify", { id: "nope" }));
  expect(missing.status).toBe(404);
});

test("the record a stranger downloads carries the digest the chain commits to", async () => {
  const app = build();
  const run = await startRun(app);
  const record = await bodyOf(await app["/run/:id"](asRoute(`/run/${run}`, { id: run })));
  expect(String(record["digest"])).toMatch(/^0x[0-9a-f]{64}$/);
});

test("every priced route advertises itself for discovery, even though nothing indexes Arc", async () => {
  const app = build();
  const run = await startRun(app);
  const response = await app["/game/:id/move"].POST(
    asRoute(`/game/${run}/move?dir=e`, { id: run }, { method: "POST" }),
  );
  const header = response.headers.get("payment-required");
  expect(header).toBeTruthy();
  const advertised: unknown = JSON.parse(atob(header ?? ""));
  if (!isObject(advertised) || !isObject(advertised["extensions"])) throw new Error("no extensions");
  const discovery = advertised["extensions"]["bazaar"];
  if (!isObject(discovery) || !isObject(discovery["info"])) throw new Error("no bazaar info");
  expect(isObject(discovery["info"]["input"])).toBe(true);
  expect(isObject(discovery["info"]["output"])).toBe(true);
  expect(discovery["schema"]).toBeTruthy();
});

// ------------------------------------------------------------------ the half a person sees

/**
 * A reputation record quotes a `/run` URL on chain, permanently, and a tournament link gets pasted
 * into chats. Those addresses are opened by people, and every one of them used to answer JSON.
 *
 * The rule these pin is that adding the page took nothing away: an agent asks for anything other
 * than HTML and gets byte-for-byte what it got before.
 */
const browser = <P extends string>(path: string, params: Record<string, string> = {}): Bun.BunRequest<P> =>
  asRoute<P>(path, params, { asBrowser: true });

test("a browser gets a page, and an agent gets the same JSON it always got", async () => {
  const app = build();

  const page = await app["/"](browser("/"));
  expect(page.headers.get("content-type")).toContain("text/html");
  const markup = await page.text();
  expect(markup.startsWith("<!doctype html>")).toBe(true);
  // What somebody handed the link cold has to learn: that it is a maze, that they cannot play it
  // themselves, and what a perfect run looks like. Asserted instead of the old headline, which
  // pinned a sentence rather than a fact and broke the moment the copy improved.
  expect(markup).toContain("there is no button here");
  // The benchmark, named rather than implied. It used to read "12 steps is perfect", which a
  // stranger cannot decode: neither what is perfect nor what it is perfect at. The fact is what
  // matters, so that is what is asserted.
  expect(markup).toContain("shortest way out");
  // And the maze is on the page — playing itself. It is a maze game, and its front page
  // had no maze in it at all.
  expect(markup).toContain('id="stage-svg"');

  const forAgents = await app["/"](asRoute("/", {}));
  expect(forAgents.headers.get("content-type")).toContain("application/json");
  expect((await bodyOf(forAgents))["prices"]).toBeDefined();
});

test("the board and a round render for a person without changing what an agent reads", async () => {
  const app = build();
  const roundId = roundIdAt();

  const allTime = await app["/board"](browser("/board"));
  expect(allTime.headers.get("content-type")).toContain("text/html");
  expect(await allTime.text()).toContain("Least spent");

  const thisRound = await app["/round/:id"](browser(`/round/${roundId}`, { id: roundId }));
  expect(thisRound.headers.get("content-type")).toContain("text/html");
  expect(await thisRound.text()).toContain(roundId);

  const asJson = await bodyOf(await app["/board"](asRoute("/board", {})));
  expect(objectsIn(asJson["boards"])).toHaveLength(2);
});

test("the run page shows the maze and the charge, since that link is on chain forever", async () => {
  const app = build();
  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  const page = await app["/run/:id"](browser(`/run/${run}`, { id: run }));
  const markup = await page.text();
  expect(markup).toContain("<svg class=\"maze\"");  // the maze, drawn
  expect(markup).toContain("$0.002");                // what it cost
  expect(markup).toContain(`/run/${run}/verify`);    // and how to check it

  // The drawing must never carry a wall this run has not paid for. One look settles four walls,
  // so all but a handful of the inner walls are still untested and must render as such.
  const untested = (markup.match(/class="fog"/g) ?? []).length;
  expect(untested).toBe(1);                          // one path holds all of them

  // The machine-readable record is untouched, digest and all.
  const record = await bodyOf(await app["/run/:id"](asRoute(`/run/${run}`, { id: run })));
  expect(String(record["digest"])).toMatch(/^0x[0-9a-f]{64}$/);
});

test("GET /game explains itself instead of answering 404", async () => {
  const app = build();
  const refused = await app["/game"].GET(asRoute("/game", {}));
  expect(refused.status).toBe(405);
  expect(String((await bodyOf(refused))["error"])).toContain("POST");

  // And a person who typed it into a browser gets somewhere useful.
  const page = await app["/game"].GET(browser("/game"));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
});

test("nothing a visitor controls reaches the page unescaped", async () => {
  const app = build();
  const nasty = "<script>alert(1)</script>";
  const missing = await app["/round/:id"](browser(`/round/${nasty}`, { id: nasty }));
  // An unknown round is refused outright, which is the strongest answer available.
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain("<script>alert");
});

/**
 * The index used to be a hand-written list of four endpoints out of ten, and the one it left out
 * was GET /game/:id — how you see the state of your own run, which is the first thing anyone asks.
 * Prose drifts from code silently; this makes it fail loudly instead.
 */
test("every route the server answers is documented, and nothing documented is missing", () => {
  const app = build();

  const served = new Set<string>();
  for (const [path, handler] of Object.entries(app)) {
    if (typeof handler === "function") served.add(`GET ${path}`);
    else for (const method of Object.keys(handler)) served.add(`${method} ${path}`);
  }
  // GET /game exists only to explain that starting a run is a POST; it is not part of the surface.
  served.delete("GET /game");

  const documented = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));

  expect([...served].filter((r) => !documented.has(r)).sort())
    .toEqual([]);
  expect([...documented].filter((r) => !served.has(r)).sort())
    .toEqual([]);
});

test("the index lists them all, in both the page and the JSON", async () => {
  const app = build();

  const body = await bodyOf(await app["/"](asRoute("/", {})));
  expect(objectsIn(body["endpoints"])).toHaveLength(ENDPOINTS.length);

  const markup = await (await app["/"](browser("/"))).text();
  for (const e of ENDPOINTS) expect(markup).toContain(e.path);
});

// ------------------------------------------------------------------ the live round

/**
 * The stream is what makes the video show the thing happening rather than cut to a result. The
 * two failure modes worth pinning are that it forwards somebody else's round, and that it never
 * lets go — a listener and a timer per viewer, outliving every connection.
 */
const watching = (app: ReturnType<typeof routes>, roundId: string, signal?: AbortSignal) => {
  const request = Object.assign(
    new Request(`http://maze.test/round/${roundId}/stream`, signal ? { signal } : {}),
    { params: { id: roundId } },
  ) as Bun.BunRequest<"/round/:id/stream">;
  return app["/round/:id/stream"](request);
};

test("the stream announces itself as claims, before anything happens", async () => {
  const app = build();
  const response = await watching(app, roundIdAt());
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("claimed, not settled");
  await reader.cancel();
});

test("a round that never happened is refused rather than streamed", async () => {
  const app = build();
  const response = await watching(app, "not-a-round");
  expect(response.status).toBe(404);
});

test("a purchase reaches the watcher, naming the batch and never claiming it settled", async () => {
  const live = feed();
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")), live });

  const heard: string[] = [];
  live.subscribe((e) => heard.push(e.kind));

  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  expect(heard).toEqual(["started", "bought"]);
});

test("solving publishes the finish, so a watcher sees the run end", async () => {
  const live = feed();
  const app = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")), live,
  });
  const seen: string[] = [];
  live.subscribe((e) => seen.push(e.kind));

  const run = await startRun(app);
  for (const dir of round(roundIdAt()).optimalRoute) {
    await app["/game/:id/move"].POST(
      asRoute(`/game/${run}/move?dir=${dir}`, { id: run }, { method: "POST", paying: true }),
    );
  }
  expect(seen.at(-1)).toBe("finished");
});

/**
 * The leak. Every viewer adds a listener and an interval, and a page left open on a phone that
 * sleeps never disconnects politely — the abort is what cleans up. Without it a long demo
 * accumulates one of each per visit.
 */
test("a viewer that leaves is forgotten, listener and timer both", async () => {
  const live = feed();
  const app = routes({ seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")), live });

  const leaving = new AbortController();
  const response = await watching(app, roundIdAt(), leaving.signal);
  const reader = response.body!.getReader();
  await reader.read();                       // let the stream start and subscribe
  expect(live.watching).toBe(1);

  leaving.abort();
  await new Promise((r) => setTimeout(r, 10));
  expect(live.watching).toBe(0);

  await reader.cancel().catch(() => {});
});

test("watchers of another hour are not shown this one", async () => {
  const live = feed();
  const app = routes({ seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")), live });

  const elsewhere: string[] = [];
  live.subscribe((e) => { if (e.round === "2026-09-07T00") elsewhere.push(e.kind); });

  await startRun(app);   // starts in the current round, not that one
  expect(elsewhere).toEqual([]);
});

/**
 * A client can be gone before the handler even runs. Then `abort` never fires again, so the
 * listener and the heartbeat would be registered against a connection that no longer exists —
 * a leak that no amount of watching the happy path would reveal.
 */
test("a viewer that left before the stream opened is never subscribed at all", async () => {
  const live = feed();
  const app = routes({ seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")), live });

  const gone = new AbortController();
  gone.abort();
  const response = await watching(app, roundIdAt(), gone.signal);
  await response.body?.getReader().read().catch(() => undefined);

  expect(live.watching).toBe(0);
});

/**
 * `enqueue` throws once the stream is gone, and the heartbeat calls it from a timer where an
 * exception is uncaught rather than handled. Publishing after the viewer has left must be quiet.
 */
test("writing to a stream whose viewer has gone does not throw", async () => {
  const live = feed();
  const app = routes({ seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")), live });

  const leaving = new AbortController();
  const response = await watching(app, roundIdAt(), leaving.signal);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  leaving.abort();
  await new Promise((r) => setTimeout(r, 10));

  // Anything still publishing into the closed stream must be absorbed, not thrown.
  expect(() => live.publish({
    kind: "started", round: roundIdAt(), run: "after-the-fact", at: { x: 0, y: 0 },
  })).not.toThrow();
  expect(live.watching).toBe(0);
});

/**
 * A spectator arriving between payments must not be shown an empty screen while a round is in
 * progress. `kuira-offer-links` records this as load-bearing: replay the standing state, then
 * stream deltas.
 */
test("a viewer arriving mid-round is sent what is already true, before any delta", async () => {
  const live = feed();
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")), live });

  // A run happens before anyone is watching.
  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  const response = await watching(app, roundIdAt());
  const reader = response.body!.getReader();
  let text = "";
  for (let i = 0; i < 2; i++) text += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  await reader.cancel();

  expect(text).toContain("event: standing");
  const standing: unknown = JSON.parse(text.split("data: ")[1]?.split("\n")[0] ?? "");
  if (!isObject(standing)) throw new Error("no standing payload");
  expect(standing["optimalSteps"]).toBe(round(roundIdAt()).optimalSteps);
  expect(objectsIn(standing["runs"])).toHaveLength(1);
  expect(objectsIn(standing["runs"])[0]?.["spentUsd"]).toBe(0.002);
});

// ------------------------------------------------------------------ the link is the product

/**
 * Nothing on Arc indexes sellers, so a pasted URL is the whole of discovery. What matters is what
 * that URL becomes in a chat window — and that it tells the truth about a round that has ended.
 */
test("a round's link carries an unfurl, with the numbers rather than adjectives", async () => {
  const app = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")),
    publicUrl: "https://maze.example",
  });
  const id = roundIdAt();
  const markup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();

  expect(markup).toContain('property="og:title"');
  expect(markup).toContain('property="og:url" content="https://maze.example/round/');
  expect(markup).toContain("tenth of a cent");
  expect(markup).toContain(String(round(id).optimalSteps));
});

/**
 * A card that promises an image and cannot serve one unfurls worse than a card that never
 * promised. Without a public url there is no absolute address to give, so it says nothing.
 */
test("with nowhere to serve an image from, the card does not promise one", async () => {
  const app = build();               // no publicUrl
  const id = roundIdAt();
  const markup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();

  expect(markup).toContain('name="twitter:card" content="summary"');
  expect(markup).not.toContain("og:image");
});

test("the card is a self-contained image, with nothing to fetch", async () => {
  const app = build();
  const id = roundIdAt();
  const response = await app["/round/:id/card.svg"](asRoute(`/round/${id}/card.svg`, { id }));

  expect(response.headers.get("content-type")).toContain("image/svg+xml");
  const svg = await response.text();
  expect(svg.startsWith("<svg")).toBe(true);
  // A crawler renders it in isolation: no stylesheet, no font file, no second request. The only
  // URL permitted is the SVG namespace, which is an identifier rather than something fetched.
  expect(svg).not.toContain("<link");
  expect(svg).not.toContain("<image");
  expect(svg).not.toContain("xlink:href");
  expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http");
});

/**
 * Drawn directly rather than through the route, because a closed round cannot be reached from a
 * freshly started server: FIRST_ROUND defaults to the round the process booted in, so nothing
 * earlier exists. That is its own problem, recorded separately; the card's honesty is testable
 * without it.
 */
test("a closed round says so on its card, rather than advertising a race that ended", () => {
  const it = round(roundIdAt());
  const boards = boardsFor(it.id, []);

  // Half past the hour: open, with half of it left.
  const halfway = it.openedAt.getTime() + 30 * 60_000;
  const live = cardSvg(it, true, boards, halfway);
  expect(live).toContain("● open");
  expect(live).toContain("30 min left");

  const closed = cardSvg(it, false, boards, it.closesAt.getTime() + 60_000);
  expect(closed).toContain("● closed");
  expect(closed).not.toContain("min left");
});

/**
 * The ring's meaning everywhere else is a limit and how much of it is gone. On a card the limit is
 * the hour, which costs no chain call and is true at the moment a crawler fetches it — and it turns
 * the accent into a warning exactly when the round is nearly over, which is the one thing somebody
 * seeing a pasted link needs before clicking.
 */
test("the card's ring fills with the hour, and colours only when the round is nearly done", () => {
  const it = round(roundIdAt());
  const boards = boardsFor(it.id, []);
  const at = (minutes: number) => cardSvg(it, true, boards, it.openedAt.getTime() + minutes * 60_000);

  // Just opened: the ring is drawn but essentially empty, and in ordinary ink.
  expect(at(1)).toContain(PAPER.text);
  expect(at(1)).not.toContain(`stroke="${PAPER.signal}"`);

  // Nearly over: the colour reserved for what matters arrives.
  expect(at(58)).toContain(`stroke="${PAPER.signal}"`);

  // A closed round shows a full ring, not an empty one.
  const done = cardSvg(it, false, boards, it.closesAt.getTime() + 60_000);
  expect(done).toContain("this round has closed");
});

test("the card resolves its colours to literals, since a crawler has no stylesheet", () => {
  const it = round(roundIdAt());
  const svg = cardSvg(it, true, boardsFor(it.id, []));
  expect(svg).not.toContain("var(--");
  expect(svg).toContain(PAPER.ground);
});

test("the favicon is one file that answers both themes", () => {
  const svg = faviconSvg();
  expect(svg).toContain("prefers-color-scheme:dark");
  expect(svg).toContain(PAPER.text);
  expect(svg).toContain(MACHINE.text);
  expect(svg).not.toContain("var(--");
});

test("a round that never happened has no card", async () => {
  const app = build();
  const response = await app["/round/:id/card.svg"](asRoute("/round/nope/card.svg", { id: "nope" }));
  expect(response.status).toBe(404);
});

/**
 * A run's action list has no upper bound: wandering instead of solving is a legitimate, if silly,
 * way to play, and each action only costs a tenth of a cent. Five thousand of them is a $5 run
 * and a quarter-megabyte record — which must not become a quarter-megabyte table in a page.
 */
test("a run with thousands of actions renders a readable page, not all of them", async () => {
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")) });

  const run = store.start({ roundId: roundIdAt(), payer: PAYER });
  for (let i = 0; i < 500; i++) move(run, "n", false);

  const markup = await (await app["/run/:id"](browser(`/run/${run.id}`, { id: run.id }))).text();
  const rows = (markup.match(/<td class="rank">/g) ?? []).length;

  expect(rows).toBeLessThanOrEqual(60);
  expect(markup).toContain("500 paid actions");   // the total is still told truthfully
  expect(markup).toContain("last 60 shown");
});

/**
 * The boards ask every run how many of its payments were accepted into a batch. Counting that from
 * the action list made a public, uncached endpoint cost O(every action ever taken) per request —
 * work an attacker funds once at a tenth of a cent an action and everybody pays for repeatedly.
 */
test("a settlement count does not depend on the length of the action list", async () => {
  const store = new RunStore();
  const app = routes({ seller: SELLER, runs: runsInMemory(store), paywall: new Paywall(facilitator("valid")) });

  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  const record = await bodyOf(await app["/run/:id"](asRoute(`/run/${run}`, { id: run })));
  expect(record["settlements"]).toBe(1);
});

/**
 * The brand has to be on every page, not on the ones somebody remembered.
 *
 * It was applied as tokens only — colours and type, no mark anywhere a person could see — and the
 * pages read as an unstyled document with a tidy palette. Asserting it here rather than trusting
 * a screenshot: a masthead added to one page and forgotten on another is exactly the drift a
 * shared shell exists to prevent, and nothing else in this suite would notice.
 */
test("every page a person can open carries the mark and the wordmark", async () => {
  const app = build();
  const roundId = roundIdAt();

  // Every page a person can open, including the run page — which is the one an on-chain
  // reputation record points at forever, and the one the first version of this test forgot.
  const created = await app["/game"].POST(asRoute("/game", {}));
  const runId = String((await created.json() as Record<string, unknown>)["run"]);

  const pages: readonly [string, Response][] = [
    ["/", await app["/"](browser("/"))],
    ["/board", await app["/board"](browser("/board"))],
    [`/round/${roundId}`, await app["/round/:id"](browser(`/round/${roundId}`, { id: roundId }))],
    [`/run/${runId}`, await app["/run/:id"](browser(`/run/${runId}`, { id: runId }))],
  ];

  for (const [where, response] of pages) {
    const markup = await response.text();
    expect({ where, masthead: markup.includes('class="masthead"') }).toEqual({ where, masthead: true });
    expect({ where, wordmark: markup.includes("Toll") }).toEqual({ where, wordmark: true });
    // The mark itself, not merely a heading that says the name.
    expect({ where, mark: markup.includes('class="ring"') }).toEqual({ where, mark: true });
    // And it goes home, so the wordmark is a way back rather than a label.
    expect({ where, home: markup.includes('<a href="/">') }).toEqual({ where, home: true });
  }
});

/**
 * The mark means something, and a closed round is the case where that is easiest to check: the hour
 * is entirely gone, so the ring is full and reaches for the colour reserved for what matters. A
 * mark that draws the same picture whatever the state is decoration, which is the one thing the
 * brand notes say it must not be.
 */
test("the mark reads the round's remaining hour rather than being decoration", async () => {
  const app = build();
  const closed = "2026-09-01T00";
  const markup = await (await app["/round/:id"](browser(`/round/${closed}`, { id: closed }))).text();

  expect(markup).toContain("this round has closed");
  expect(markup).toContain("var(--signal)");

  const open = roundIdAt();
  const live = await (await app["/round/:id"](browser(`/round/${open}`, { id: open }))).text();
  expect(live).toContain("minutes left in this round");
});

/**
 * A page with nothing to measure gets the closed ring, not an empty gauge.
 *
 * `arcRing(0)` on the all-time board rendered as a hollow circle: it read as a control that had
 * failed to load, and it claimed "nought spent" about a page that is not about a spend. The mark
 * has to be either a reading or the logo, and which one it is has to be a decision.
 */
test("the mark is a reading where there is one, and the plain mark where there is not", async () => {
  const app = build();
  const roundId = roundIdAt();

  const board = await (await app["/board"](browser("/board"))).text();
  expect(board).toContain('aria-label="Toll"');
  // Not a gauge sitting at nought, which is what it used to be.
  expect(board).not.toContain("% spent");
  expect(board).not.toContain("stroke-dasharray");

  // A run page measures the maze it has paid to establish.
  const created = await app["/game"].POST(asRoute("/game", {}));
  const runId = String((await created.json() as Record<string, unknown>)["run"]);
  const run = await (await app["/run/:id"](browser(`/run/${runId}`, { id: runId }))).text();
  expect(run).toContain("inner walls established");

  // And both pages built around a round measure its hour — the front page included, which the
  // first version of this test left out and a mutation walked straight through.
  const round = await (await app["/round/:id"](browser(`/round/${roundId}`, { id: roundId }))).text();
  expect(round).toContain("minutes left in this round");
  const front = await (await app["/"](browser("/"))).text();
  expect(front).toContain("minutes left in this round");
});

/**
 * The two representations of one URL must agree on what the thing is called.
 *
 * After the rename a person saw "Toll" on every surface and an agent saw an unnamed maze: the JSON
 * carried a description and no name at all. Same address, same product, two answers.
 */
test("a person and an agent are told the same name", async () => {
  const app = build();
  const page = await (await app["/"](browser("/"))).text();
  const forAgents = await bodyOf(await app["/"](asRoute("/", {})));

  expect(forAgents["name"]).toBe("Toll");
  expect(page).toContain("Toll");
});

/**
 * The getting-started block, which is the only instruction on the page.
 *
 * It replaced a paragraph that narrated what an agent would do — interesting to read, useless to
 * act on. What a person needs is the words to paste, because a bare link does not work: an agent
 * handed a URL reads the page and stops, since nothing told it to play.
 */
test("the front page hands a person something to paste, not a description", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();

  // The prompt itself, and a way to take it.
  expect(markup).toContain('id="prompt"');
  expect(markup).toContain('data-copy="prompt"');
  expect(markup).toContain("Solve the maze at");
  // The agent's first call, named — the question "what does it do first" answered on the page.
  expect(markup).toContain("POST /game");
});

/**
 * And the same first move is told to the agent directly, not left to be inferred from a table of
 * paths. An agent that arrives with no prompt should still know what winning is and where to start.
 */
test("an agent is told the goal and the first call, not just the routes", async () => {
  const app = build();
  const body = await bodyOf(await app["/"](asRoute("/", {})));

  expect(String(body["goal"])).toContain("exit");
  const start = body["start"] as Record<string, unknown>;
  expect(start["method"]).toBe("POST");
  expect(start["path"]).toBe("/game");
});

/**
 * An inline script must come after everything it reaches for.
 *
 * The animator sits in the markup rather than in a deferred file, so it runs the moment the parser
 * meets it. Placed above the counter it drives, `getElementById` returned null, its own guard
 * returned early, and the replay silently did not play — no error, no warning, just a still maze.
 * Nothing else in this suite would notice, because the markup is all present and correct.
 */
test("the replay's script comes after the elements it drives", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();

  // A marker unique to the animator, and one that survives compilation: the data it reads now
  // travels as JSON in its own block, so there is no `var frames =` to look for any more.
  const script = markup.indexOf("visibilitychange");
  expect(script).toBeGreaterThan(-1);

  for (const id of ['id="stage-svg"', 'id="agent"', 'id="spend"', 'id="replay-data"']) {
    const element = markup.indexOf(id);
    expect({ id, found: element > -1 }).toEqual({ id, found: true });
    expect({ id, beforeScript: element < script }).toEqual({ id, beforeScript: true });
  }
});

/**
 * And the same for the copy button, which had the ordering right by accident rather than by rule.
 */
test("the copy script comes after the prompt it copies", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();
  expect(markup.indexOf('id="prompt"')).toBeLessThan(markup.indexOf("navigator.clipboard"));
  expect(markup.indexOf('data-copy="prompt"')).toBeLessThan(markup.indexOf("navigator.clipboard"));
  // The install line is copied by the same script, so it has to be on the page before it too.
  expect(markup.indexOf('data-copy="install"')).toBeLessThan(markup.indexOf("navigator.clipboard"));
});

/**
 * The person's path, in order, on the page they land on.
 *
 * The page used to say what not to do and give the sentence for the last step, and nothing else:
 * someone who landed here cold could not tell that an app came first, or that their agent needed
 * connecting before anything could be granted. The steps are one definition, so the page cannot
 * lose one or put them out of order without this noticing.
 */
test("the front page lays out the five steps in order, each on the device it happens on", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();

  let last = -1;
  for (const step of STEPS) {
    const at = markup.indexOf(step.title);
    expect({ title: step.title, found: at > -1 }).toEqual({ title: step.title, found: true });
    expect({ title: step.title, inOrder: at > last }).toEqual({ title: step.title, inOrder: true });
    last = at;
  }
  // Step 2's line to copy, and the anchor the refusal points agents at.
  expect(markup).toContain('data-copy="install"');
  expect(markup).toContain('id="how"');
});

/**
 * An agent is told the same path, before it has paid for anything.
 *
 * Otherwise it learns that its owner has not granted it anything from a refused payment, and the
 * person watching learns it from whatever the agent makes of the refusal.
 */
test("an agent is served the person's five steps, and told to check before paying", async () => {
  const app = build();
  const body = await bodyOf(await app["/"](asRoute("/", {})));

  const setup = body["setup"] as { step: number; title: string; where: string }[];
  expect(setup.map((s) => s.title)).toEqual(STEPS.map((s) => s.title));
  expect(setup.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
  expect(String(body["beforePaying"])).toContain("allowance");
});

/**
 * The sentence a person copies names the right maze: theirs on a laptop, the public one otherwise.
 *
 * It used to name whatever address the page was opened at, so a visitor who came in through a
 * deployment URL copied a sentence pointing at an address of the moment. And a public address
 * would be wrong for someone running the maze on their own machine, whose agent has to be sent to
 * their own copy.
 */
test("the sentence to copy names the public maze, or the local one when run locally", async () => {
  const app = routes({
    seller: SELLER, runs: runsInMemory(), paywall: new Paywall(facilitator("valid")),
    publicUrl: "https://maze.example",
  });
  const pageAt = async (url: string): Promise<string> =>
    (await app["/"](new Request(url, { headers: { accept: "text/html" } }))).text();

  expect(await pageAt("http://maze.test/")).toContain("Solve the maze at https://maze.example/ ");
  expect(await pageAt("https://maze-git-abc.vercel.app/")).toContain("Solve the maze at https://maze.example/ ");
  expect(await pageAt("http://localhost:4319/")).toContain("Solve the maze at http://localhost:4319/ ");
});

// ---- where runs are kept, and what a solve earns -----------------------------

/** A facilitator that accepts every payment from one payer. */
const payingAs = (payer: string, onSettle: () => void = () => {}) => new Paywall({
  verify: async () => ({ isValid: true, payer }),
  settle: async () => {
    onSettle();
    return { success: true, transaction: "b", payer, network: "eip155:5042002" };
  },
});

/** Walk the current round's best route as a paying agent with an identity; hand back the last answer. */
async function solveThrough(app: ReturnType<typeof routes>): Promise<{ readonly id: string; readonly last: Response }> {
  const created = await app["/game"].POST(asRoute("/game?agent=42", {}, { method: "POST" }));
  const id = String((await created.json() as Record<string, unknown>)["run"]);
  let last = new Response(null, { status: 599 });
  for (const dir of round(roundIdAt()).optimalRoute) {
    last = await app["/game/:id/move"].POST(
      asRoute(`/game/${id}/move?dir=${dir}`, { id }, { method: "POST", paying: true }));
  }
  return { id, last };
}

const writingTo = (written: string[]) => ({
  write: async (agentId: bigint, _record: unknown, url: string) => {
    written.push(url);
    return { agentId, value: 100, hash: "0xfeed" as `0x${string}` };
  },
});

/**
 * The bug that lost a reward on 10 September. The payout started after the solving step had answered,
 * on a host that stops once it has answered, so it never ran. Now the step waits, and its answer says
 * what was earned, so the agent can tell its owner.
 */
test("the solving step waits for the reward, and says what the run earned", async () => {
  const written: string[] = [];
  const holder = "0xc3BB7bc7E375f7ffA34E652F560Dc802F7A76cFa";
  const app = routes({
    seller: SELLER, publicUrl: "https://toll.test",
    verifyIdentity: async () => true,
    scribe: writingTo(written),
    registrar: { admit: async () => ({ holder: holder as `0x${string}`, tokenId: 7n, hash: "0xbadge" as `0x${string}` }) },
    paywall: payingAs("0x1111111111111111111111111111111111111111"),
  });

  const { id, last } = await solveThrough(app);
  const answer = await bodyOf(last);
  expect(answer["outcome"]).toBe("solved");
  expect(answer["reward"]).toEqual({
    reputation: { status: "given", score: 100, tx: "0xfeed" },
    badge: { status: "given", number: "7", holder, tx: "0xbadge" },
  });
  // Nothing to wait for afterwards: by the time the step answered, the record was on chain.
  expect(written).toEqual([`https://toll.test/run/${id}`]);
});

/**
 * The ordering the reward depends on. The record on chain quotes the run's address and commits to its
 * digest, so the run is written down, and waited for, before anything cites it. A record citing a
 * run nobody can fetch is worse than none: it reads as evidence and is not.
 */
test("a solve that could not be written down is never cited on chain, and the payment is named", async () => {
  const written: string[] = [];
  const app = routes({
    seller: SELLER, publicUrl: "https://toll.test",
    runs: {
      ...runsInMemory(),
      save: async (run) => { if (run.outcome === "solved") throw new Error("the store is having a bad minute"); },
    },
    verifyIdentity: async () => true,
    scribe: writingTo(written),
    paywall: payingAs("0x3333333333333333333333333333333333333333"),
  });

  const { last } = await solveThrough(app);
  expect(last.status).toBe(503);
  expect((await bodyOf(last))["settlement"]).toBe("b");
  expect(written).toEqual([]);
});

/**
 * Not "not found", which the archive used to answer: a reader following a reputation record would
 * conclude it cites nothing. And not an empty board, which would say nobody has played.
 */
test("a store that does not answer says so, rather than saying the run does not exist", async () => {
  const down = async (): Promise<never> => { throw new Error("the store is having a bad minute"); };
  const app = routes({
    seller: SELLER, runs: { ...runsInMemory(), get: down, record: down, every: down, inRound: down },
  });
  const id = "25b9f044-09da-49bb-8545-04f46efc03de";

  expect((await app["/run/:id"](asRoute(`/run/${id}`, { id }))).status).toBe(503);
  const page = await app["/run/:id"](browser(`/run/${id}`, { id }));
  expect(page.status).toBe(503);
  expect(await page.text()).toContain("Not readable just now");
  expect((await app["/board"](asRoute("/board", {}))).status).toBe(503);
  expect((await app["/runs"](asRoute("/runs", {}))).status).toBe(503);

  // The front page still renders, and says the boards could not be read instead of drawing empty ones.
  const front = await (await app["/"](browser("/"))).text();
  expect(front).toContain("could not be read just now");
  expect(front).not.toContain("nobody has solved it");
});

test("a store that does not answer before the payment costs the agent nothing", async () => {
  let settled = 0;
  const trouble = async (): Promise<never> => { throw new Error("the store is having a bad minute"); };
  for (const broken of [{ hold: trouble }, { claim: trouble }]) {
    const app = routes({
      seller: SELLER, runs: { ...runsInMemory(), ...broken },
      paywall: payingAs(PAYER, () => { settled += 1; }),
    });
    const id = await startRun(app);
    const answer = await app["/game/:id/look"](asRoute(`/game/${id}/look`, { id }, { paying: true }));
    expect(answer.status).toBe(503);
  }
  expect(settled).toBe(0);
});

test("every run anybody paid for is listed, newest first, and a free start is not", async () => {
  const app = build();
  const first = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${first}/look`, { id: first }, { paying: true }));
  await startRun(app);                                   // started, never paid for
  await new Promise((r) => setTimeout(r, 5));            // so the next one starts later
  const second = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${second}/look`, { id: second }, { paying: true }));

  const body = await bodyOf(await app["/runs"](asRoute("/runs", {})));
  expect(objectsIn(body["runs"]).map((r) => r["id"])).toEqual([second, first]);
  expect(body["count"]).toBe(2);

  const page = await (await app["/runs"](browser("/runs"))).text();
  expect(page).toContain(`/run/${second}`);
  expect(page).toContain("2 in all");
});

test("a run started and never paid for is on no board", async () => {
  const app = build();
  await startRun(app);
  const id = roundIdAt();
  const body = await bodyOf(await app["/round/:id"](asRoute(`/round/${id}`, { id })));
  expect(objectsIn(body["runs"])).toEqual([]);
});

test("the front page says what a round, a run and a board are, and where each list is", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();
  for (const term of TERMS) expect(markup).toContain(`<dt>${term.word}</dt>`);
  expect(markup).toContain(`href="/round/${roundIdAt()}"`);
  expect(markup).toContain('href="/board"');
  expect(markup).toContain('href="/runs"');

  // And an agent is told the same three words.
  expect((await bodyOf(await app["/"](asRoute("/", {}))))["terms"]).toEqual(TERMS);
});

test("the pages stop calling a run a game, and stop promising to forget", async () => {
  const app = build();
  const id = roundIdAt();
  const roundMarkup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();
  expect(roundMarkup).not.toContain("is the game");
  expect(roundMarkup).toContain("A run is one agent");

  const boardMarkup = await (await app["/board"](browser("/board"))).text();
  expect(boardMarkup).not.toContain("in memory");
  expect(boardMarkup).toContain("Every run of every round");

  // The front page's boards are drawn once when it loads. The live stream still is live, and says so.
  expect(await (await app["/"](browser("/"))).text()).not.toContain("This round, as it happens");
});

// ---- the badge, where the contract says it is ---------------------------------

const BADGE_HOLDER = "0xc3BB7bc7E375f7ffA34E652F560Dc802F7A76cFa" as `0x${string}`;
const BADGE_CONTRACT = "0xe5a8faef7139d04582c7e17c3f615710343b53a3" as `0x${string}`;

/**
 * The badge contract as the chain answers it: one badge taken, number 1. The real reader needs Arc,
 * and a test suite that needs a chain fails on a train.
 */
const oneBadge = (overrides: Partial<Roster> = {}): Roster => ({
  contract: BADGE_CONTRACT,
  holderOf: async (tokenId) => (tokenId === 1n ? BADGE_HOLDER : null),
  taken: async () => ({ minted: 1, of: 100 }),
  ...overrides,
});

/**
 * The contract's `tokenURI` is this address, and a wallet showed a broken image because nothing
 * answered here. What it needs is ERC-721 metadata with a picture it can draw on its own.
 */
test("a wallet asking for a badge gets its name, its place and a picture it can draw alone", async () => {
  const app = routes({ seller: SELLER, roster: oneBadge(), publicUrl: "https://toll.test" });
  const answer = await app["/badge/:id"](asRoute("/badge/1", { id: "1" }));
  expect(answer.status).toBe(200);

  const body = await bodyOf(answer);
  expect(body["name"]).toBe("Cohort Zero #1");
  expect(body["external_url"]).toBe("https://toll.test/badge/1");
  expect(body["attributes"]).toEqual([{ trait_type: "Place", value: 1, max_value: 100 }]);

  const image = String(body["image"]);
  expect(image.startsWith("data:image/svg+xml;base64,")).toBe(true);
  const svg = Buffer.from(image.slice(image.indexOf(",") + 1), "base64").toString();
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain(">001<");
  // A wallet has no stylesheet, so every colour must already be a colour.
  expect(svg).not.toContain("var(--");
});

test("a badge nobody holds is not described, and the one that exists has a page", async () => {
  const app = routes({ seller: SELLER, roster: oneBadge() });
  expect((await app["/badge/:id"](asRoute("/badge/2", { id: "2" }))).status).toBe(404);
  expect((await app["/badge/:id"](asRoute("/badge/01", { id: "01" }))).status).toBe(404);
  expect((await routes({ seller: SELLER })["/badge/:id"](asRoute("/badge/1", { id: "1" }))).status).toBe(404);

  const markup = await (await app["/badge/:id"](browser("/badge/1", { id: "1" }))).text();
  expect(markup).toContain("Cohort Zero #1");
  expect(markup).toContain(BADGE_HOLDER);
  expect(markup).toContain(`testnet.arcscan.app/token/${BADGE_CONTRACT}/instance/1`);
});

test("when Arc does not answer, a badge says so rather than that it does not exist", async () => {
  const app = routes({
    seller: SELLER,
    roster: oneBadge({ holderOf: async () => { throw new Error("the RPC is having a bad minute"); } }),
  });
  expect((await app["/badge/:id"](asRoute("/badge/1", { id: "1" }))).status).toBe(503);
});

test("the badge count on the front page links to the contract, where anyone can check it", async () => {
  const app = routes({ seller: SELLER, roster: oneBadge() });
  // The count is read in the background when the server starts, so it is there from the next turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const markup = await (await app["/"](browser("/"))).text();
  expect(markup).toContain(`href="https://testnet.arcscan.app/token/${BADGE_CONTRACT}"`);
});

// ---- pages where a person used to get JSON --------------------------------------

test("replaying a run in a browser shows a page, and an agent still gets the verdict", async () => {
  const app = build();
  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  const page = await (await app["/run/:id/verify"](browser(`/run/${run}/verify`, { id: run }))).text();
  expect(page).toContain("it holds up");
  expect((await bodyOf(await app["/run/:id/verify"](asRoute(`/run/${run}/verify`, { id: run }))))["ok"]).toBe(true);
});

test("an address with nothing behind it is a page for a person and JSON for an agent", async () => {
  const app = build();
  const id = "25b9f044-09da-49bb-8545-04f46efc03de";
  const forPerson = await app["/run/:id"](browser(`/run/${id}`, { id }));
  expect(forPerson.status).toBe(404);
  expect(forPerson.headers.get("content-type")).toContain("text/html");
  expect(await forPerson.text()).toContain("Nothing here");
  expect((await bodyOf(await app["/run/:id"](asRoute(`/run/${id}`, { id }))))["error"]).toBe("no such run");
});

/**
 * A round that moves while somebody watches it.
 *
 * The stream has existed since the round page did and nothing ever opened it: the board was
 * rendered once and then sat still while agents played, so "watch a round" meant "reload and hope".
 *
 * What is asserted is the shape of the fix as much as its presence. The client must not render a
 * board — this module keeps one set of numbers and no second source of truth, and a copy of the
 * ranking in the browser is a copy that disagrees the first time either side is touched. So the
 * stream is a notification and the server still says what the board is.
 */
test("the round page opens its own stream, and the script comes after the board", async () => {
  const app = build();
  const id = roundIdAt();
  const markup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();

  const board = markup.indexOf('id="boards"');
  const script = markup.indexOf("EventSource");
  expect(board).toBeGreaterThan(-1);
  expect(script).toBeGreaterThan(-1);
  // The bug this project already paid for once: a script above the element it drives finds
  // nothing, returns through its own guard, and fails silently.
  expect(board).toBeLessThan(script);

  // It must stream *this* round, not whichever the server happens to think is current.
  expect(markup).toContain(`data-round="${id}"`);
});

/**
 * The client is a notifier, not a renderer.
 *
 * If it ever starts building rows, the board exists in two places and they will drift — which is
 * the one thing `page.ts` says it will not do.
 */
test("the live client refetches the server's board rather than building its own", async () => {
  const app = build();
  const id = roundIdAt();
  const markup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();

  const from = markup.indexOf("EventSource");
  const script = markup.slice(from - 2000, markup.indexOf("</script>", from));

  expect(script).toContain("fetch(");
  expect(script).toContain("DOMParser");
  // No row-building in the browser: these are the server's job.
  expect(script).not.toContain("<tr");
  expect(script).not.toContain("rank");
});

/**
 * `standing` is the state the page was already rendered from.
 *
 * Refetching on it would spend one pointless request per connection — and one more every time the
 * five-minute cut on this host forces a reconnect, which is the opposite of what a reconnect is for.
 */
test("the live client does not refetch the state it was already rendered from", async () => {
  const app = build();
  const id = roundIdAt();
  const markup = await (await app["/round/:id"](browser(`/round/${id}`, { id }))).text();
  const from = markup.indexOf("EventSource");
  const script = markup.slice(from - 2000, markup.indexOf("</script>", from));

  for (const kind of ["started", "bought", "finished"]) expect(script).toContain(kind);
  expect(script).not.toContain('"standing"');
});

/**
 * The heartbeat has to be faster than the thing that hangs up.
 *
 * These two numbers live in different files and were never related to each other: the stream beat
 * every fifteen seconds, and Bun closed an idle connection after ten. So on a quiet round the
 * connection was killed five seconds before the heartbeat that exists to save it — every ten
 * seconds, since the day the stream was written.
 *
 * Nothing looked wrong. `EventSource` reconnects silently, the board was correct either way, and
 * the only trace anywhere was a pair of 503s in a browser's network log. It was found by opening
 * the page in a real browser and reading that log, which is the only place it was visible.
 *
 * Structural, because the pair is a pair: the server derives its timeout from the heartbeat, and a
 * literal in either place is how they drifted the first time.
 */
test("the server's idle timeout is derived from the heartbeat, not written down beside it", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const { HEARTBEAT_MS } = await import("../src/routes.ts");

  expect(server).toContain("HEARTBEAT_MS");
  expect(server).toMatch(/idleTimeout:/);

  // The value handed to Bun must come from the heartbeat rather than be a number that happens to
  // agree with it today.
  const derivation = /const IDLE_TIMEOUT_S = ([^;]+);/.exec(server)?.[1] ?? "";
  expect(derivation).toContain("HEARTBEAT_MS");

  // And it must actually be longer, which is the whole point.
  const seconds = Math.ceil((HEARTBEAT_MS * 2) / 1000);
  expect(seconds * 1000).toBeGreaterThan(HEARTBEAT_MS);
  // Bun refuses anything above 255 seconds, so a heartbeat slow enough to break that is a bug too.
  expect(seconds).toBeLessThanOrEqual(255);
});

/**
 * The page explained what an agent pays and never what lets it pay.
 *
 * A visitor read "give your agent this prompt" and the next question — with whose money, and what
 * stops it — had no answer anywhere on the page. That answer is the entire product: the maze is
 * something to spend on, and the allowance is the thing worth looking at.
 */
test("the front page says what lets an agent spend, not only what it costs", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();

  expect(markup).toContain("Whose money");
  // The mechanism, in the reader's terms: granted by a person, enforced by the chain, revocable.
  expect(markup).toMatch(/granted by/i);
  expect(markup).toMatch(/your phone/i);
  expect(markup).toMatch(/enforced by/i);
  expect(markup).toMatch(/QR/);
  // And the half that makes it a mandate rather than a promise.
  expect(markup).toMatch(/the next step fails/i);
});

/**
 * The audience is people who will want the protocol names, and want them in one line.
 */
test("it answers 'how' with the names a web3 reader is looking for", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();
  for (const name of ["x402", "Gateway", "6900", "8004"]) {
    expect(markup, `${name} is not named anywhere`).toContain(name);
  }
});

/**
 * The install row may look like the one everybody knows. It must not *claim* what that one claims.
 *
 * There is no `eas.json`, no TestFlight and no listing in either store — the app is built from
 * source. The familiar two-up shape is fine and helps a reader place it instantly; what would not
 * be fine is a link into a store, because a judge who clicked it would find nothing.
 *
 * So the rule is about destinations, not vocabulary. Saying "not in the App Store" is the honest
 * sentence; linking to `apps.apple.com` is the dishonest one. An earlier version of this test
 * banned the words and tripped on the page telling the truth, which is the wrong thing to enforce.
 */
test("the install row points at the source, never at a store listing", async () => {
  const app = build();
  const markup = await (await app["/"](browser("/"))).text();

  for (const store of ["apps.apple.com", "play.google.com", "itunes.apple.com", "testflight.apple.com"]) {
    expect(markup, `the page links ${store}, where there is nothing to find`).not.toContain(store);
  }

  // Both platforms are offered, and both go to the source.
  const row = markup.slice(markup.indexOf('class="getit"'), markup.indexOf("</div>", markup.indexOf('class="getit"')));
  expect(row).toContain("iOS");
  expect(row).toContain("Android");
  expect((row.match(/github\.com\/nel349\/arc-agent-mandate/g) ?? []).length).toBe(2);

  // And it says how to actually get it, which is the point of standing where a store badge stands.
  expect(markup).toMatch(/build for|from source|contact the developer/i);
  // Both buttons carry a platform mark rather than a store badge.
  expect((row.match(/class="mark"/g) ?? []).length).toBe(2);
});
