import {
  atExit, board, boardsFor, canMove, claim, digest, EXIT, exists, exits, finish, isDirection,
  isOpen, isRoundId, look, map, move, moved, openings, PRICES, published, render, round, roundIdAt,
  RunStore, verify, type Run,
} from "./maze/index.ts";
import {
  bazaar, belongsTo, Paywall,
  type ChargeOutcome, type Offer, type Registrar, type Scribe,
} from "./arc/index.ts";
import { boardPage, indexPage, roundPage, runPage, wantsHtml } from "./web/page.ts";

/**
 * The routes.
 *
 * Three surfaces share one address, which is the whole distribution strategy: nothing on Arc
 * indexes sellers, so the link has to carry everything. An agent asks for JSON and gets an offer it
 * can act on; a person gets a page; a crawler gets a card. This file is the first of those.
 *
 * Starting a run is free and every action costs. That is deliberate: a paywall on the front door
 * would charge an agent before it could see what it was buying, and the thing being sold here is
 * not access to a maze — it is each step through one.
 */

/**
 * How many runs one payer may take in a single round.
 *
 * Not about cost — every action is already paid for, so flooding is expensive rather than free.
 * It is about a board: one agent with a script could occupy every place on it and turn a
 * leaderboard into a log of one participant. Enough attempts to learn a maze, not enough to own it.
 */
export const RUNS_PER_PAYER_PER_ROUND = 5;

export interface MazeConfig {
  /** Where payments go. */
  readonly seller: string;
  readonly runs?: RunStore;
  readonly paywall?: Paywall;
  /**
   * Writes the reputation when a run is solved. Absent means the maze still works and simply pays
   * out nothing — which is the right default, since a missing key must not stop anyone playing.
   */
  readonly scribe?: Scribe;
  /** Admits solvers to the numbered cohort. Absent means no badges, which stops nobody playing. */
  readonly registrar?: Registrar;
  /** Where a run can be read back. The reputation points here, so it has to be the public one. */
  readonly publicUrl?: string;
  /**
   * Does this agent id really belong to the address that paid?
   *
   * Injectable for the same reason the facilitator is: the real one reads Arc, and a test suite
   * that needs a chain fails on a train.
   */
  readonly verifyIdentity?: (agentId: bigint, payer: string) => Promise<boolean>;
}

/**
 * Every address this server answers, and what it is for.
 *
 * One list, rendered by both the JSON index and the page, because the hand-written version of
 * this drifted immediately: it described four endpoints out of ten, and the one it left out was
 * `GET /game/:id` — the answer to "how do I see the state of my run", which is the first thing
 * anybody asks. A test walks the router and fails if a route is missing from here, so the next
 * route added has to be described before it ships.
 */
export interface Endpoint {
  readonly method: "GET" | "POST";
  /** Exactly as the router declares it, so the two can be compared. */
  readonly path: string;
  readonly what: string;
  /** What it costs, for the ones that charge. */
  readonly price?: number;
}

export const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/", what: "what this is, the round, the prices" },
  { method: "POST", path: "/game", what: "start a run — free, because you cannot price what nobody has seen" },
  { method: "GET", path: "/game/:id", what: "where this run stands: position, steps, spend, outcome" },
  { method: "POST", path: "/game/:id/move", what: "a step: dir=n|s|e|w. A wall still costs you", price: PRICES.move },
  { method: "GET", path: "/game/:id/look", what: "which ways out of the cell you are standing in", price: PRICES.look },
  { method: "GET", path: "/game/:id/map", what: "the whole maze and the grid behind it", price: PRICES.map },
  { method: "GET", path: "/round/:id", what: "one round: its maze, its boards, every run in it" },
  { method: "GET", path: "/board", what: "the all-time boards, across every round still in memory" },
  { method: "GET", path: "/run/:id", what: "one run's record, with the digest the chain commits to" },
  { method: "GET", path: "/run/:id/verify", what: "replay that run and say whether it holds up" },
];

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

