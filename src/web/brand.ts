/**
 * The brand, as roles rather than colours.
 *
 * Every name here says what a thing *means* — the ground, the number that matters, the wall nobody
 * has tested — so a palette can be swapped without a single component learning which one it is in.
 * The set is the one shared with the phone app, and deliberately smaller than the phone's own:
 * `glass`, `specular` and the three ground stops describe dark glass over a gradient, which is a
 * metaphor a flat page does not have and should not pretend to.
 *
 * **`paper` is not here on purpose.** On the phone it means the brightest *text*; on a page with a
 * light ground it reads as the background. A name that means two opposite things is the one thing a
 * shared vocabulary must not ship, so the shared name for type is `text`.
 *
 * Structure — spacing, radii, type scale — is not themeable, for the reason the phone's `tokens.ts`
 * gives: a theme that can move layout is a second layout in disguise, and the second one is the one
 * nobody tested.
 */

export interface Palette {
  /** What everything sits on. */
  readonly ground: string;
  /** A thing raised off the ground: a panel, a card. */
  readonly surface: string;
  /** The hairline that closes a shape. */
  readonly edge: string;
  /** Primary and secondary type. */
  readonly text: string;
  readonly muted: string;
  /**
   * The number that matters, and nothing else — nearly out of allowance, where the agent is
   * standing. Never decoration: a page that spends this on flavour has no way left to warn.
   */
  readonly signal: string;
  /**
   * Established's opposite. A wall nobody paid to test, an allowance granted but unspent, a
   * payment claimed but not settled. One colour for one idea, on every surface.
   */
  readonly untested: string;
  /** It landed. */
  readonly good: string;
}

/** Near-black. The default, as on the phone. */
export const MACHINE: Palette = {
  ground: "#12110f",
  surface: "#1c1a17",
  edge: "#302e28",
  text: "#eae7de",
  muted: "#8a857a",
  signal: "#e8874a",
  untested: "#7aa6d8",
  good: "#6bbf8f",
};

/** Paper. What a browser opens with unless it is told otherwise. */
export const PAPER: Palette = {
  ground: "#faf9f7",
  surface: "#ffffff",
  edge: "#e3e0d9",
  text: "#12110f",
  muted: "#6b6862",
  signal: "#b4541f",
  untested: "#5d86b8",
  good: "#2f6f4f",
};

const scaleFonts = {
  sans: `system-ui,-apple-system,"Segoe UI",sans-serif`,
  mono: `ui-monospace,SFMono-Regular,Menlo,monospace`,
} as const;

/**
 * Both palettes, as custom properties.
 *
 * Light is defined on bare `:root` so it applies with no media query at all — a viewer whose
 * browser reports nothing still gets a complete set. Dark redefines only the values, guarded so an
 * explicit light choice beats a dark system, and `[data-theme]` redefines them again so a toggle
 * wins either way. No colour is ever defined *only* inside a media block, which is the classic way
 * a page ends up rendering one theme's text on the other theme's ground.
 */
export const PALETTE_CSS = `
:root{${vars(PAPER)}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(MACHINE)}}}
:root[data-theme="dark"]{${vars(MACHINE)}}
:root[data-theme="light"]{${vars(PAPER)}}
`;

function vars(p: Palette): string {
  return Object.entries(p).map(([role, value]) => `--${role}:${value}`).join(";") + ";";
}

/**
 * Structure as custom properties. Separate from the palette because it is *not* themeable — the
 * same reason the phone keeps `tokens.ts` apart from `themes.ts`: a theme that can move type or
 * spacing is a second layout, and the second one is the one nobody tested.
 */
export const STRUCTURE_CSS = `
:root{--sans:${scaleFonts.sans};--mono:${scaleFonts.mono}}
`;

/** Structure. The same in every palette, which is what makes a palette safe to swap. */
export const scale = {
  space: { xs: ".35rem", sm: ".6rem", md: "1rem", lg: "1.5rem", xl: "2.5rem" },
  radius: { sm: "4px", md: "10px", pill: "999px" },
  edge: "1px",
  font: scaleFonts,
} as const;

/**
 * The mark: a ring, drawn part-way round.
 *
 * The full circle is a limit and the drawn part is what is gone, which is the whole product in one
 * shape — and unusually for a mark, **both extremes mean something**. An untouched allowance and an
 * exhausted one are the two states somebody opens the app to tell apart, and they are opposite
 * pictures rather than two similar ones.
 *
 * `fraction` is clamped rather than trusted: a spend can exceed its limit when a limit is lowered
 * after the fact, and a ring that wraps past its own start reads as empty.
 */
export function arcRing(fraction: number, options: { readonly size?: number; readonly label?: string } = {}): string {
  const size = options.size ?? 96;
  const filled = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const RADIUS = 40;
  const circumference = 2 * Math.PI * RADIUS;
  const drawn = (circumference * filled).toFixed(2);

  // Near the top the ring stops being information and starts being a warning, so the colour that
  // is reserved for the number that matters arrives here and nowhere earlier.
  const stroke = filled >= 0.9 ? "var(--signal)" : "var(--text)";
  const label = options.label ?? `${Math.round(filled * 100)}% spent`;

  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" ` +
    `aria-label="${label.replace(/"/g, "&quot;")}">` +
    `<circle cx="50" cy="50" r="${RADIUS}" fill="none" stroke="var(--edge)" stroke-width="9"/>` +
    (filled > 0
      ? `<circle cx="50" cy="50" r="${RADIUS}" fill="none" stroke="${stroke}" stroke-width="9" ` +
        `stroke-linecap="round" stroke-dasharray="${drawn} ${circumference.toFixed(2)}" ` +
        `transform="rotate(-90 50 50)"/>`
      : "") +
    `</svg>`;
}

/**
 * The cohort plate: a number inside the ring, where the arc marks how much of the cohort is taken.
 *
 * The two marks are one object rather than two drawings — which is the point of having a motif at
 * all, and the reason the badge and the favicon are the same geometry with different numbers.
 */
export function cohortPlate(minted: number, size = 150, of = 100): string {
  const filled = Math.max(0, Math.min(1, minted / of));
  const RADIUS = 42;
  const circumference = 2 * Math.PI * RADIUS;
  const closed = minted >= of;

  return `<svg class="plate" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" ` +
    `aria-label="${minted} of ${of} places taken">` +
    `<circle cx="50" cy="50" r="${RADIUS}" fill="none" stroke="var(--text)" stroke-width="3"/>` +
    (minted > 0
      ? `<circle cx="50" cy="50" r="${RADIUS}" fill="none" stroke="var(--signal)" stroke-width="3" ` +
        `${closed ? "" : 'stroke-linecap="round" '}` +
        `stroke-dasharray="${(circumference * filled).toFixed(2)} ${circumference.toFixed(2)}" ` +
        `transform="rotate(-90 50 50)"/>`
      : "") +
    `<text x="50" y="46" text-anchor="middle" font-family="${scale.font.mono}" font-size="26" ` +
    `font-weight="700" fill="var(--text)">${String(minted).padStart(3, "0")}</text>` +
    `<text x="50" y="64" text-anchor="middle" font-family="${scale.font.mono}" font-size="11" ` +
    `fill="var(--muted)">${closed ? "CLOSED" : `OF ${of}`}</text>` +
    `</svg>`;
}
