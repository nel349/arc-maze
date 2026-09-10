import { expect, test } from "bun:test";
import { arcRing, cohortPlate, MACHINE, PALETTE_CSS, PAPER, type Palette } from "../src/web/brand.ts";

/**
 * The palette is a rule, not a look, so what is worth testing is the rule: that both palettes
 * answer every role, that no colour exists only inside a media query, and that the mark tells the
 * truth about numbers it cannot trust.
 */

const ROLES: readonly (keyof Palette)[] =
  ["ground", "surface", "edge", "text", "muted", "signal", "untested", "good"];

test("both palettes answer every role, so a swap cannot leave a hole", () => {
  for (const palette of [PAPER, MACHINE]) {
    for (const role of ROLES) {
      expect(palette[role]).toMatch(/^#[0-9a-f]{6}$/);
    }
  }
});

test("the two palettes are genuinely different, not one copied over the other", () => {
  const shared = ROLES.filter((r) => PAPER[r] === MACHINE[r]);
  expect(shared).toEqual([]);
});

/**
 * The classic unreadable-page bug: a colour whose only definition sits behind a media query, so a
 * browser reporting no preference renders one theme's text on the other theme's ground.
 */
test("every role is defined on bare :root, before any media query", () => {
  const bare = PALETTE_CSS.slice(PALETTE_CSS.indexOf(":root{"), PALETTE_CSS.indexOf("@media"));
  for (const role of ROLES) expect(bare).toContain(`--${role}:`);
});

test("an explicit choice wins in both directions", () => {
  // A dark system with a light choice, and a light system with a dark one.
  expect(PALETTE_CSS).toContain(`:root:not([data-theme="light"])`);
  expect(PALETTE_CSS).toContain(`:root[data-theme="dark"]`);
  expect(PALETTE_CSS).toContain(`:root[data-theme="light"]`);
});

test("nothing in the shared set is named paper, which means opposite things in the two apps", () => {
  expect(PALETTE_CSS).not.toContain("--paper");
  expect(ROLES).not.toContain("paper" as keyof Palette);
});

// ---- the ring ---------------------------------------------------------------

test("an untouched allowance draws no arc at all, and a spent one draws the whole ring", () => {
  expect(arcRing(0)).not.toContain("stroke-dasharray");
  const full = arcRing(1);
  const circumference = (2 * Math.PI * 40).toFixed(2);
  expect(full).toContain(`stroke-dasharray="${circumference} ${circumference}"`);
});

/**
 * A limit can be lowered below what is already spent — the app supports it deliberately, as a way
 * to stop an agent. The ring must not wrap past its own start, because a ring that has gone all the
 * way round twice looks exactly like one that has not started.
 */
test("a fraction outside nought and one is clamped rather than drawn", () => {
  const circumference = (2 * Math.PI * 40).toFixed(2);
  expect(arcRing(1.8)).toContain(`stroke-dasharray="${circumference}`);
  expect(arcRing(-3)).not.toContain("stroke-dasharray");
  expect(arcRing(Number.NaN)).not.toContain("stroke-dasharray");
});

test("the colour reserved for what matters arrives near the top, and not before", () => {
  expect(arcRing(0.5)).toContain("var(--text)");
  expect(arcRing(0.5)).not.toContain("var(--signal)");
  expect(arcRing(0.95)).toContain("var(--signal)");
});

/**
 * The threshold is nine tenths, and nine tenths is inside it.
 *
 * Testing 0.95 leaves the boundary itself free to move: `>= 0.9` and `> 0.9` both pass, so the one
 * number the rule is written in terms of was the one number not checked.
 */
test("nine tenths spent is already the warning, not one step short of it", () => {
  expect(arcRing(0.9)).toContain("var(--signal)");
  expect(arcRing(0.899)).not.toContain("var(--signal)");
});

test("the ring says what it is, for anyone who cannot see it", () => {
  expect(arcRing(0.35)).toContain('aria-label="35% spent"');
  expect(arcRing(0.35, { label: 'a "quoted" state' })).toContain("&quot;quoted&quot;");
});

test("every colour comes from the palette, so the mark follows the theme with no second drawing", () => {
  for (const svg of [arcRing(0.5), cohortPlate(45)]) {
    expect(svg).not.toMatch(/#[0-9a-fA-F]{6}/);
  }
});

// ---- the plate --------------------------------------------------------------

test("the plate pads its number and counts what is left", () => {
  expect(cohortPlate(1)).toContain(">001<");
  expect(cohortPlate(1)).toContain("OF 100");
  expect(cohortPlate(45)).toContain(">045<");
});

test("a closed cohort says so, rather than counting to a hundred out of a hundred", () => {
  const closed = cohortPlate(100);
  expect(closed).toContain(">100<");
  expect(closed).toContain("CLOSED");
  expect(closed).not.toContain("OF 100");
});

/**
 * A part-full cohort draws a part-full arc, of the right length.
 *
 * The tests around this one all read the *number* in the middle, which meant the arc could vanish
 * entirely and nothing said so: replacing the clamp's `Math.max` with `Math.min` pins the fraction
 * at nought, drops the arc, and left every assertion true. The arc is the half that says "nearly
 * gone" from across a room — it is the point of the plate.
 */
test("a part-taken cohort draws an arc of the matching length", () => {
  const circumference = 2 * Math.PI * 42;
  const drawn = (circumference * 0.45).toFixed(2);
  expect(cohortPlate(45)).toContain(`stroke-dasharray="${drawn} ${circumference.toFixed(2)}"`);
});

test("an empty cohort draws the ring without an arc, since nothing is taken", () => {
  expect(cohortPlate(0)).not.toContain("stroke-dasharray");
  expect(cohortPlate(0)).toContain(">000<");
});

// ---- the maze drawing, which is what a person actually looks at -------------

/**
 * The SVG map, pinned.
 *
 * Every mutation inside `drawMaze` survived: the wall geometry, the fog boundary and the agent
 * marker could all move and the suite stayed green, because nothing asserted what came out. It is
 * the picture the run page is built around and the thing the user judged as "a paper running out of
 * ink" — precisely the sort of output where a silent change is only ever caught by eye.
 *
 * Two states are pinned because they are different drawings, not one drawing with a flag: a run
 * that has bought the map sees every wall, and a fresh run sees the fog.
 */
test("the drawing of a fully-known maze is exactly what it has been", async () => {
  const { createHash } = await import("node:crypto");
  const { generate, everythingKnown } = await import("../src/maze/index.ts");
  const { drawMaze } = await import("../src/web/maze-svg.ts");

  const drawing = drawMaze(generate("2026-09-07T05"), everythingKnown(), { x: 2, y: 3 });
  expect(createHash("sha256").update(drawing.svg).digest("hex").slice(0, 16)).toBe("0da0ace5ccefa426");
  expect(drawing.learned).toBe(drawing.total);
});

test("and the fogged drawing is a different picture, not the same one dimmed", async () => {
  const { createHash } = await import("node:crypto");
  const { generate, nothingKnown } = await import("../src/maze/index.ts");
  const { drawMaze } = await import("../src/web/maze-svg.ts");

  const drawing = drawMaze(generate("2026-09-07T05"), nothingKnown(), { x: 2, y: 3 });
  expect(createHash("sha256").update(drawing.svg).digest("hex").slice(0, 16)).toBe("2da8fa5ada65b316");
  // Nothing walked yet, so nothing is established — the counter the page shows as progress.
  expect(drawing.learned).toBe(0);
  expect(drawing.total).toBeGreaterThan(0);
});

/**
 * And a run partway through, which is the state the page is actually rendered in.
 *
 * The two drawings above pin nothing about the breadcrumb trail, because neither has visited a
 * cell: the filter that stops a crumb being drawn *under* the agent never runs, so turning its
 * `&&` into an `||` — which drops every crumb sharing a row or column with the agent — changed
 * nothing either could see. Six crumbs for seven visited cells is the whole assertion: one of them
 * is where the agent is standing, and the agent is drawn instead.
 */
test("a run partway through draws its trail, minus the cell it is standing on", async () => {
  const { createHash } = await import("node:crypto");
  const { RunStore, round, move, published, discovered } = await import("../src/maze/index.ts");
  const { drawMaze } = await import("../src/web/maze-svg.ts");

  const id = "2026-09-07T05";
  const run = new RunStore().start({ roundId: id, payer: "0x1111111111111111111111111111111111111111" });
  for (const direction of round(id).optimalRoute.slice(0, 6)) move(run, direction, true);

  const drawing = drawMaze(round(id).cells, discovered(published(run)), run.at);
  expect(drawing.svg.match(/class="been"/g) ?? []).toHaveLength(6);
  expect(drawing.svg).toContain('class="here"');
  expect(drawing.learned).toBe(6);
  expect(createHash("sha256").update(drawing.svg).digest("hex").slice(0, 16)).toBe("8b1fb3a3a28fdecd");
});

/**
 * No backticks inside the stylesheet, because the stylesheet is a template literal.
 *
 * A backtick in a CSS comment ends the string, and what follows is read as TypeScript. It is a
 * syntax error rather than a subtle one, so it never ships, but it has now cost three separate
 * debugging detours in this file alone: the natural way to write a CSS comment about a property is
 * to quote the property, and quoting in this codebase means a backtick.
 *
 * The compiler catches it every time. This catches it before the compiler does, and says why.
 */
test("the stylesheet contains no backticks, which would end the template literal it lives in", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/web/page.ts", import.meta.url), "utf8");

  const from = source.indexOf("const CSS =");
  const css = source.slice(source.indexOf("`", from) + 1);
  const end = css.indexOf("\n`;");
  expect(end).toBeGreaterThan(0);

  // Interpolations are how the palette gets in, so only a bare backtick is the problem.
  const body = css.slice(0, end).replace(/\$\{[^}]*\}/g, "");
  expect(body).not.toContain("`");
});