/** What an agent is told when it has not paid, or when the payment did not stand up. */
function unpaid(outcome: Exclude<ChargeOutcome, { kind: "paid" }>): Response {
  switch (outcome.kind) {
    case "unpaid":
      return json(
        { error: "payment required", ...outcome.paymentRequired },
        402,
        { "payment-required": b64(outcome.paymentRequired) },
      );
    case "unreadable":
      return json({ error: "the payment header was not readable" }, 400);
    case "refused":
      return json({ error: "payment refused", reason: outcome.reason }, 402);
    case "declined":
      // Either the run is someone else's or this payer has had its turns. Both are the same shape
      // to the caller: verified, not settled, nothing charged.
      return json({
        error: "this run is not available to you",
        detail: `a run belongs to its first payer, and one payer may take ${RUNS_PER_PAYER_PER_ROUND} runs a round`,
      }, 403);
    case "unavailable":
      // Circle is down, not the buyer's problem. A 402 here would send someone to check a wallet
      // that is fine; a 503 says come back, and says it to a retrying agent in the way it expects.
      return json({ error: "the facilitator is unreachable", reason: outcome.reason }, 503, {
        "retry-after": "30",
      });
  }
}

/** A run as the agent playing it should see: where it is, and what it has spent. */
const view = (run: Run) => ({
  run: run.id,
  round: run.roundId,
  agentId: run.agentId === null ? null : run.agentId.toString(),
  at: run.at,
  steps: run.steps,
  spentUsd: run.spentUsd,
  outcome: run.outcome,
});

/**
 * The routes, as a value rather than a running server.
 *
 * Binding a port at import time would make every one of these untestable without a socket and a
 * free port, and would mean a test run that crashes leaves a listener behind. The entry point below
 * is the only thing that listens.
 */
