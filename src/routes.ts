import {
  atExit, board, boardsFor, canMove, digest, EXIT, exists, exits, finish, isDirection,
  discovered, isOpen, isRoundId, isRunId, look, map, move, moved, nothingKnown, openings, PRICES,
  render, round, roundIdAt, verify,
  type Board, type PublishedRun, type Run, type RunSummary,
} from "./maze/index.ts";
import {
  bazaar, belongsTo, Paywall,
  type ChargeOutcome, type Offer, type Registrar, type Roster, type Scribe,
} from "./arc/index.ts";
import {
  badgePage, boardPage, chainDownPage, indexPage, notFoundPage, roundPage, runPage, runsPage,
  storeDownPage, verifyPage, wantsHtml,
} from "./web/page.ts";
import { badgeSvg } from "./web/badge-art.ts";
import { BEFORE_PAYING, STEPS, STEPS_ANCHOR, TERMS } from "./journey.ts";
import { siteFor } from "./web/site.ts";
import { drawMaze } from "./web/maze-svg.ts";
import { cardSvg, unfurlFor } from "./web/card.ts";
import { faviconSvg } from "./web/brand.ts";
import type { Cohort } from "./arc/badge.ts";
import { runsInMemory, type Runs } from "./storage.ts";
import { payOut, type Rewarding } from "./reward.ts";
import { badgeHref, PAGES } from "./paths.ts";
import { replayOf } from "./web/replay.ts";
import { feed, frame, heartbeat, type Feed } from "./live/feed.ts";

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

/** Idle SSE connections are indistinguishable from dead ones to a proxy, so they get closed. */
/**
 * How often a quiet stream proves it is still there.
 *
 * Exported because it is half of a pair, and the other half lives in `server.ts`. Bun closes an
 * idle connection on its own — ten seconds by default — so a heartbeat slower than that never
 * fires: the connection is killed five seconds before the thing designed to save it runs. That is
 * exactly what was happening, and it is invisible from here, because `EventSource` reconnects
 * quietly and the board looked fine.
 *
 * The server derives its idle timeout from this number so the two cannot drift apart again.
 */
export const HEARTBEAT_MS = 15_000;

export interface MazeConfig {
  /** Where payments go. */
  readonly seller: string;
  /**
   * Where runs are kept. Absent means in this process's memory, which is right for a laptop and
   * wrong for a host that runs several copies of the server: each would see only its own runs.
   */
  readonly runs?: Runs;
  readonly paywall?: Paywall;
  /**
   * Writes the reputation when a run is solved. Absent means the maze still works and simply pays
   * out nothing — which is the right default, since a missing key must not stop anyone playing.
   */
  readonly scribe?: Scribe;
  /** Admits solvers to the numbered cohort. Absent means no badges, which stops nobody playing. */
  readonly registrar?: Registrar;
  /**
   * Reads how full the cohort is, for the plate on the front page.
   *
   * Separate from the registrar because it needs no key: a deployment that is not allowed to mint
   * can still say how many places are gone, and should.
   */
  readonly roster?: Roster;
  /** Where a run can be read back. The reputation points here, so it has to be the public one. */
  readonly publicUrl?: string;
  /**
   * Does this agent id really belong to the address that paid?
   *
   * Injectable for the same reason the facilitator is: the real one reads Arc, and a test suite
   * that needs a chain fails on a train.
   */
  readonly verifyIdentity?: (agentId: bigint, payer: string) => Promise<boolean>;
  /** Where live events go. Supplied by a test that wants to watch them without opening a socket. */
  readonly live?: Feed;
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
  { method: "GET", path: "/", what: "this page" },
  { method: "POST", path: "/game", what: "start a run" },
  { method: "GET", path: "/game/:id", what: "where a run stands" },
  { method: "POST", path: "/game/:id/move", what: "a step, dir=n|s|e|w. A wall still costs you", price: PRICES.move },
  { method: "GET", path: "/game/:id/look", what: "the exits from where you stand", price: PRICES.look },
  { method: "GET", path: "/game/:id/map", what: "the whole maze", price: PRICES.map },
  { method: "GET", path: "/round/:id", what: "a round and its boards" },
  { method: "GET", path: "/round/:id/stream", what: "that round as it happens, over SSE" },
  { method: "GET", path: "/round/:id/card.svg", what: "the card a pasted link unfurls into" },
  { method: "GET", path: "/favicon.svg", what: "the mark, for the tab" },
  { method: "GET", path: PAGES.board, what: "the all-time board: every round's runs, ranked" },
  { method: "GET", path: PAGES.runs, what: "every run, newest first" },
  { method: "GET", path: "/run/:id", what: "a run's record, and its digest" },
  { method: "GET", path: "/run/:id/verify", what: "replay it and check" },
  { method: "GET", path: "/badge/:id", what: "a Cohort Zero badge: its picture and who holds it" },
];

