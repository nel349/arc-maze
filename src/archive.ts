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
export function upstashArchive(endpoint: string, token: string): Archive {
  const base = endpoint.replace(/\/$/, "");
  const auth = { authorization: `Bearer ${token}` };
  const key = (id: string): string => `run:${encodeURIComponent(id)}`;

  return {
    async keep(record) {
      const response = await fetch(`${base}/set/${key(record.id)}`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(record),
      });
      if (!response.ok) {
        // Thrown rather than swallowed: the caller decides, and the caller is a fire-and-forget
        // that logs. Silence here would mean discovering the archive was never working when
        // somebody follows a link from a reputation record months later.
        throw new Error(`archive refused run ${record.id}: ${response.status}`);
      }
    },

    async find(id) {
      const response = await fetch(`${base}/get/${key(id)}`, { headers: auth });
      if (!response.ok) throw new Error(`archive unreachable for ${id}: ${response.status}`);
      const body = (await response.json()) as { result?: string | null };
      if (body.result === null || body.result === undefined) return null;
      return JSON.parse(body.result) as PublishedRun;
    },
  };
}
