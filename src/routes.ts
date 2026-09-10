import {
  atExit, board, boardsFor, canMove, claim, digest, EXIT, exists, exits, finish, isDirection,
  discovered, isOpen, isRoundId, look, map, move, moved, openings, PRICES, published,
  render, round, roundIdAt,
  RunStore, verify, type PublishedRun, type Run,
} from "./maze/index.ts";
import {
  bazaar, belongsTo, Paywall,
  type ChargeOutcome, type Offer, type Registrar, type Roster, type Scribe,
} from "./arc/index.ts";
import { boardPage, indexPage, roundPage, runPage, wantsHtml } from "./web/page.ts";
import { drawMaze } from "./web/maze-svg.ts";
import { cardSvg, unfurlFor } from "./web/card.ts";
import { faviconSvg } from "./web/brand.ts";
import type { Cohort } from "./arc/badge.ts";
import type { Archive } from "./archive.ts";
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
  readonly runs?: RunStore;
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
  /**
   * Keeps the records the chain points at. Absent means records live as long as the process, which
   * is right for a laptop and wrong for a hostname.
   */
  readonly archive?: Archive;
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
  { method: "GET", path: "/board", what: "all-time boards" },
  { method: "GET", path: "/run/:id", what: "a run's record, and its digest" },
  { method: "GET", path: "/run/:id/verify", what: "replay it and check" },
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
  const live = config.live ?? feed();
  const scribe = config.scribe;
  const registrar = config.registrar;
  const roster = config.roster;
  const archive = config.archive;
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
  /**
   * One reputation record per agent per round.
   *
   * Bounded, because a process behind a hostname runs for weeks and this would otherwise hold one
   * string per solve for ever. Forgetting the oldest is safe: a run can only be *started* in the
   * open hour, so a guard for a round that has closed can never be tested again.
   *
   * In memory, which means it guards one process. A host running several would need this where the
   * records go — noted rather than solved, because today there is one.
   */
  const paidOut = new Set<string>();
  const PAID_OUT_KEPT = 500;

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
    if (paidOut.size > PAID_OUT_KEPT) {
      const oldest = paidOut.values().next();
      if (!oldest.done) paidOut.delete(oldest.value);
    }
    const record = published(run);
    const url = `${publicUrl}/run/${run.id}`;
    const agentId = run.agentId;

    /**
     * Kept first, and waited for, which is the whole point.
     *
     * These were started side by side, which read as ordered and was not: the write could land
     * while the archive was still in flight, or after it had already failed, committing a URL on
     * chain for a record nobody has. That is precisely the failure the archive exists to prevent,
     * so the two are chained rather than merely written in a suggestive order.
     *
     * If keeping fails the write is abandoned rather than attempted. A reputation record citing a
     * link that 404s is worse than one never written: the run is still published and replayable, so
     * a write can be repeated, while a bad citation on chain is permanent.
     */
    void (archive === undefined ? Promise.resolve() : archive.keep(record))
      .then(() => scribe.write(agentId, record, url, digest(record)))
      .then((written) => console.log(`reputation: agent ${written.agentId} scored ${written.value} — ${written.hash}`))
      .catch((cause: unknown) => {
        // Released, so a later solve in this round can try again. Farming stays bounded, because a
        // write that succeeds puts the guard back.
        paidOut.delete(once);
        console.error(`reputation for run ${run.id} was not written:`, cause);
      });

    // Separately, and separately allowed to fail: the record is the thing that matters, and a
    // closed cohort or a holder who already has one are ordinary answers rather than problems.
    void registrar?.admit(agentId)
      .then((badge) => {
        if (badge !== null) console.log(`cohort: #${badge.tokenId} to ${badge.holder} — ${badge.hash}`);
      })
      .catch((cause: unknown) => console.error(`badge admission failed for agent ${agentId}:`, cause));
  }

  /**
   * A record, from memory or from the archive.
   *
   * Memory first, because it is the common case and costs nothing. The archive answers the case
   * this exists for at all — somebody following a link out of a reputation record written weeks
   * ago. A failing archive answers "not found" rather than 500: from the reader's side an
   * unreachable record and an absent one are the same disappointment, and only one of them is
   * worth waking somebody for.
   */
  const recordFor = async (id: string): Promise<PublishedRun | null> => {
    const live = runs.get(id);
    if (live) return published(live);
    if (archive === undefined) return null;
    try {
      return await archive.find(id);
    } catch (cause) {
      console.error(`archive lookup failed for run ${id}:`, cause);
      return null;
    }
  };

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

  const front = (): string => {
    refreshCohort();
    const id = roundIdAt();
    const played = lastClosed();
    return indexPage(round(id), true, ENDPOINTS, {
      boards: boardsFor(id, runs.forRound(id)),
      cohort,
      base: publicUrl,
      ...(played === null ? {} : { replay: played }),
    });
  };

  return {
    "/": (request: Request) => {
      if (wantsHtml(request)) return html(front());
      return json({
        name: "Toll",
        what: "A maze on Arc that charges by the step, and pays out reputation.",
        // An agent handed a bare URL reads a page and stops, because nothing told it to play.
        // These two say what winning is and what to call first, so arriving is enough.
        goal: "Reach the exit. Fewest steps and least spent are ranked separately, so walking short and paying little are different games.",
        start: { method: "POST", path: "/game", what: "start a run. Free; every move after it is paid" },
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
          ? html(front())
          : json({ error: "POST here to start a run", how: "curl -X POST /game" }, 405),
      POST: (request: Bun.BunRequest<"/game">) => {
        const id = roundIdAt();
        // An agent declares its ERC-8004 id here; it is verified against the payer on the first
        // payment, not now, because right now nobody has paid and there is nothing to check against.
        const declared = new URL(request.url).searchParams.get("agent");
        const agentId = declared !== null && /^\d+$/.test(declared) ? BigInt(declared) : undefined;
        const run = runs.start({ roundId: id, ...(agentId === undefined ? {} : { agentId }) });
        live.publish({ kind: "started", round: id, run: run.id, at: { ...run.at } });
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
        live.publish({
          kind: "bought", round: run.roundId, run: run.id, action: "move", price: PRICES.move,
          spentUsd: run.spentUsd, at: { ...run.at }, batch: settlement ?? null,
        });
        if (atExit(run.at.x, run.at.y)) {
          finish(run, "solved");
          live.publish({
            kind: "finished", round: run.roundId, run: run.id, outcome: run.outcome,
            steps: run.steps, spentUsd: run.spentUsd,
          });
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
      live.publish({
        kind: "bought", round: run.roundId, run: run.id, action: "look", price: PRICES.look,
        spentUsd: run.spentUsd, at: { ...run.at }, batch: settlement ?? null,
      });
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
    "/run/:id": async (request: Bun.BunRequest<"/run/:id">) => {
      const record = await recordFor(request.params.id);
      if (record === null) return json({ error: "no such run" }, 404);
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
      const record = await recordFor(request.params.id);
      if (record === null) return json({ error: "no such run" }, 404);
      return json(verify(record));
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
    "/round/:id/card.svg": (request: Bun.BunRequest<"/round/:id/card.svg">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return json({ error: "no such round" }, 404);
      return new Response(cardSvg(round(id), isOpen(id), boardsFor(id, runs.forRound(id))), {
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
        start(controller) {
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
          // otherwise watch an empty screen and conclude the round was dead.
          send(frame({
            kind: "standing",
            round: id,
            open: isOpen(id),
            optimalSteps: round(id).optimalSteps,
            runs: runs.forRound(id).map((r) => ({
              run: r.id, steps: r.steps, spentUsd: r.spentUsd, outcome: r.outcome,
            })),
          }));

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

    "/round/:id": (request: Bun.BunRequest<"/round/:id">) => {
      const id = request.params.id;
      if (!isRoundId(id) || !exists(id)) return json({ error: "no such round" }, 404);
      const it = round(id);
      // Read once: two calls would do the work twice and, if the store ever changes underneath,
      // publish a board and a run list that disagree about the same round.
      const inRound = runs.forRound(id);
      if (wantsHtml(request)) {
        const boards = boardsFor(id, inRound);
        return html(roundPage(it, isOpen(id), boards, unfurlFor(it, isOpen(id), boards, publicUrl)));
      }
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
