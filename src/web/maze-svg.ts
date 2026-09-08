import {
  canMove, EXIT, HEIGHT, knowsWall, WIDTH,
  type Known, type Maze, type Point,
} from "../maze/index.ts";

/**
 * The maze as a drawing rather than as characters.
 *
 * Box-drawing glyphs were the wrong medium: they depend on the reader's monospace font, they break
 * apart at fractional sizes, and a dotted wall reads as a printer running out of ink rather than as
 * something unknown.
 *
 * The approach here is the standard one for maze SVG rather than anything invented — see
 * https://kld.dev/svg-maze/. Three parts of it matter:
 *
 * - **One unit per cell.** The viewBox is the grid, so every coordinate is a whole number and the
 *   drawing scales to any size without a single pixel calculation.
 * - **`stroke: currentColor`, `fill: none`.** Colour comes from CSS, so the same markup follows the
 *   page into dark mode with nothing to keep in sync.
 * - **Stroke width carries hierarchy.** The outer wall is drawn heavier than the interior, which is
 *   what makes the shape read as a room rather than a grid.
 *
 * What is ours is the fog: walls are drawn in two paths, what this run established and what it has
 * not tested, and every untested wall is drawn identically whether it is open or shut. That is the
 * difference between a fog and a preview.
 */

/** One unit per cell, with room at the edges so a thick outer stroke is not clipped. */
const PAD = 0.2;
const OUTER = 0.16;
const INNER = 0.07;

const line = (x1: number, y1: number, x2: number, y2: number): string =>
  `M${x1} ${y1}L${x2} ${y2}`;

export interface MazeDrawing {
  /** Complete `<svg>` markup. Colour and size come from CSS. */
  readonly svg: string;
  /** How many interior walls this run has settled, out of how many there are. */
  readonly learned: number;
  readonly total: number;
}

export function drawMaze(cells: Maze, known: Known, agent?: Point): MazeDrawing {
  const solid: string[] = [];
  const fog: string[] = [];
  let learned = 0;
  let total = 0;

  // Only the east and south walls of each cell are drawn: every interior wall is one cell's east
  // or another's south, and the outer boundary is the rect below. Drawing all four would stroke
  // every interior wall twice, which shows as a heavier line wherever two cells meet.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      for (const [dir, from, to] of [
        ["e", [x + 1, y], [x + 1, y + 1]],
        ["s", [x, y + 1], [x + 1, y + 1]],
      ] as const) {
        const interior = dir === "e" ? x < WIDTH - 1 : y < HEIGHT - 1;
        if (!interior) continue;
        total += 1;

        const [x1, y1] = from;
        const [x2, y2] = to;
        if (!knowsWall(known, x, y, dir)) {
          fog.push(line(x1, y1, x2, y2));
          continue;
        }
        learned += 1;
        // A wall it proved open is drawn as nothing at all — that is what open means.
        if (!canMove(cells, x, y, dir)) solid.push(line(x1, y1, x2, y2));
      }
    }
  }

  const been = [...known.visited]
    .map((i) => [i % WIDTH, Math.floor(i / WIDTH)] as const)
    .filter(([x, y]) => !(agent?.x === x && agent?.y === y))
    .map(([x, y]) => `<circle cx="${x + 0.5}" cy="${y + 0.5}" r="0.07" class="been"/>`)
    .join("");

  const here = agent === undefined
    ? ""
    : `<circle cx="${agent.x + 0.5}" cy="${agent.y + 0.5}" r="0.22" class="here"/>`;

  // The exit is a constant, not something anybody buys, so it is always drawn.
  const exit = `<circle cx="${EXIT.x + 0.5}" cy="${EXIT.y + 0.5}" r="0.26" class="exit"/>`;

  const view = `${-PAD} ${-PAD} ${WIDTH + PAD * 2} ${HEIGHT + PAD * 2}`;
  const svg = [
    `<svg class="maze" viewBox="${view}" role="img"`,
    ` aria-label="The maze, showing the ${learned} of ${total} inner walls this run has paid to learn">`,
    `<g fill="none" stroke-linecap="round">`,
    fog.length === 0 ? "" : `<path class="fog" d="${fog.join("")}" stroke-width="${INNER}"/>`,
    solid.length === 0 ? "" : `<path class="wall" d="${solid.join("")}" stroke-width="${INNER}"/>`,
    `<rect class="edge" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="0.1" stroke-width="${OUTER}"/>`,
    `</g>${been}${exit}${here}</svg>`,
  ].join("");

  return { svg, learned, total };
}

/**
 * Everything the drawing needs from a stylesheet, kept beside the markup that relies on it.
 *
 * Untested walls get a **real colour**, not a dimmed one. A faint grey wall reads as a page that
 * has not finished loading; a blue one reads as a wall of a different kind, which is what it is.
 * Four colours, four meanings, and the legend can name them.
 */
export const MAZE_CSS = `
svg.maze{width:100%;max-width:20rem;height:auto;display:block}
svg.maze .fog{stroke:var(--untested)}
svg.maze .wall{stroke:var(--ink)}
svg.maze .edge{stroke:var(--ink)}
svg.maze .been{fill:var(--untested)}
svg.maze .here{fill:var(--accent)}
svg.maze .exit{fill:none;stroke:var(--good);stroke-width:.1}
`;
