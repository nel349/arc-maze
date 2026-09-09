import type { PublishedRun } from "./maze/runs.ts";

/**
 * The records that have to outlive the process.
 *
 * Not the run store, and deliberately not all of it. The board page already says what is true of
 * the rest — *"across every round still in memory; a run that ages out leaves this board, the
 * reputation written on chain does not"* — so runs, boards and eviction stay exactly as they are.
 *
 * What cannot be allowed to vanish is narrower: a run that solved with a verified identity. That
 * is the only case where `giveFeedback` wrote a `feedbackURI` pointing at `/run/:id` and committed
 * the record's digest alongside it. Lose that record and the on-chain reputation cites nothing, and
 * a hash nobody can check is worse than no hash — it reads as evidence and is not.
 *
 * So the rule is: **persist exactly what we have made a permanent claim about.** Roughly one run in
 * a hundred. Everything else is allowed to be temporary because we already said it was.
 *
 * Absent by design. Without an archive the maze runs exactly as before and records live only as
 * long as the server does, which is right for a laptop and wrong for a hostname.
 */
export interface Archive {
  /** Keep a record for good. Called once, when a run has earned something permanent. */
  keep(record: PublishedRun): Promise<void>;
  /** The record, if it was ever kept. */
  find(id: string): Promise<PublishedRun | null>;
}

/**
 * Upstash Redis over its REST API, which is chosen for two properties rather than for Redis.
 *
 * It speaks HTTP, so there is no connection to pool or to leak from somewhere that may be a fresh
 * instance on every request — the thing that makes ordinary database drivers awkward in a
 * serverless host. And it needs no client library: a record is an immutable blob under its own id,
 * which is `SET` and `GET` and nothing else, so this adds no dependency to a project that has been
 * careful about them.
 */
/**
 * The one call this makes on the outside world.
 *
 * Narrower than `typeof fetch` on purpose: that type carries whatever else the runtime hangs off
 * the global — Bun adds `preconnect` — and a seam should ask for what it uses rather than for a
 * whole global. `fetch` satisfies this; so does a function written in four lines by a test.
 */
export type Send = (url: string, init?: RequestInit) => Promise<Response>;

/** What Upstash answers with: a result, or a command error, and the error can arrive with a 200. */
interface RestReply {
  readonly result?: string | null;
  readonly error?: string;
}

export function upstashArchive(
  endpoint: string,
  token: string,
  /**
   * Injected so this can be tested without a socket.
   *
   * The project's own rule, from `main.ts`: a test that has to bind a port fails on a busy machine
   * and leaves a listener behind when it crashes. Handing in `fetch` exercises the URL, the header,
   * the body and the reply parsing without one.
   */
  send: Send = fetch,
): Archive {
  const base = endpoint.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}` };
  const key = (id: string): string => `run:${encodeURIComponent(id)}`;

  /**
   * A failure is a failure however it arrives.
   *
   * Upstash reports a bad command as `{"error": …}` — and does so with a 200, so a status check
   * alone would read it as success. For `keep` that would mean believing a record was stored when
   * it was not, which is the one thing this must never do quietly.
   */
  const reply = async (response: Response, what: string): Promise<RestReply> => {
    if (!response.ok) throw new Error(`${what}: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as RestReply;
    if (body.error !== undefined) throw new Error(`${what}: ${body.error}`);
    return body;
  };

  return {
    async keep(record) {
      // Thrown rather than swallowed. The caller is a fire-and-forget that logs and abandons the
      // reputation write, which is the right response to "this record is not safe yet".
      await reply(
        await send(`${base}/set/${key(record.id)}`, {
          method: "POST",
          headers,
          body: JSON.stringify(record),
        }),
        `archive refused run ${record.id}`,
      );
    },

    async find(id) {
      const body = await reply(
        await send(`${base}/get/${key(id)}`, { headers }),
        `archive unreachable for run ${id}`,
      );
      // A key that was never written comes back as a null result rather than as an error.
      if (body.result === null || body.result === undefined) return null;
      return JSON.parse(body.result) as PublishedRun;
    },
  };
}
