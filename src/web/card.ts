import type { Board } from "../maze/boards.ts";
import type { Round } from "../maze/round.ts";
import { arcRing, PAPER } from "./brand.ts";

/**
 * The link, which is the product.
 *
 * Nothing on Arc indexes sellers — every catalogue either does not settle Arc or is maintained by
 * hand — so the only distribution channel that needs nobody's permission is a URL somebody pastes.
 * That makes what a pasted URL *becomes* in a chat window the whole of discovery.
 *
 * The shape is taken from `kuira-offer-links` rather than rediscovered, and two of its lessons are
 * load-bearing here:
 *
 * - **The card is a preview, not a control.** It advertises; the page is where anything happens.
 *   In-feed buttons were tried there and flopped.
 * - **Status is reported honestly.** An hour that has closed says so on the card. A link that
 *   claims a race is live when it ended is worth less than no link.
 *
 * One lesson we cannot yet follow: `og:image` has to be a **PNG**, because Telegram, Discord and X
 * do not render an SVG one — proven live over there. Rasterising needs a font rasteriser, which is
 * a dependency, so this ships the SVG and the text unfurl, and the picture waits on that call.
 */

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** What every social card is, and has been since 2010. */
const WIDTH = 1200;
const HEIGHT = 630;

export interface Unfurl {
  readonly title: string;
  readonly description: string;
  /** Absolute, because a relative `og:` URL is ignored by every crawler that reads it. */
  readonly url: string;
  readonly image: string | null;
}

/**
 * What a round says about itself when its link is pasted.
 *
 * The description carries the numbers rather than adjectives, because the numbers are the pitch:
 * a tenth of a cent a step is a claim nobody has to be sold on.
 */
export function unfurlFor(round: Round, open: boolean, boards: readonly Board[], base: string): Unfurl {
  const best = boards.find((b) => b.kind === "fewest-steps")?.entries[0];
  const standing = best === undefined
    ? "Nobody has solved it yet."
    : `Best so far ${best.steps} steps for $${best.spentUsd.toFixed(3)}.`;

  return {
    title: `Cohort 0 · round ${round.id}${open ? "" : " (closed)"}`,
    description:
      `A maze on Arc that charges by the step and pays out reputation. ` +
      `${round.optimalSteps} steps is perfect. ${standing} ` +
      `Every move costs a tenth of a cent over x402 — no account, no card, no signup.`,
    url: `${base}/round/${round.id}`,
    image: base === "" ? null : `${base}/round/${round.id}/card.svg`,
  };
}

/** The `<head>` half. Twitter reads its own names and falls back to `og:`, so both are given. */
export function unfurlMeta(unfurl: Unfurl): string {
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Cohort 0">`,
    `<meta property="og:title" content="${esc(unfurl.title)}">`,
    `<meta property="og:description" content="${esc(unfurl.description)}">`,
    `<meta name="description" content="${esc(unfurl.description)}">`,
    `<meta name="twitter:title" content="${esc(unfurl.title)}">`,
    `<meta name="twitter:description" content="${esc(unfurl.description)}">`,
  ];
  // Omitted rather than pointed at nothing: a card that promises an image and fails to load one
  // unfurls worse than a card that never promised.
  if (unfurl.url !== "") tags.push(`<meta property="og:url" content="${esc(unfurl.url)}">`);
  if (unfurl.image !== null) {
    tags.push(
      `<meta property="og:image" content="${esc(unfurl.image)}">`,
      `<meta property="og:image:width" content="${WIDTH}">`,
      `<meta property="og:image:height" content="${HEIGHT}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${esc(unfurl.image)}">`,
    );
  } else {
    tags.push(`<meta name="twitter:card" content="summary">`);
  }
  return tags.join("");
}

/**
 * The card itself, self-contained: no external font, no external image, nothing to fetch.
 *
 * A crawler renders this in isolation with no stylesheet and no network, so every colour is a
 * literal here rather than a token. It is the one place in this project where that is right.
 */
export function cardSvg(round: Round, open: boolean, boards: readonly Board[], now = Date.now()): string {
  const best = boards.find((b) => b.kind === "fewest-steps")?.entries[0];
  const cheapest = boards.find((b) => b.kind === "least-spent")?.entries[0];

  // Literals, not tokens: a crawler renders this on its own with no stylesheet, so `var()` would
  // resolve to nothing and the card would arrive blank. The palette is still the source.
  const ink = PAPER;

  const line = (y: number, size: number, fill: string, weight: string, text: string): string =>
    `<text x="80" y="${y}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" ` +
    `font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(text)}</text>`;

  /**
   * The ring, given the one bounded quantity a round actually has: its hour.
   *
   * A limit and how much of it is gone is the mark's meaning everywhere else; here the limit is
   * sixty minutes. It costs no chain call, it is true at the moment the card is fetched, and it
   * turns the accent into a warning exactly when the round is nearly over — which is the one thing
   * a person seeing a shared link needs to know before clicking it.
   */
  const elapsed = open
    ? (now - round.openedAt.getTime()) / (round.closesAt.getTime() - round.openedAt.getTime())
    : 1;
  const minutesLeft = Math.max(0, Math.ceil((round.closesAt.getTime() - now) / 60_000));
  const ring = arcRing(elapsed, {
    size: 200,
    palette: ink,
    label: open ? `${minutesLeft} minutes left in this round` : "this round has closed",
  });

  const status = open ? `● open · ${minutesLeft} min left` : "● closed";
  const statusFill = open ? ink.good : ink.muted;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" `,
    `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(`Cohort 0, round ${round.id}`)}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${ink.ground}"/>`,
    `<rect x="0" y="0" width="${WIDTH}" height="14" fill="${ink.signal}"/>`,
    line(140, 30, ink.muted, "500", "COHORT 0 · A MAZE ON ARC"),
    line(215, 62, ink.text, "700", `round ${round.id}`),
    line(275, 30, statusFill, "500", `${status} · ${round.optimalSteps} steps is perfect`),
    line(370, 34, ink.text, "500",
      best === undefined ? "Nobody has solved it yet" : `Fewest steps  ${best.steps}  ·  $${best.spentUsd.toFixed(3)}`),
    line(420, 34, ink.text, "500",
      cheapest === undefined ? "" : `Least spent   ${cheapest.steps} steps  ·  $${cheapest.spentUsd.toFixed(3)}`),
    line(520, 28, ink.muted, "400", "a step $0.001 · a look $0.002 · the map $0.01"),
    line(562, 28, ink.muted, "400", "paid over x402 — no account, no card, no signup"),
    `<g transform="translate(900 215)">${ring}</g>`,
    `</svg>`,
  ].join("");
}

export { WIDTH as CARD_WIDTH, HEIGHT as CARD_HEIGHT };
