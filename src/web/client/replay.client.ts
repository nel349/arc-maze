/**
 * The replay animator, as code a compiler reads.
 *
 * This used to be a string inside `page.ts`. Nothing checked it — not the typechecker, not a
 * linter, and no test could execute it — which is exactly how it came to be placed above the
 * counter it drives, find nothing, and silently give up. The markup was correct, so nothing in the
 * suite noticed; only a person looking at the page did.
 *
 * It is still inlined into the response rather than fetched: the page has to render from a laptop
 * with no network, which is where this gets demonstrated. What changed is that it is now a file
 * with types, transpiled at startup, instead of a literal nobody could check.
 *
 * It knows nothing about mazes. Every wall carries the frame at which the run had paid to establish
 * it, computed in `replay.ts`, so this adds a class and moves a dot and nothing else.
 */

// A frame every this often. Slow enough to read the counter, brisk enough that the whole run lands
// inside the few seconds somebody gives a page before deciding what it is.
const FRAME_MS = 560;
// Then hold on the solved maze, so the last state is the one that registers, before starting again
// from the dark.
const HOLD_MS = 3200;
/** Matches `NEVER_ESTABLISHED` in `replay.ts`: a wall this run never paid to see. */
const NEVER_ESTABLISHED = -1;
/** Cells are one unit wide, so their middle is half a unit in. */
const CELL_MIDDLE = 0.5;

interface Frame {
  readonly x: number;
  readonly y: number;
  readonly spent: number;
}

(function play(): void {
  const svg = document.getElementById("stage-svg");
  const agent = document.getElementById("agent");
  const spend = document.getElementById("spend");
  const data = document.getElementById("replay-data");
  if (svg === null || agent === null || spend === null || data === null) return;

  // Written as JSON in the markup rather than as generated JavaScript: the data is data, and a
  // script tag that cannot be closed early by its own payload is one fewer thing to get wrong.
  let frames: readonly Frame[];
  try {
    frames = JSON.parse(data.textContent ?? "[]") as readonly Frame[];
  } catch {
    return;
  }
  if (frames.length === 0) return;

  const walls = Array.from(svg.querySelectorAll<SVGLineElement>(".w"));

  // Declared as consts rather than hoisted functions: a `function` can be called before the guard
  // above it, so the compiler will not carry the narrowing into one — correctly.
  const paint = (index: number): void => {
    const frame = frames[index];
    if (frame === undefined) return;
    for (const wall of walls) {
      const at = Number(wall.getAttribute("data-at"));
      wall.classList.toggle("known", at !== NEVER_ESTABLISHED && at <= index);
    }
    agent.style.transform =
      `translate(${frame.x + CELL_MIDDLE}px,${frame.y + CELL_MIDDLE}px)`;
    spend.textContent = `$${frame.spent.toFixed(3)}`;
  };

  // Somebody who has asked for less motion gets the finished run rather than no run: the point is
  // what it cost, and that reads perfectly well standing still.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    paint(frames.length - 1);
    return;
  }

  let index = 0;
  let timer = 0;

  const tick = (): void => {
    paint(index);
    index += 1;
    if (index >= frames.length) {
      index = 0;
      timer = window.setTimeout(tick, HOLD_MS);
      return;
    }
    timer = window.setTimeout(tick, FRAME_MS);
  };

  // A run playing to an empty room costs battery and proves nothing.
  document.addEventListener("visibilitychange", () => {
    window.clearTimeout(timer);
    if (!document.hidden) tick();
  });

  tick();
})();
