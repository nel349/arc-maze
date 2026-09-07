import { atExit, canMove, exits, isDirection, moved, openings, render } from "./maze.ts";
import { exists, isOpen, isRoundId, round, roundIdAt } from "./round.ts";
import { EXIT } from "./maze.ts";
import {
  claim, digest, finish, look, map, move, published, PRICES, RunStore, verify,
  type Run,
} from "./runs.ts";
import { Paywall, type ChargeOutcome, type Offer } from "./paywall.ts";
import { board, boardsFor } from "./boards.ts";
import { belongsTo, type Scribe } from "./reputation.ts";

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
  const publicUrl = (config.publicUrl ?? "").replace(/\/$/, "");
  const verifyIdentity = config.verifyIdentity ?? belongsTo;

  /**
   * Pay out the reputation for a solved run.
   *
   * Deliberately not awaited by the route that triggers it. The agent has finished its maze and is
   * owed an answer; making it wait for a transaction it did not ask for would turn a step into a
   * block-time pause. A failure here loses a record, not a run — the run is already published and
   * verifiable, and the write can be replayed from it.
   */
  function payOutReputation(run: Run): void {
    if (scribe === undefined || run.agentId === null || run.outcome !== "solved") return;
    const record = published(run);
    const url = `${publicUrl}/run/${run.id}`;
    void scribe
      .write(run.agentId, record, url, digest(record))
      .then((written) => console.log(`reputation: agent ${written.agentId} scored ${written.value} — ${written.hash}`))
      .catch((cause: unknown) => console.error(`reputation write failed for run ${run.id}:`, cause));
  }

  const offerFor = (priceUsd: number, resource: string, description: string): Offer => ({
    priceUsd, payTo: SELLER, resource, description,
  });

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
    const outcome = await paywall.charge(request.headers.get("payment-signature"), offer);
    if (outcome.kind !== "paid") return { response: unpaid(outcome) };
    const payer = outcome.charged.payer;
    if (!claim(run, payer).ok) {
      // Paid, and the payment stands — but not for this run. Saying so plainly beats a 403 that
      // reads like the payment failed.
      return { response: json({ error: "this run belongs to another payer", run: runId }, 403) };
    }
    // Check the declared identity once, against whoever actually paid. A declaration nobody checks
    // is an invitation to write reputation onto a stranger's identity.
    if (run.agentId !== null && !(await verifyIdentity(run.agentId, payer))) run.agentId = null;
    return { run, settlement: outcome.charged.settlement };
  }

  return {
    "/": () =>
      json({
        what: "A maze on Arc that charges by the step, and pays out reputation.",
        round: roundIdAt(),
        prices: PRICES,
        howToPlay: {
          "1": "POST /game to start. Free, and it tells you the round.",
          "2": "POST /game/:id/move?dir=n|s|e|w — a step. A wall still costs you.",
          "3": "GET /game/:id/look — what is next to you.",
          "4": "GET /game/:id/map — the whole maze, for the price of ten steps.",
        },
        verify: "GET /run/:id and GET /run/:id/verify — replay any run yourself.",
      }),

    "/game": {
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
          offerFor(PRICES.move, "/game/:id/move", "One step through the maze"),
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
        offerFor(PRICES.look, "/game/:id/look", "The walls around you"),
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
        offerFor(PRICES.map, "/game/:id/map", "The whole maze, drawn"),
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
    "/board": () => json({
      of: "all-time",
      boards: [board("fewest-steps", runs.all(), "all-time"), board("least-spent", runs.all(), "all-time")],
    }),

    /** A stable, public URL per run. The on-chain reputation points here. */
    "/run/:id": (request: Bun.BunRequest<"/run/:id">) => {
      const run = runs.get(request.params.id);
      if (!run) return json({ error: "no such run" }, 404);
      const record = published(run);
      return json({ ...record, digest: digest(record) });
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