export function routes(config: MazeConfig) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.seller)) {
    throw new Error("seller must be an address for payments to go to");
  }
  const SELLER = config.seller;
  const runs = config.runs ?? new RunStore();
  const paywall = config.paywall ?? new Paywall();
  const scribe = config.scribe;
  const registrar = config.registrar;
  const publicUrl = (config.publicUrl ?? "").replace(/\/$/, "");
  // A reputation record is permanent and quotes a URL. Writing one without knowing our own public
  // address would put a relative path on chain forever, pointing at nothing from anywhere.
  if (scribe !== undefined && publicUrl === "") {
    throw new Error("publicUrl is required when a scribe is configured: the reputation quotes it");
  }
  const verifyIdentity = config.verifyIdentity ?? belongsTo;

  /**
   * One record per agent per round.
   *
   * Nothing stopped an agent solving the same maze repeatedly and collecting a fresh score each
   * time. Each solve costs real money, so it was self-limiting rather than free — but a registry
   * filling with the same claim is noise, and reputation that can be bought in bulk is not
   * reputation. A round is the unit of competition, so it is the unit of the record.
   *
   * Held in memory, which means a restart would allow one more. Stated rather than hidden: the
   * durable fix is to read the agent's existing feedback off the registry before writing, and that
   * costs a chain read on every solve.
   */
  const paidOut = new Set<string>();

  /**
   * Pay out what a solve earns.
   *
   * Deliberately not awaited by the route that triggers it. The agent has finished its maze and is
   * owed an answer; making it wait for a transaction it did not ask for would turn a step into a
   * block-time pause. A failure here loses a record, not a run — the run is already published and
   * verifiable, and the write can be replayed from it.
   */
  function payOutReputation(run: Run): void {
    if (scribe === undefined || run.agentId === null || run.outcome !== "solved") return;
    const once = `${run.agentId}@${run.roundId}`;
    if (paidOut.has(once)) return;
    paidOut.add(once);
    const record = published(run);
    const url = `${publicUrl}/run/${run.id}`;
    const agentId = run.agentId;

    void scribe
      .write(agentId, record, url, digest(record))
      .then((written) => console.log(`reputation: agent ${written.agentId} scored ${written.value} — ${written.hash}`))
      .catch((cause: unknown) => console.error(`reputation write failed for run ${run.id}:`, cause));

    // Separately, and separately allowed to fail: the record is the thing that matters, and a
    // closed cohort or a holder who already has one are ordinary answers rather than problems.
    void registrar?.admit(agentId)
      .then((badge) => {
        if (badge !== null) console.log(`cohort: #${badge.tokenId} to ${badge.holder} — ${badge.hash}`);
      })
      .catch((cause: unknown) => console.error(`badge admission failed for agent ${agentId}:`, cause));
  }

  const offerFor = (
    priceUsd: number, resource: string, description: string, discovery: bazaar.Bazaar,
  ): Offer => ({ priceUsd, payTo: SELLER, resource, description, bazaar: discovery });

  /**
   * Take payment, check the run belongs to the payer, and hand back the run.
   *
   * The claim check is why this is one helper rather than three: a run id travels — in a link, a
   * log, a chat — and without pinning, whoever holds one could spend against somebody else's
   * leaderboard entry. The payment establishes who is playing; everything after is bookkeeping.
   */
  async function paidRun(
    request: Request,
    runId: string,
    offer: Offer,
  ): Promise<{ run: Run; settlement: string | undefined } | { response: Response }> {
    const run = runs.get(runId);
    if (!run) return { response: json({ error: "no such run" }, 404) };
    if (run.outcome !== "running") {
      return { response: json({ error: `this run is already ${run.outcome}` }, 409) };
    }
    // The claim is checked between verifying and settling, so a stranger who pays for a run that
    // is not theirs is refused *before* the money moves. Checking afterwards took the payment and
    // then gave nothing back for it.
    const outcome = await paywall.charge(
      request.headers.get("payment-signature"),
      offer,
      (payer) => {
        if (!claim(run, payer).ok) return false;
        // Checked here, between verifying and settling, so hitting the cap costs nothing.
        return runs.countFor(run.roundId, payer) <= RUNS_PER_PAYER_PER_ROUND;
      },
    );
    if (outcome.kind !== "paid") return { response: unpaid(outcome) };
    const payer = outcome.charged.payer;
    // Check the declared identity once, against whoever actually paid. A declaration nobody checks
    // is an invitation to write reputation onto a stranger's identity.
    if (run.agentId !== null && !(await verifyIdentity(run.agentId, payer))) run.agentId = null;
    return { run, settlement: outcome.charged.settlement };
  }

  return {
    "/": (request: Request) => {
      if (wantsHtml(request)) return html(indexPage(round(roundIdAt()), true, ENDPOINTS));
      return json({
        what: "A maze on Arc that charges by the step, and pays out reputation.",
        round: roundIdAt(),
        prices: PRICES,
        endpoints: ENDPOINTS,
      });
    },

    "/game": {
      /**
       * A person's first guess at a URL, and until now a 404. Starting a run is a POST because it
       * creates one; a GET says so rather than pretending the address is wrong.
       */
      GET: (request: Bun.BunRequest<"/game">) =>
        wantsHtml(request)
          ? html(indexPage(round(roundIdAt()), true, ENDPOINTS))
          : json({ error: "POST here to start a run", how: "curl -X POST /game" }, 405),
      POST: (request: Bun.BunRequest<"/game">) => {
        const id = roundIdAt();
        // An agent declares its ERC-8004 id here; it is verified against the payer on the first
        // payment, not now, because right now nobody has paid and there is nothing to check against.
        const declared = new URL(request.url).searchParams.get("agent");
        const agentId = declared !== null && /^\d+$/.test(declared) ? BigInt(declared) : undefined;
        const run = runs.start({ roundId: id, ...(agentId === undefined ? {} : { agentId }) });
        return json({ ...view(run), closesAt: round(id).closesAt.toISOString() }, 201);
      },
    },

    "/game/:id": (request: Bun.BunRequest<"/game/:id">) => {
      const run = runs.get(request.params.id);
      return run ? json(view(run)) : json({ error: "no such run" }, 404);
    },

    "/game/:id/move": {
      POST: async (request: Bun.BunRequest<"/game/:id/move">) => {
        const direction: unknown = new URL(request.url).searchParams.get("dir");
        if (!isDirection(direction)) {
          return json({ error: "dir must be one of n, s, e, w" }, 400);
        }
        const result = await paidRun(
          request,
          request.params.id,
          offerFor(PRICES.move, "/game/:id/move", "One step through the maze", bazaar.MOVE),
        );
        if ("response" in result) return result.response;

        const { run, settlement } = result;
        const { cells } = round(run.roundId);
        // A wall is charged for and moves nothing: the agent paid to learn it was there.
        const open = canMove(cells, run.at.x, run.at.y, direction);
        if (open) run.at = moved(run.at.x, run.at.y, direction);
        move(run, direction, open, settlement);
        if (atExit(run.at.x, run.at.y)) {
          finish(run, "solved");
          payOutReputation(run);
        }
        return json({ ...view(run), moved: open, wall: !open });
      },
    },

    "/game/:id/look": async (request: Bun.BunRequest<"/game/:id/look">) => {
      const result = await paidRun(
        request,
        request.params.id,
        offerFor(PRICES.look, "/game/:id/look", "The walls around you", bazaar.LOOK),
      );
      if ("response" in result) return result.response;
      const { run, settlement } = result;
      look(run, settlement);
      return json({ ...view(run), exits: exits(round(run.roundId).cells, run.at.x, run.at.y) });
    },

    "/game/:id/map": async (request: Bun.BunRequest<"/game/:id/map">) => {
      const result = await paidRun(
        request,
        request.params.id,
        offerFor(PRICES.map, "/game/:id/map", "The whole maze, and the grid behind it", bazaar.MAP),
      );
      if ("response" in result) return result.response;
      const { run, settlement } = result;
      map(run, settlement);
      const { cells } = round(run.roundId);
      return json({
        ...view(run),
        exit: EXIT,
        // Both, from one purchase: the grid for planning a route, the drawing for watching one.
        openings: openings(cells),
        map: render(cells, run.at),
      });
    },

    /**
     * The standing boards across every round this process has seen.
     *
     * Bounded by the run store rather than by history: an evicted run leaves the all-time board,
     * which is why anything that must outlive this — the reputation written on chain — carries its
     * own copy instead of a pointer back here.
     */
    "/board": (request: Request) => {
      const boards = [
        board("fewest-steps", runs.all(), "all-time"),
        board("least-spent", runs.all(), "all-time"),
      ];
      if (wantsHtml(request)) return html(boardPage(boards));
      return json({ of: "all-time", boards });
    },

    /** A stable, public URL per run. The on-chain reputation points here. */
    "/run/:id": (request: Bun.BunRequest<"/run/:id">) => {
      const run = runs.get(request.params.id);
      if (!run) return json({ error: "no such run" }, 404);
      const record = published(run);
      const hash = digest(record);
      if (wantsHtml(request)) {
        return html(runPage(record, hash, render(round(run.roundId).cells, run.at)));
      }
      return json({ ...record, digest: hash });
    },

    /** The audit, run by us on demand so nobody has to take our word for the boards. */
    "/run/:id/verify": (request: Bun.BunRequest<"/run/:id/verify">) => {
      const run = runs.get(request.params.id);
      if (!run) return json({ error: "no such run" }, 404);
      return json(verify(published(run)));
    },

    "/round/:id": (request: Bun.BunRequest<"/round/:id">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return json({ error: "no such round" }, 404);
      const it = round(id);
      // Read once: two calls would do the work twice and, if the store ever changes underneath,
      // publish a board and a run list that disagree about the same round.
      const inRound = runs.forRound(id);
      if (wantsHtml(request)) return html(roundPage(it, isOpen(id), boardsFor(id, inRound)));
      return json({
        round: it.id,
        open: isOpen(id),
        openedAt: it.openedAt.toISOString(),
        closesAt: it.closesAt.toISOString(),
        optimalSteps: it.optimalSteps,
        boards: boardsFor(id, inRound),
        runs: inRound.map((run) => published(run)),
      });
    },
  } as const;
}
