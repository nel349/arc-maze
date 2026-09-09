import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canMove, EXIT, exits, generate, HEIGHT, moved, render, round, shortestPath, START, WIDTH,
  type Direction, type Maze, type Point,
} from "../src/maze/index.ts";

/**
 * The generator and the route, which every other claim rests on.
 *
 * Mutation testing found this hole: changing the seed derivation so every maze came out different
 * left the whole suite green. The existing tests ask whether generation is *deterministic* — the
 * same id twice gives the same maze — and that stays true when the maze changes, because both
 * halves change together. Nothing said which maze.
 *
 * That matters more here than in most projects. A run is replayed against a maze rebuilt from its
 * round id (`/run/:id/verify`), and the efficiency written onto an agent's ERC-8004 identity is its
 * steps against `optimalSteps`. Change the generator and every historical run fails to verify and
 * every score already on chain becomes incomparable — silently, because nothing recomputes.
 */

// ---- the maze is fixed, not merely repeatable ------------------------------

const fingerprint = (cells: Maze): string =>
  createHash("sha256").update(cells.join(",")).digest("hex").slice(0, 16);

/**
 * Recorded from the generator that served the live runs, including the round that minted Cohort 0
 * badge #2. If one of these changes, the generator changed, and every record written before it is
 * no longer reproducible. That is a decision to take deliberately — so this test is the thing that
 * makes it a decision rather than an accident.
 */
const GOLDEN = [
  { id: "2026-09-01T00", cells: "4fb638ebd8ba0d1a", steps: 30 },
  { id: "2026-09-07T05", cells: "356181353d8c24df", steps: 16 },
  { id: "2026-09-08T23", cells: "5872a2a98703f3f0", steps: 18 },
] as const;

test("the maze for a given hour is fixed forever, not merely stable within one process", () => {
  for (const { id, cells, steps } of GOLDEN) {
    expect(fingerprint(generate(id))).toBe(cells);
    expect(round(id).optimalSteps).toBe(steps);
  }
});

test("the maze fills the whole grid, so no cell is unreachable by construction", () => {
  expect(generate("2026-09-07T05")).toHaveLength(WIDTH * HEIGHT);
});

// ---- the route is walkable, for every hour ---------------------------------

/** Walk a route from the start, refusing to pass through a wall. Returns where it ends, or null. */
function walk(cells: Maze, route: readonly Direction[]): Point | null {
  let at: Point = START;
  for (const direction of route) {
    if (!canMove(cells, at.x, at.y, direction)) return null;
    at = moved(at.x, at.y, direction);
  }
  return at;
}

/**
 * The claim the price list depends on. Every step is charged for, so a route that crosses a wall or
 * stops short is not a cosmetic bug — it is an agent paying real money to follow our own advice
 * into a dead end, and an `optimalSteps` that makes a perfect run score less than 100.
 *
 * Every hour, not just the hour the suite happens to run in: the old tests walked
 * `round(roundIdAt()).optimalRoute`, so a generator that broke one hour in twenty-four would be
 * caught only by whoever was unlucky.
 */
test("every hour's optimal route walks to the exit without crossing a wall", () => {
  for (let hour = 0; hour < 24; hour++) {
    const id = `2026-09-07T${String(hour).padStart(2, "0")}`;
    const { cells, optimalRoute, optimalSteps } = round(id);
    const ended = walk(cells, optimalRoute);
    expect({ hour, ended }).toEqual({ hour, ended: EXIT });
    expect({ hour, steps: optimalRoute.length }).toEqual({ hour, steps: optimalSteps });
  }
});

/**
 * And it is the *shortest* route, checked against a flood fill rather than against `shortestPath`
 * itself — a test that asks the implementation to confirm its own answer agrees with any bug in it.
 */
