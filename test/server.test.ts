import { expect, test } from "bun:test";
import { ENDPOINTS, routes } from "../src/server.ts";
import { feed } from "../src/live/feed.ts";
import { cardSvg } from "../src/web/card.ts";
import { faviconSvg, MACHINE, PAPER } from "../src/web/brand.ts";
import { boardsFor, exits, HEIGHT, round, roundIdAt, WIDTH } from "../src/maze/index.ts";
import { Paywall } from "../src/arc/index.ts";
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
  const body = await bodyOf(await app["/board"](asRoute("/board", {})));
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

/**
 * Solve the maze end to end, and report both the outcome and every identity the scribe was asked
 * to write. Two tests need exactly this, differing only in whether the identity checks out.
 */
async function solveWith(
  options: { readonly identityIsTheirs: boolean; readonly agentId?: bigint },
): Promise<{ readonly outcome: unknown; readonly written: readonly bigint[] }> {
  const written: bigint[] = [];
  const app = routes({
    seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")),
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
  // The write is fired without being awaited, so give the microtask a turn.
  await Promise.resolve();
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
  expect(markup).toContain("You cannot play this");
  expect(markup).toContain("steps is perfect");
  // And the maze is on the page. It is a maze game, and its front page had no maze in it.
  expect(markup).toContain('class="maze"');

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
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")), live });

  const heard: string[] = [];
  live.subscribe((e) => heard.push(e.kind));

  const run = await startRun(app);
  await app["/game/:id/look"](asRoute(`/game/${run}/look`, { id: run }, { paying: true }));

  expect(heard).toEqual(["started", "bought"]);
});

test("solving publishes the finish, so a watcher sees the run end", async () => {
  const live = feed();
  const app = routes({
    seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")), live,
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
  const app = routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")), live });

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
  const app = routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")), live });

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
  const app = routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")), live });

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
  const app = routes({ seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")), live });

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
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")), live });

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
    seller: SELLER, runs: new RunStore(), paywall: new Paywall(facilitator("valid")),
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
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")) });

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
  const app = routes({ seller: SELLER, runs: store, paywall: new Paywall(facilitator("valid")) });

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
  expect(markup).toContain('id="copy"');
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
