import type { Action, Outcome } from "../maze/runs.ts";
import type { Point, RoundId } from "../maze/index.ts";

/**
 * What is happening in a round, as it happens.
 *
 * A leaderboard is the story after it is over. The interesting part of this project is an agent
 * spending its way through a maze one tenth of a cent at a time, and that is only watchable live —
 * a page that shows the result has thrown away the thing worth showing.
 *
 * **`settlement` is a claim, not a fact.** It carries the batch the facilitator accepted this
 * payment into, which lands on chain about a quarter of an hour later. Every consumer of this feed
 * is looking at money that is promised rather than moved, and the field is named for the batch
 * rather than for the settlement so that nobody has to be told twice.
 *
 * Deliberately not a log. A viewer is sent the **standing state** once on arrival and the deltas
 * after it, which is enough to draw a round without keeping a replayable history here — the run
 * records and the boards are where history lives, and a second copy would be a second thing to
 * keep true. Individual payments made before a viewer arrived are not replayed; the totals they
 * produced are.
 */

export type LiveEvent =
  /**
   * What is already true, sent once when a viewer arrives, before any delta.
   *
   * Without it a spectator who joins between payments watches an empty screen and concludes the
   * thing is broken — the round has a standing board and they cannot see it. The lesson is
   * borrowed rather than learned again: `kuira-offer-links` records replaying the standing state
   * before streaming deltas as load-bearing, and it is the same mistake either way.
   */
  | {
      readonly kind: "standing";
      readonly round: RoundId;
      readonly open: boolean;
      readonly optimalSteps: number;
      readonly runs: readonly {
        readonly run: string;
        readonly steps: number;
        readonly spentUsd: number;
        readonly outcome: Outcome;
      }[];
    }
  | { readonly kind: "started"; readonly round: RoundId; readonly run: string; readonly at: Point }
  | {
      readonly kind: "bought";
      readonly round: RoundId;
      readonly run: string;
      readonly action: Action;
      readonly price: number;
      readonly spentUsd: number;
      readonly at: Point;
      /** The batch the facilitator accepted it into. Null while unknown; never proof of settling. */
      readonly batch: string | null;
    }
  | {
      readonly kind: "finished";
      readonly round: RoundId;
      readonly run: string;
      readonly outcome: Outcome;
      readonly steps: number;
      readonly spentUsd: number;
    };

export type Listener = (event: LiveEvent) => void;

export interface Feed {
  publish(event: LiveEvent): void;
  /** Returns the unsubscribe. Calling it twice is harmless; forgetting it is a leak. */
  subscribe(listener: Listener): () => void;
  /** How many are watching. Used by the tests, and worth having when one of these goes wrong. */
  readonly watching: number;
}

export function feed(): Feed {
  const listeners = new Set<Listener>();

  return {
    publish(event) {
      // A copy, because a listener that unsubscribes while being notified would otherwise mutate
      // the set mid-iteration — which is exactly what the abort handler does when a viewer leaves.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // One broken viewer must not stop the round for everybody else. A closed connection
          // throws on write, and that is the ordinary way this happens rather than a fault.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get watching() {
      return listeners.size;
    },
  };
}

/**
 * One event, in the wire format `EventSource` expects.
 *
 * The `event:` line is what lets a browser attach a handler per kind instead of switching on a
 * field, and the blank line at the end is what actually dispatches it — omit it and the client
 * waits forever holding a complete message.
 */
export const frame = (event: LiveEvent): string =>
  `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * A comment line, sent on a timer.
 *
 * Nothing consumes it. It exists because an idle SSE connection is indistinguishable from a dead
 * one to anything in the middle — a proxy, a phone changing network — and they close it. This is
 * the cheapest thing that keeps the connection provably alive.
 */
export const heartbeat = (): string => `: still here\n\n`;
