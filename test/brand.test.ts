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

test("an empty cohort draws the ring without an arc, since nothing is taken", () => {
  expect(cohortPlate(0)).not.toContain("stroke-dasharray");
  expect(cohortPlate(0)).toContain(">000<");
});
