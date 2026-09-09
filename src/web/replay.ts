import {
  canMove, DIRECTION_NAMES, EXIT, HEIGHT, knowsWall, learn, moved, nothingKnown, START, WIDTH,
  type Direction, type Maze,
} from "../maze/grid.ts";
import { PRICES } from "../maze/runs.ts";

/**
 * A run, precomputed frame by frame, so the front page can play it.
 *
 * The page's job is to make somebody understand this in the time it takes to glance at it, and no
 * sentence does that as well as watching it happen: a maze nobody can see, an agent feeling its way
 * one cell at a time, and a number going up every time it learns something. That is the entire
 * product, and it needs no copy.
 *
 * **The geometry is computed here, not in the browser.** The client gets coordinates and an index
 * per wall and does nothing but toggle classes — so there is one implementation of what a wall is
 * and where it sits, and the animation cannot drift away from the maze it claims to be showing.
 *
 * **It replays a round that has closed.** Animating the live hour would hand away the map we charge
 * a cent for, which is the one thing on the page that must not be free. A finished round costs
 * nobody anything and is just as true.
 *
 * The strategy shown is look-then-step, because it is the one that makes the trade visible: every
 * cell it lights up was paid for, and a run that bought the map instead would reveal everything at
 * once and demonstrate nothing.
 */

/**
 * A wall this run never paid to establish.
 *
 * Not `Infinity`. The value has to survive being written into an HTML attribute and read back, and
 * `Infinity` does not — it became a bare `9999` at the point of use, which is a second
 * representation of the same idea invented where nobody would look for it.
 */
export const NEVER_ESTABLISHED = -1;

/** One interior wall, and the frame at which this run had established it. */
export interface ReplayWall {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** True when the wall is there. A wall proved *open* is drawn as nothing, which is what open is. */
  readonly solid: boolean;
  /** Frame index at which it became known, or `NEVER_ESTABLISHED`. */
  readonly at: number;
}

export interface ReplayFrame {
  readonly x: number;
  readonly y: number;
  /** Cumulative dollars at this frame. */
  readonly spent: number;
}

export interface Replay {
  readonly walls: readonly ReplayWall[];
  readonly frames: readonly ReplayFrame[];
  readonly steps: number;
  readonly spent: number;
  readonly exit: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
}

/** Every interior wall, addressed the one way it can be: as some cell's east or south edge. */
function interiorWalls(): readonly { x: number; y: number; dir: "e" | "s" }[] {
  const walls: { x: number; y: number; dir: "e" | "s" }[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (x < WIDTH - 1) walls.push({ x, y, dir: "e" });
      if (y < HEIGHT - 1) walls.push({ x, y, dir: "s" });
    }
  }
  return walls;
}

export function replayOf(cells: Maze, route: readonly Direction[]): Replay {
  let known = nothingKnown();
  let at = { ...START };
  let spent = 0;

  const frames: ReplayFrame[] = [{ x: at.x, y: at.y, spent }];
  const walls = interiorWalls();
  // Unreached walls are the fog left over when a run gets out without paying to see everything.
  const seenAt = new Map<string, number>();

  const record = (frame: number): void => {
    for (const w of walls) {
      const key = `${w.x},${w.y},${w.dir}`;
      if (!seenAt.has(key) && knowsWall(known, w.x, w.y, w.dir)) seenAt.set(key, frame);
    }
  };
  record(0);

  for (const direction of route) {
    // A look settles every wall around where it stands. This is the purchase that makes the maze
    // appear, and the reason the counter moves faster than the agent does.
    for (const d of DIRECTION_NAMES) known = learn(known, at.x, at.y, d);
    spent += PRICES.look;
    record(frames.length);

    spent += PRICES.move;
    at = moved(at.x, at.y, direction);
    frames.push({ x: at.x, y: at.y, spent: Number(spent.toFixed(3)) });
    record(frames.length - 1);
  }

  return {
    walls: walls.map((w) => {
      const [x1, y1] = w.dir === "e" ? [w.x + 1, w.y] : [w.x, w.y + 1];
      const [x2, y2] = w.dir === "e" ? [w.x + 1, w.y + 1] : [w.x + 1, w.y + 1];
      return {
        x1, y1, x2, y2,
        solid: !canMove(cells, w.x, w.y, w.dir),
        at: seenAt.get(`${w.x},${w.y},${w.dir}`) ?? NEVER_ESTABLISHED,
      };
    }),
    frames,
    steps: route.length,
    spent: Number(spent.toFixed(3)),
    exit: { x: EXIT.x, y: EXIT.y },
    width: WIDTH,
    height: HEIGHT,
  };
}