/** A badge number: a positive whole number with no leading zero, so each badge has one address. */
const BADGE_NUMBER = /^[1-9][0-9]*$/;

/** How long a wallet may keep a badge's details. The holder can change, the picture cannot. */
const BADGE_CACHE = "public, max-age=300";

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
        {
          error: "payment required",
          // For an agent that cannot pay at all yet: what the person has to do, and where it is
          // written. Beside the payment terms rather than instead of them, which stay in the header.
          setup: `Paying needs an allowance from your owner's wallet. The five steps are at ${STEPS_ANCHOR}.`,
          ...outcome.paymentRequired,
        },
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

/**
 * A second action on a run while the first is still being paid for.
 *
 * Refused before it is charged. Both used to be charged and applied, and the second could land after
 * the run had already solved, which left a record that did not replay.
 */
const busy = (): Response =>
  json({
    error: "this run is already paying for an action",
    detail: "send one action at a time, and the next once this one has answered",
  }, 409, { "retry-after": "1" });

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
  const runs = config.runs ?? runsInMemory();
  const paywall = config.paywall ?? new Paywall();
  const live = config.live ?? feed();
  const scribe = config.scribe;
  const registrar = config.registrar;
  const roster = config.roster;
  const publicUrl = (config.publicUrl ?? "").replace(/\/$/, "");
  // A reputation record is permanent and quotes a URL. Writing one without knowing our own public
  // address would put a relative path on chain forever, pointing at nothing from anywhere.
  if (scribe !== undefined && publicUrl === "") {
    throw new Error("publicUrl is required when a scribe is configured: the reputation quotes it");
  }
  const verifyIdentity = config.verifyIdentity ?? belongsTo;

  /** What paying out a solve needs. See `reward.ts` for why the solving step waits for it. */
  const rewarding: Rewarding = {
    runs,
    publicUrl,
    ...(scribe === undefined ? {} : { scribe }),
    ...(registrar === undefined ? {} : { registrar }),
  };

  /**
   * A run's published record as it was kept, or null when there is no such run.
   *
   * An id that could not be a run is answered here without asking the store, where every lookup is a
   * request, and ids travel in every URL.
   */
  const recordFor = async (id: string): Promise<PublishedRun | null> =>
    isRunId(id) ? runs.record(id) : null;

  /**
   * The store could not be reached, said as that.
   *
   * Not "not found", which is what the archive used to answer: a reputation record on chain points at
   * a run, and a reader told it does not exist would conclude the record cites nothing. And not an
   * empty board, which would say that nobody has played.
   */
  const unreachable = (request: Request, cause: unknown): Response => {
    console.error(`the run store did not answer for ${new URL(request.url).pathname}:`, cause);
    return wantsHtml(request)
      ? html(storeDownPage(), 503)
      : json({ error: "the run store did not answer", detail: "nothing is lost; ask again in a moment" },
          503, { "retry-after": "5" });
  };

  /** Arc did not answer a read a page needed: said as that, not as "no such badge". */
  const chainUnreachable = (request: Request, cause: unknown): Response => {
    console.error(`Arc did not answer for ${new URL(request.url).pathname}:`, cause);
    return wantsHtml(request)
      ? html(chainDownPage(), 503)
      : json({ error: "Arc did not answer", detail: "ask again in a moment" }, 503, { "retry-after": "5" });
  };

  /** Nothing at this address: a page for a person, the same JSON as ever for an agent. */
  const missing = (request: Request, error: string): Response =>
    wantsHtml(request) ? html(notFoundPage(error), 404) : json({ error }, 404);

  const offerFor = (
    priceUsd: number, resource: string, description: string, discovery: bazaar.Bazaar,
  ): Offer => ({ priceUsd, payTo: SELLER, resource, description, bazaar: discovery });

  /** What one paid action does to its run, once the payment has gone through. */
  type Act = (run: Run, settlement: string | undefined) => Promise<Response>;

  /**
   * Take payment for one action on a run, apply it, and write the run back.
   *
   * The run is held first, before anything is charged, so a second action on it at the same time is
   * refused rather than charged; and let go once it is written back, however that went.
   */
  async function paidAction(request: Request, runId: string, offer: Offer, act: Act): Promise<Response> {
    if (!isRunId(runId)) return json({ error: "no such run" }, 404);
    try {
      if (!(await runs.hold(runId))) return busy();
    } catch (cause) {
      return unreachable(request, cause);
    }
    try {
      return await chargeAndAct(request, runId, offer, act);
    } finally {
      await runs.release(runId).catch((cause: unknown) =>
        console.error(`run ${runId} could not be let go; the hold expires on its own:`, cause));
    }
  }

  /**
   * The held part of a paid action.
   *
   * The run is read after it is held, from the store every copy of the server shares, so the action
   * lands on the run as it stands rather than on a copy another action has since moved on.
   *
   * Whose run it is, is checked between verifying the payment and settling it, so a stranger who pays
   * for a run that is not theirs is refused before the money moves. A run id travels, in a link, a
   * log, a chat, and a leaderboard entry has to belong to whoever bought the steps.
   */
  async function chargeAndAct(request: Request, runId: string, offer: Offer, act: Act): Promise<Response> {
    let run: Run | null;
    try {
      run = await runs.get(runId);
    } catch (cause) {
      return unreachable(request, cause);
    }
    if (run === null) return json({ error: "no such run" }, 404);
    if (run.outcome !== "running") return json({ error: `this run is already ${run.outcome}` }, 409);
    const held = run;

    const claimFailure: { cause?: unknown } = {};
    const outcome = await paywall.charge(request.headers.get("payment-signature"), offer, async (payer) => {
      try {
        const claimed = await runs.claim(held, payer);
        // Checked here, between verifying and settling, so hitting the cap costs nothing.
        return claimed.ok && claimed.runsThisRound <= RUNS_PER_PAYER_PER_ROUND;
      } catch (cause) {
        claimFailure.cause = cause;
        return false;
      }
    });
    // Declined because the store did not answer rather than because of the payer. Nothing was charged.
    if (claimFailure.cause !== undefined) return unreachable(request, claimFailure.cause);
    if (outcome.kind !== "paid") return unpaid(outcome);
    const { payer, settlement } = outcome.charged;
    // Check the declared identity once, against whoever actually paid. A declaration nobody checks
    // is an invitation to write reputation onto a stranger's identity.
    if (held.agentId !== null && !(await verifyIdentity(held.agentId, payer))) held.agentId = null;

    try {
      return await act(held, settlement);
    } catch (cause) {
      // The money moved and the action was not written down. Said plainly, with the payment named,
      // so it can be put right rather than lost.
      console.error(`run ${runId}: a paid action was not recorded (batch ${settlement ?? "unknown"}):`, cause);
      return json({
        error: "this action was paid for but could not be recorded",
        detail: "the run is as it was before it; the payment is named here so it can be put right",
        settlement: settlement ?? null,
      }, 503);
    }
  }

  /**
   * How full the cohort is, kept to one side of the request path.
   *
   * Scarcity belongs on the front page — "two of a hundred taken" is the reason to hurry — but not
   * at the cost of a page that stalls when an RPC does. So the figure is refreshed in the
   * background and every render serves whatever is already known, including nothing at all on the
   * first hit. A stale count is fine; the number moves at most a hundred times, ever.
   */
  let cohort: Cohort | null = null;
  let cohortReadAt = 0;
  let cohortReadFailed = false;
  const COHORT_TTL_MS = 60_000;
  const refreshCohort = (): void => {
    if (roster === undefined || Date.now() - cohortReadAt < COHORT_TTL_MS) return;
    cohortReadAt = Date.now();
    void roster.taken()
      .then((seen) => { if (seen !== null) cohort = seen; })
      // Said once, not on every refresh: a chain we cannot reach is a minute of noise otherwise.
      // Silence here used to mean a plate that simply never appeared, with nothing anywhere saying
      // why — the page looked designed that way rather than broken.
      .catch((cause: unknown) => {
        if (cohortReadFailed) return;
        cohortReadFailed = true;
        console.warn("the cohort count is unavailable; the page will omit the plate:", cause);
      });
  };

  // Warmed once at startup, so the first person through the door sees the count rather than a gap
  // where the scarcity is. Fire-and-forget: a server that cannot reach the chain still serves.
  refreshCohort();

  /**
   * The round the front page replays: the last one that closed.
   *
   * Never the live hour. Playing that back would hand away the map we charge a cent for, which is
   * the one thing on the page that must not be free. A finished round demonstrates exactly the
   * same thing and costs nobody anything. Memoised because it never changes within an hour.
   */
  const HOUR_MS = 60 * 60 * 1000;
  let replay: { of: string; run: ReturnType<typeof replayOf> } | null = null;
  const lastClosed = (): typeof replay => {
    const of = roundIdAt(new Date(Date.now() - HOUR_MS));
    if (replay?.of === of) return replay;
    if (!exists(of)) return null;
    const it = round(of);
    replay = { of, run: replayOf(it.cells, it.optimalRoute) };
    return replay;
  };

  const front = async (request: Request): Promise<string> => {
    refreshCohort();
    const id = roundIdAt();
    const played = lastClosed();
    // The page still renders when the store does not answer, and says so where the boards would be:
    // an empty board would claim nobody has played.
    let boards: readonly Board[] | null;
    try {
      boards = boardsFor(id, await runs.inRound(id));
    } catch (cause) {
      console.error("the front page could not read this round's runs:", cause);
      boards = null;
    }
    return indexPage(round(id), true, ENDPOINTS, {
      boards,
      cohort,
      ...(roster === undefined ? {} : { badgeContract: roster.contract }),
      // The address this reader should be given: their own on a laptop, the public one otherwise.
      base: siteFor(request.url, publicUrl),
      ...(played === null ? {} : { replay: played }),
    });
  };

  return {
    "/": async (request: Request) => {
      if (wantsHtml(request)) return html(await front(request));
      return json({
        name: "Toll",
        what: "A maze on Arc that charges by the step, and pays out reputation.",
        // An agent handed a bare URL reads a page and stops, because nothing told it to play.
        // These two say what winning is and what to call first, so arriving is enough.
        goal: "Reach the exit. Fewest steps and least spent are ranked separately, so walking short and paying little are two different ways to win.",
        start: { method: "POST", path: "/game", what: "start a run. Free; every move after it is paid" },
        // The same three words the page defines, so an agent and its owner mean the same things.
        terms: TERMS,
        // The person's path, the same five steps the page draws, so an agent can tell its owner
        // what comes next instead of finding out from a refused payment.
        setup: STEPS.map((step, index) => ({ step: index + 1, where: step.where, title: step.title, detail: step.detail })),
        beforePaying: BEFORE_PAYING,
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
      GET: async (request: Bun.BunRequest<"/game">) =>
        wantsHtml(request)
          ? html(await front(request))
          : json({ error: "POST here to start a run", how: "curl -X POST /game" }, 405),
      POST: async (request: Bun.BunRequest<"/game">) => {
        const id = roundIdAt();
        // An agent declares its ERC-8004 id here; it is verified against the payer on the first
        // payment, not now, because right now nobody has paid and there is nothing to check against.
        const declared = new URL(request.url).searchParams.get("agent");
        const agentId = declared !== null && /^\d+$/.test(declared) ? BigInt(declared) : undefined;
        let run: Run;
        try {
          run = await runs.start({ roundId: id, ...(agentId === undefined ? {} : { agentId }) });
        } catch (cause) {
          return unreachable(request, cause);
        }
        live.publish({ kind: "started", round: id, run: run.id, at: { ...run.at } });
        return json({ ...view(run), closesAt: round(id).closesAt.toISOString() }, 201);
      },
    },

    "/game/:id": async (request: Bun.BunRequest<"/game/:id">) => {
      const id = request.params.id;
      try {
        const run = isRunId(id) ? await runs.get(id) : null;
        return run === null ? json({ error: "no such run" }, 404) : json(view(run));
      } catch (cause) {
        return unreachable(request, cause);
      }
    },

    "/game/:id/move": {
      POST: async (request: Bun.BunRequest<"/game/:id/move">) => {
        const direction: unknown = new URL(request.url).searchParams.get("dir");
        if (!isDirection(direction)) {
          return json({ error: "dir must be one of n, s, e, w" }, 400);
        }
        const offer = offerFor(PRICES.move, "/game/:id/move", "One step through the maze", bazaar.MOVE);
        return paidAction(request, request.params.id, offer, async (run, settlement) => {
          const { cells } = round(run.roundId);
          // A wall is charged for and moves nothing: the agent paid to learn it was there.
          const open = canMove(cells, run.at.x, run.at.y, direction);
          if (open) run.at = moved(run.at.x, run.at.y, direction);
          move(run, direction, open, settlement);
          const solved = atExit(run.at.x, run.at.y);
          if (solved) finish(run, "solved");
          // Written down before anything is said about it: a watcher refetching the board has to find
          // it, and the reward quotes this record on chain.
          await runs.save(run);
          live.publish({
            kind: "bought", round: run.roundId, run: run.id, action: "move", price: PRICES.move,
            spentUsd: run.spentUsd, at: { ...run.at }, batch: settlement ?? null,
          });
          if (!solved) return json({ ...view(run), moved: open, wall: !open });

          live.publish({
            kind: "finished", round: run.roundId, run: run.id, outcome: run.outcome,
            steps: run.steps, spentUsd: run.spentUsd,
          });
          // Waited for: the host stops once this answers, and the agent should hear what it earned.
          const reward = await payOut(run, rewarding);
          return json({ ...view(run), moved: open, wall: !open, reward });
        });
      },
    },

    "/game/:id/look": async (request: Bun.BunRequest<"/game/:id/look">) => {
      const offer = offerFor(PRICES.look, "/game/:id/look", "The walls around you", bazaar.LOOK);
      return paidAction(request, request.params.id, offer, async (run, settlement) => {
        look(run, settlement);
        await runs.save(run);
        live.publish({
          kind: "bought", round: run.roundId, run: run.id, action: "look", price: PRICES.look,
          spentUsd: run.spentUsd, at: { ...run.at }, batch: settlement ?? null,
        });
        return json({ ...view(run), exits: exits(round(run.roundId).cells, run.at.x, run.at.y) });
      });
    },

    "/game/:id/map": async (request: Bun.BunRequest<"/game/:id/map">) => {
      const offer = offerFor(PRICES.map, "/game/:id/map", "The whole maze, and the grid behind it", bazaar.MAP);
      return paidAction(request, request.params.id, offer, async (run, settlement) => {
        map(run, settlement);
        await runs.save(run);
        live.publish({
          kind: "bought", round: run.roundId, run: run.id, action: "map", price: PRICES.map,
          spentUsd: run.spentUsd, at: { ...run.at }, batch: settlement ?? null,
        });
        const { cells } = round(run.roundId);
        return json({
          ...view(run),
          exit: EXIT,
          // Both, from one purchase: the grid for planning a route, the drawing for watching one.
          openings: openings(cells),
          map: render(cells, run.at),
        });
      });
    },

    /** The all-time board: every run of every round, ranked the same two ways as a round's. */
    [PAGES.board]: async (request: Request) => {
      let every: readonly RunSummary[];
      try {
        every = await runs.every();
      } catch (cause) {
        return unreachable(request, cause);
      }
      const boards = [board("fewest-steps", every, "all-time"), board("least-spent", every, "all-time")];
      if (wantsHtml(request)) return html(boardPage(boards));
      return json({ of: "all-time", boards });
    },

    /** Every run anybody has paid for, newest first: the answer to "where are all the runs?" */
    [PAGES.runs]: async (request: Request) => {
      let every: readonly RunSummary[];
      try {
        every = await runs.every();
      } catch (cause) {
        return unreachable(request, cause);
      }
      // Plain comparison of ISO timestamps, which sort as text; no locale can reorder them.
      const newestFirst = [...every].sort((a, b) =>
        a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0);
      if (wantsHtml(request)) return html(runsPage(newestFirst));
      return json({ count: newestFirst.length, runs: newestFirst });
    },

    /** A stable, public URL per run. The on-chain reputation points here. */
    "/run/:id": async (request: Bun.BunRequest<"/run/:id">) => {
      let record: PublishedRun | null;
      try {
        record = await recordFor(request.params.id);
      } catch (cause) {
        return unreachable(request, cause);
      }
      if (record === null) return missing(request, "no such run");
      const hash = digest(record);
      if (wantsHtml(request)) {
        // Where it stands is replayed rather than remembered. An archived record has no live run
        // behind it to ask, and the maze is deterministic, so walking the record answers it — the
        // same thing `/verify` does, and so it cannot disagree with it.
        const at = verify(record).endedAt;
        return html(runPage(record, hash, drawMaze(round(record.round).cells, discovered(record), at)));
      }
      return json({ ...record, digest: hash });
    },

    /** The audit, run by us on demand so nobody has to take our word for the boards. */
    "/run/:id/verify": async (request: Bun.BunRequest<"/run/:id/verify">) => {
      let record: PublishedRun | null;
      try {
        record = await recordFor(request.params.id);
      } catch (cause) {
        return unreachable(request, cause);
      }
      if (record === null) return missing(request, "no such run");
      const result = verify(record);
      if (wantsHtml(request)) return html(verifyPage(record, result));
      return json(result);
    },

    /**
     * A Cohort Zero badge, at the address the contract gives for it.
     *
     * The badge's `tokenURI` is this address, so this is what a wallet fetches to show one: the
     * standard name, description and picture, the picture inline so there is nothing else to fetch.
     * A person gets a page. It answers only for a badge the chain says exists, and asks the chain
     * each time: a page for a number nobody holds would be a claim with nothing behind it.
     */
    "/badge/:id": async (request: Bun.BunRequest<"/badge/:id">) => {
      const id = request.params.id;
      if (roster === undefined || !BADGE_NUMBER.test(id)) return missing(request, "no such badge");
      let holder: string | null;
      let cohortNow: Cohort | null;
      try {
        [holder, cohortNow] = await Promise.all([roster.holderOf(BigInt(id)), roster.taken()]);
      } catch (cause) {
        return chainUnreachable(request, cause);
      }
      if (holder === null) return missing(request, "no such badge");
      // `taken` answers null rather than throwing when the chain does not answer.
      if (cohortNow === null) return chainUnreachable(request, "the cohort size could not be read");

      const number = Number(id);
      const picture = badgeSvg(number, cohortNow.of);
      if (wantsHtml(request)) {
        return html(badgePage({ number, of: cohortNow.of, holder, contract: roster.contract }, picture));
      }
      return json({
        name: `Cohort Zero #${number}`,
        description: `One of the first ${cohortNow.of} places in Cohort Zero, for agents that got out ` +
          "of Toll, a maze on Arc that an agent pays to walk. The maze admits the owner of the agent's " +
          "ERC-8004 identity; nobody can admit themselves.",
        image: `data:image/svg+xml;base64,${Buffer.from(picture).toString("base64")}`,
        external_url: `${siteFor(request.url, publicUrl)}${badgeHref(number)}`,
        attributes: [{ trait_type: "Place", value: number, max_value: cohortNow.of }],
      }, 200, { "cache-control": BADGE_CACHE });
    },

    /**
     * One round, as it happens.
     *
     * Server-sent events rather than a socket: this is one-directional — a spectator has nothing
     * to say back — and SSE reconnects on its own, survives a proxy, and needs no library at
     * either end. A WebSocket would be a second protocol to hold open for no traffic in return.
     *
     * Every event carries the round, and only this round's are forwarded, so a viewer of an hour
     * that has closed sees a quiet stream rather than somebody else's race.
     */
    /** The mark alone. One file for both themes: the SVG carries its own media query. */
    "/favicon.svg": () =>
      new Response(faviconSvg(), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          // It never changes. A tab icon refetched on every navigation is a wasted round trip.
          "cache-control": "public, max-age=86400",
        },
      }),

    /** The picture a pasted link becomes. Self-contained: a crawler fetches this and nothing else. */
    "/round/:id/card.svg": async (request: Bun.BunRequest<"/round/:id/card.svg">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return json({ error: "no such round" }, 404);
      let inRound: readonly RunSummary[];
      try {
        inRound = await runs.inRound(id);
      } catch (cause) {
        return unreachable(request, cause);
      }
      return new Response(cardSvg(round(id), isOpen(id), boardsFor(id, inRound)), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          // A round is an hour long and its board moves within it; a crawler that cached this for
          // a day would show a race that finished as if it were still running.
          "cache-control": "public, max-age=60",
        },
      });
    },

    "/round/:id/stream": (request: Bun.BunRequest<"/round/:id/stream">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return json({ error: "no such round" }, 404);

      let stop: (() => void) | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;

      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;

          /**
           * A viewer leaving is the ordinary end of a stream, not a fault, and it arrives by three
           * different routes — an abort, a cancel, or a write to a socket that has already gone.
           * One idempotent close handles all of them; without it the listener and the timer
           * outlive the connection and the process gains one of each per visit.
           */
          const close = (): void => {
            if (closed) return;
            closed = true;
            stop?.();
            if (beat !== undefined) clearInterval(beat);
            try { controller.close(); } catch { /* already closed by the disconnect */ }
          };

          // `enqueue` throws once the stream is gone. Inside the heartbeat that would be an
          // uncaught exception in a timer rather than a handled one, which is a crash on a server
          // that is meant to stay up for a demo. A failed write means the viewer left.
          const send = (chunk: string): void => {
            if (closed) return;
            try {
              controller.enqueue(new TextEncoder().encode(chunk));
            } catch {
              close();
            }
          };

          // A client can be gone before the handler runs, and then `abort` never fires again.
          if (request.signal.aborted) {
            close();
            return;
          }
          request.signal.addEventListener("abort", close);

          // Said once, up front: everything that follows is a claim on money that has not moved yet.
          send(`: round ${id}. every payment here is claimed, not settled\n\n`);

          // What is already true, before any delta. A viewer arriving between payments would
          // otherwise watch an empty screen and conclude the round was dead. If the store does not
          // answer, nothing is sent rather than an empty standing, which would say nobody has played.
          try {
            const standing = await runs.inRound(id);
            send(frame({
              kind: "standing",
              round: id,
              open: isOpen(id),
              optimalSteps: round(id).optimalSteps,
              runs: standing.map((r) => ({
                run: r.id, steps: r.steps, spentUsd: r.spentUsd, outcome: r.outcome,
              })),
            }));
          } catch (cause) {
            console.error(`the stream for round ${id} could not read its runs:`, cause);
          }
          // The viewer can leave while the store is being read. Subscribing after that would leave a
          // listener and a timer attached to a connection that no longer exists.
          if (closed) return;

          stop = live.subscribe((event) => {
            if (event.round === id) send(frame(event));
          });
          beat = setInterval(() => send(heartbeat()), HEARTBEAT_MS);
        },
        cancel() {
          stop?.();
          if (beat !== undefined) clearInterval(beat);
        },
      });

      return new Response(body, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    },

    "/round/:id": async (request: Bun.BunRequest<"/round/:id">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return missing(request, "no such round");
      const it = round(id);
      // Read once: two calls would do the work twice and, if the store changes underneath, publish
      // a board and a run list that disagree about the same round.
      let inRound: readonly RunSummary[];
      try {
        inRound = await runs.inRound(id);
      } catch (cause) {
        return unreachable(request, cause);
      }
      if (wantsHtml(request)) {
        const boards = boardsFor(id, inRound);
        // Drawn as a fresh run sees it: the box and the exit, and not one wall. A round page
        // about a maze that showed no maze was the same hole the front page had, and showing the
        // real thing would hand away what every step of it is sold for.
        return html(roundPage(
          it, isOpen(id), boards,
          unfurlFor(it, isOpen(id), boards, publicUrl),
          drawMaze(it.cells, nothingKnown()),
        ));
      }
      return json({
        round: it.id,
        open: isOpen(id),
        openedAt: it.openedAt.toISOString(),
        closesAt: it.closesAt.toISOString(),
        optimalSteps: it.optimalSteps,
        boards: boardsFor(id, inRound),
        // Summaries: each run's actions are at its own address, /run/:id.
        runs: inRound,
      });
    },
  } as const;
}