test("the optimal route is genuinely the shortest, measured independently", () => {
  for (let hour = 0; hour < 24; hour++) {
    const id = `2026-09-07T${String(hour).padStart(2, "0")}`;
    const { cells, optimalSteps } = round(id);

    // Flood outward from the start one ring at a time; the ring the exit lands in is its distance.
    const distance = new Map<number, number>([[START.y * WIDTH + START.x, 0]]);
    let frontier: Point[] = [START];
    while (frontier.length > 0) {
      const next: Point[] = [];
      for (const here of frontier) {
        const d = distance.get(here.y * WIDTH + here.x)!;
        for (const direction of exits(cells, here.x, here.y)) {
          const there = moved(here.x, here.y, direction);
          const key = there.y * WIDTH + there.x;
          if (distance.has(key)) continue;
          distance.set(key, d + 1);
          next.push(there);
        }
      }
      frontier = next;
    }
    expect({ hour, d: distance.get(EXIT.y * WIDTH + EXIT.x) }).toEqual({ hour, d: optimalSteps });
  }
});

test("a maze with no way out is refused rather than sold", () => {
  // Every cell walled in: `shortestPath` must answer null rather than a route that cannot be walked.
  expect(shortestPath(new Array<number>(WIDTH * HEIGHT).fill(0))).toBeNull();
});

// ---- the map, which is the most expensive thing on the price list ----------

/**
 * `render` is sold for $0.01 — five times a look and ten times a step — and every mutation to it
 * survived. A buyer who pays for the map and gets a picture of a different maze has been sold
 * nothing, and would find out only by walking into a wall they were told was open.
 */
test("the map that is sold shows the same walls the maze charges for", () => {
  const cells = generate("2026-09-07T05");
  const lines = render(cells).split("\n");

  // One line per row plus the line below it, and a top border.
  expect(lines).toHaveLength(HEIGHT * 2 + 1);

  for (let y = 0; y < HEIGHT; y++) {
    const middle = lines[y * 2 + 1]!;
    for (let x = 0; x < WIDTH; x++) {
      // Each cell occupies three columns then its east wall, after the leading border.
      const wall = middle[1 + x * 4 + 3];
      const open = canMove(cells, x, y, "e");
      expect({ x, y, drawn: wall === " " }).toEqual({ x, y, drawn: open });
    }
  }
});

/**
 * The frame, pinned whole.
 *
 * Checking the walls cell by cell leaves the box-drawing itself unasserted — the junctions and the
 * corners — and every mutation to those survived: a map framed in the wrong characters still passed.
 * It is the same argument as the golden maze. This is a thing we sell, so what we sell is recorded,
 * and changing it has to be a decision somebody makes on purpose.
 */
test("the whole map is drawn exactly as it has been sold", () => {
  const expected = [
    "┌───┬───┬───┬───┬───┬───┐",
    "│   │           │       │",
    "├   ┼   ┼───┼   ┼───┼   ┤",
    "│       │       │       │",
    "├───┼───┼   ┼───┼   ┼───┤",
    "│       │       │       │",
    "├   ┼───┼───┼   ┼   ┼   ┤",
    "│         ◆ │   │   │   │",
    "├   ┼───┼   ┼   ┼───┼   ┤",
    "│   │   │   │   │       │",
    "├   ┼   ┼   ┼   ┼   ┼   ┤",
    "│       │           │ ★ │",
    "└───┴───┴───┴───┴───┴───┘",
  ].join("\n");
  expect(render(generate("2026-09-07T05"), { x: 2, y: 3 })).toBe(expected);
});

test("the map marks where the agent is, and where it is going", () => {
  const cells = generate("2026-09-07T05");
  const drawn = render(cells, { x: 2, y: 3 });
  expect(drawn).toContain("◆");
  expect(drawn).toContain("★");
  // The exit marker is not drawn over by the agent unless the agent is standing on it.
  expect(render(cells, EXIT)).not.toContain("★");
  // And with nobody playing, there is no agent on the map at all.
  expect(render(cells)).not.toContain("◆");
});
