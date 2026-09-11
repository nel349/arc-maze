import { readFileSync } from "node:fs";
import type { Board, Entry } from "../maze/boards.ts";
import type { Cohort } from "../arc/badge.ts";
import type { Outcome, PublishedRun, RunSummary } from "../maze/runs.ts";
import { PRICES } from "../maze/runs.ts";
import type { Round } from "../maze/round.ts";
import { MAZE_CSS, type MazeDrawing } from "./maze-svg.ts";
import { arcRing, cohortPlate, MACHINE, paletteVars, PALETTE_CSS, STRUCTURE_CSS } from "./brand.ts";
import type { Replay } from "./replay.ts";
import { unfurlMeta, type Unfurl } from "./card.ts";
import type { Endpoint } from "../routes.ts";
import { BEFORE_PAYING, STEPS, TERMS } from "../journey.ts";
import { PAGES, roundHref, runHref } from "../paths.ts";

/**
 * The half a person looks at.
 *
 * Everything this server does is for an agent, and every route answers JSON because that is what
 * an agent reads. But the addresses travel: a reputation record written on chain quotes a `/run`
 * URL forever, a tournament link gets pasted into a chat, and a judge opens the root. All of those
 * are people, and `{"error":"not found"}` is what they were getting.
 *
 * So the same routes answer twice, decided by the `Accept` header the client already sends.
 * Browsers ask for `text/html` and get a page; agents ask for anything else and get exactly the
 * JSON they got before. One handler, one set of numbers, no second source of truth — a separate
 * front end would be a second place for the board to be wrong.
 *
 * No framework and no external fetch: the page has to render from a laptop with no network, which
 * is where this gets demonstrated.
 */

/** Browsers ask for HTML by name. Agents, curl and fetch do not. */
export const wantsHtml = (request: Request): boolean =>
  (request.headers.get("accept") ?? "").includes("text/html");

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Enough to read a run's shape without rendering an unbounded list into a page. */
const SHOWN_ACTIONS = 60;

const usd = (n: number): string => `$${n.toFixed(3).replace(/0$/, "")}`;
const short = (a: string | null): string => (a === null ? "—" : `${a.slice(0, 6)}…${a.slice(-4)}`);

/** What the map costs, counted in steps: the one number that decides which board it helps. */
const MAP_IN_STEPS = Math.round(PRICES.map / PRICES.move);

/** How many rows the list of runs draws. The JSON carries every one; a page of thousands is not one. */
const SHOWN_RUNS = 200;

/** A run's outcome in the words a person uses. One still running may be mid-maze or abandoned. */
const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = {
  solved: "solved",
  running: "not out yet",
  "gave-up": "gave up",
};

/**
 * The palette is one accent on a near-neutral ground, and the ground is chosen rather than
 * inherited: a page that leaves `body` transparent borrows whatever is behind it.
 */
const CSS = MAZE_CSS + PALETTE_CSS + STRUCTURE_CSS + `
*{box-sizing:border-box}
/* A viewport width counts the vertical scrollbar, so the full-bleed stage is a few pixels wider
   than the space it has and the whole page scrolls sideways. Clipped rather than hidden, because
   hidden would make the body a scroll container and break anything sticky later. */
/* The whole page is built the way the replay band is: dark ground, monospace, one accent value per
   block. That band was the only part anybody liked, so it stopped being a special region and became
   the design. A data-theme of dark on the root is what commits to it, using the palette that already
   existed rather than inventing a second one. */
/* Sans for prose, mono for data. Setting the whole page in monospace was the first attempt and it
   is a known mistake: mono earns its keep on labels, paths, prices and anything in columns, and
   costs reading speed everywhere else. The replay band people liked is mostly numbers and labels,
   which is why it could be mono throughout and a page cannot. */
body{margin:0;background:var(--ground);color:var(--text);font-family:var(--sans);line-height:1.6;
     overflow-x:hidden;overflow-x:clip}
main{max-width:64rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
a{color:var(--signal)}
h1{font-size:clamp(1.9rem,4.2vw,3rem);line-height:1.08;margin:0 0 .5rem;letter-spacing:-.02em;
   text-wrap:balance;max-width:16ch}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
   margin:2.5rem 0 .75rem;font-weight:600}
.lede{color:var(--muted);margin:0 0 1.5rem;max-width:52ch;font-size:1.02rem}
.row{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:baseline;margin-bottom:1.5rem}
.tag{font-family:var(--mono);font-size:.8rem;color:var(--muted)}
.tag b{color:var(--text);font-weight:600}
.open{color:var(--good)}
.panel{background:var(--surface);border:1px solid var(--edge);border-radius:10px;overflow:hidden}
.panel + .panel{margin-top:1rem}
.panel h3{margin:0;padding:.7rem 1rem;font-size:.85rem;border-bottom:1px solid var(--edge);
          display:flex;justify-content:space-between;gap:1rem;align-items:baseline}
.panel h3 span{font-weight:400;color:var(--muted);font-size:.78rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:.82rem;
      font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--muted);font-weight:500;font-size:.72rem;text-transform:uppercase;
   letter-spacing:.06em;padding:.55rem 1rem;border-bottom:1px solid var(--edge);white-space:nowrap}
td{padding:.55rem 1rem;border-bottom:1px solid var(--edge);white-space:nowrap}
tr:last-child td{border-bottom:0}
td.n{text-align:right}
td.what{white-space:normal;font-family:var(--sans);color:var(--muted)}
.rank{color:var(--muted)}
.empty{padding:1.5rem 1rem;color:var(--muted);font-size:.88rem}
/* line-height must be exactly 1: box-drawing characters join along the cell edge, and any
   leading at all breaks every vertical wall into dashes. */
/* Centred, because it is the subject of the panel rather than the start of a paragraph. Left
   aligned it sat against one edge with the panel's width of empty beside it. */
.drawing{padding:1.5rem 1.25rem 1rem;display:flex;justify-content:center}
.drawing svg{max-width:26rem;width:100%}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.25rem;margin:0;padding:0 1.25rem 1.25rem;
        font-size:.8rem;color:var(--muted)}
.key{display:inline-flex;align-items:center;gap:.45rem}
.key i{display:inline-block}
/* Each swatch is drawn outright rather than patched over a shared base — the version that
   overrode a base rule with !important produced a broken U where the exit ring belonged. */
.k-wall,.k-untested{width:1rem;height:3px;border-radius:2px;background:currentColor}
.k-here,.k-exit{width:.75rem;height:.75rem;border-radius:50%}
.k-here{background:currentColor}
.k-exit{border:2px solid currentColor}
.k-wall{color:var(--text)}
.k-untested{color:var(--untested)}
.k-here{color:var(--signal)}
.k-exit{color:var(--good)}
dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.5rem;margin:0;padding:1rem;
   font-family:var(--mono);font-size:.82rem}
dt{color:var(--muted)}
dd{margin:0;word-break:break-all}
code{font-family:var(--mono);font-size:.85em;background:var(--surface);border:1px solid var(--edge);
     border-radius:4px;padding:.1em .35em}
.fog{color:var(--fog)}
.legend{margin:0;padding:0 1.25rem 1.1rem;color:var(--muted);font-size:.8rem;max-width:62ch}
footer{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--edge);color:var(--muted);
       font-size:.82rem}

/* The stage: the maze playing itself, edge to edge.
   A centred column with a picture in it is the layout every page has, and it makes the maze an
   illustration of the product rather than the product. Here the maze is the page — full bleed,
   committed to the dark palette whatever the reader's theme, because a lit grid on a dark ground is
   the thing being sold and it does not read on paper. */
.stage{${paletteVars(MACHINE)}background:var(--ground);color:var(--text);
       align-items:center;padding:2.6rem 1.9rem}
/* Capped against the viewport height as well as its own width: the band is beside the fold, and a
   drawing taller than the screen is one nobody sees the bottom of. Growing it was the first attempt
   at filling the frame, and it simply pushed the exit off the page. The room was too wide, not the
   picture too small, so the track was narrowed instead. */
.stage svg{display:block;width:100%;max-width:min(34rem,58vh);margin:0 auto;overflow:visible}
/* Walls arrive rather than appear: the fade is the moment the money was spent. */
.stage .w{stroke:var(--untested);stroke-width:.055;stroke-linecap:round;opacity:.38;
          transition:opacity .45s ease,stroke .45s ease}
.stage .w.known{opacity:0}
.stage .w.known.solid{opacity:1;stroke:var(--text)}
.stage .edge{stroke:var(--text);stroke-width:.13;fill:none;stroke-linejoin:round}
.stage .goal{fill:none;stroke:var(--good);stroke-width:.09}
.stage .agent{transition:transform .26s cubic-bezier(.34,1.2,.64,1)}
.stage .agent circle{fill:var(--signal)}
@media (prefers-reduced-motion:reduce){.stage .agent,.stage .w{transition:none}}
.tally{${paletteVars(MACHINE)}background:var(--ground);color:var(--text);padding:2.1rem 1.9rem;
       font-family:var(--mono);font-variant-numeric:tabular-nums;justify-content:flex-start}
.tally .legend{list-style:none;margin:1.2rem 0;padding:0;display:grid;gap:.35rem;font-size:.78rem}
.tally .legend li{display:flex;align-items:center;gap:.5rem;color:var(--muted)}
.tally .spend{display:block;font-size:2.3rem;font-weight:700;letter-spacing:-.03em;color:var(--signal)}
.tally .caption{display:block;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;
                color:var(--muted);margin-top:.35rem}
/* Capped, because the column grew when the band was rebalanced and monospace at ninety characters
   is a line nobody finishes. */
.tally p{font-size:.8rem;color:var(--muted);margin:1.2rem 0 0;line-height:1.5;max-width:46ch}
.tally .legend,.tally .fine{max-width:46ch}
.tally .fine{margin-top:0}
.tally b{color:var(--text)}

main.wide{max-width:none;padding:0}
/* One column, one left edge.
   Every section used to centre itself and every definition list sized its own label column, so no
   two blocks began at the same x. That reads as carelessness before anybody has read a word, and it
   is the difference between a page that was laid out and one that merely stacked. */
.cells{display:block;background:var(--ground);--gutter:1.9rem;--content:46rem}
.cells > .top{padding-top:3.2rem;padding-bottom:3.2rem}
.cells > section{padding:2.2rem var(--gutter);max-width:calc(var(--content) + var(--gutter) * 2);
                 margin:0 auto}
/* Rules only where a section changes register, and full width when they appear. */
.cells > section + section{border-top:1px solid var(--edge)}
/* The band keeps its two-up shape and its full width: it is the one thing that reads at a glance. */
.cells > .stage,.cells > .tally{max-width:none;margin:0;border-bottom:0}
.cells > .stage{padding-bottom:1rem}
/* One cell is a call to action, and says so with the accent rather than a box. */
.cells .enter{background:var(--surface);box-shadow:inset 3px 0 0 var(--signal)}
/* The band is the only grid on the page, and it is a grid of two.
   The container was briefly one as well, which is what made every section a different width: an
   auto margin on a grid item turns off stretch, so each section sized to its own longest line and
   began wherever that put it. The container is a plain block now; only the band divides. */
@media (min-width:60rem){
  .band{display:grid;grid-template-columns:1.5fr 1fr;align-items:center}
}
.band{background:var(--ground);position:relative}

/* The replay is a specimen, so it is framed like one.
   Taken from species-in-pieces, which puts an engraved border round the whole viewport so a
   digital thing reads as an exhibit under glass. The device transfers; the engraving does not, and
   copying it would be borrowing somebody else's voice. A maze is made of walls, so the frame is
   drawn from wall corners: four hairline brackets, nothing between them. It costs no image and no
   request, and it is the one ornament on the page. */
.stage,.tally{position:relative}
.stage::before,.stage::after,.tally::before,.tally::after{
  content:"";position:absolute;width:1.4rem;height:1.4rem;pointer-events:none;
  border:1px solid var(--edge);opacity:.85}
.stage::before{top:1.1rem;left:1.1rem;border-right:0;border-bottom:0}
.stage::after{bottom:1.1rem;left:1.1rem;border-right:0;border-top:0}
.tally::before{top:1.1rem;right:1.1rem;border-left:0;border-bottom:0}
.tally::after{bottom:1.1rem;right:1.1rem;border-left:0;border-top:0}
/* Stacked, the two halves are separate boxes and eight brackets read as clutter. */
@media (max-width:60rem){.tally::before,.tally::after,.stage::after{display:none}}
/* The masthead is a cell now, so its rule would be a second line beside the grid's own. */
.cells .masthead{border-bottom:0;padding-bottom:0;margin-bottom:0}
.cells h2{margin:0 0 1rem}
.cells p{margin:0 0 .6rem}
.cells .fine{margin:0}
/* Panels inside a cell would be a box in a box: the cell is already the container. */
.cells .panel{background:none;border:0;border-radius:0;margin:0 0 1rem}
.cells .panel h3{padding:0 0 .5rem;border-bottom:1px solid var(--edge)}
.cells .panel .empty,.cells .panel .scroll{padding-left:0;padding-right:0}
.cells table{margin:0}
.cells td:first-child,.cells th:first-child{padding-left:0}
.cells td:last-child,.cells th:last-child{padding-right:0}
.titles{display:flex;gap:2.5rem;align-items:center;flex-wrap:wrap}
.plate{text-align:center;flex:none}
.plate .caption{display:block;margin-top:.35rem;font-size:.68rem;letter-spacing:.09em;
  text-transform:uppercase;color:var(--muted)}
/* The same shape as the toll list, used wherever a block is a set of labelled facts. */
/* A fixed label column, so a list in one section lines up with a list in the next. Sized to the
   longest label on the page rather than to each list's own longest, which is what made them drift. */
.facts{display:grid;grid-template-columns:11rem 1fr;gap:.55rem 1rem;margin:0 0 1rem;padding:0;
  font-family:var(--mono);font-size:.86rem;font-variant-numeric:tabular-nums}
@media (max-width:34rem){.facts{grid-template-columns:1fr}.facts dd{margin-bottom:.4rem}}
.facts dt{color:var(--muted)}
.facts dd{margin:0;color:var(--text);font-weight:600;text-align:left}
/* The same label column as the facts, so the words line up with the list above them; sentences in
   the reading face, because these are read rather than scanned. */
.terms{display:grid;grid-template-columns:11rem 1fr;gap:.55rem 1rem;margin:0 0 1rem;padding:0}
@media (max-width:34rem){.terms{grid-template-columns:1fr}.terms dd{margin-bottom:.4rem}}
.terms dt{font-family:var(--mono);font-size:.86rem;font-weight:600;color:var(--signal)}
.terms dd{margin:0;color:var(--text);max-width:52ch}
.wire td.verb{color:var(--signal);font-weight:600}
.wire code{font-size:.86rem}
.tolls{display:grid;grid-template-columns:1fr auto;gap:.3rem 1rem;margin:0 0 .8rem;padding:0;
       font-family:var(--mono);font-size:.9rem}
.tolls dt{color:var(--muted)}
.tolls dd{margin:0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.cohort-row{display:flex;gap:1.25rem;align-items:center}
.cohort-row .plate{flex:none}

.clock{font-family:var(--mono);font-size:1.5rem;font-weight:700;color:var(--text);
       letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.clock small{display:block;font-size:.72rem;font-weight:400;letter-spacing:.06em;
             text-transform:uppercase;color:var(--muted);margin-top:.2rem}
.cells .stakes .clock{margin-bottom:1rem}
.stake{font-family:var(--mono);font-size:.82rem;color:var(--muted)}
.stake b{color:var(--text)}
.enter .say{color:var(--muted);font-size:.85rem;margin:.9rem 0 0}
/* The two-up install row everybody recognises, with our own buttons in it.
   Deliberately NOT Apple's or Google's badge artwork: those lockups assert a listing, and there
   is none. The shape is the familiar part; the words are the honest part. */
.getit{display:flex;flex-wrap:wrap;gap:.6rem;margin:.6rem 0 .9rem}
.getit a{display:flex;align-items:center;gap:.8rem;flex:1 1 13rem;min-width:0;
  text-decoration:none;padding:.7rem 1rem;background:var(--surface);
  border:1px solid var(--edge);border-radius:9px;color:var(--text)}
.getit a:hover{border-color:var(--signal)}
/* The mark needs an explicit box. An inline SVG with only a viewBox has no intrinsic size, so it
   fills whatever it is given, and the first attempt rendered two logos the height of the section. */
.getit .mark{width:1.7rem;height:1.7rem;flex:0 0 auto;color:var(--text);display:block}
.getit .words{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.getit .plat{font-size:.68rem;color:var(--muted)}
.getit .how{font-size:1.15rem;font-weight:600;letter-spacing:-.01em}
.prompt{display:flex;align-items:stretch;gap:.5rem;margin:.4rem 0 .7rem}
.enter code{flex:1;font-family:var(--mono);font-size:.9rem;color:var(--signal);
            background:var(--ground);border:1px solid var(--edge);border-radius:6px;
            padding:.6rem .7rem;line-height:1.45}
.copy{flex:none;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;
      color:var(--ground);background:var(--text);border:0;border-radius:6px;padding:0 1rem;
      min-width:5.5rem}
.copy:hover{background:var(--signal)}
.steps{list-style:none;counter-reset:step;margin:1.1rem 0 .9rem;padding:0;display:grid;gap:1.3rem}
.steps>li{counter-increment:step;position:relative;padding-left:2.7rem}
.steps>li::before{content:counter(step);position:absolute;left:0;top:.05rem;width:1.8rem;height:1.8rem;
  border-radius:50%;border:1px solid var(--edge);display:grid;place-items:center;
  font-family:var(--mono);font-size:.85rem;color:var(--signal)}
.steps h3{margin:0 0 .25rem;font-size:1.02rem;font-weight:600;letter-spacing:-.01em}
.steps p{margin:.15rem 0}
.steps .where{float:right;margin-left:.6rem;font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;
  text-transform:uppercase;color:var(--muted);border:1px solid var(--edge);border-radius:999px;padding:.1rem .55rem}
.copy:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.enter .fine{font-size:.82rem;color:var(--muted);margin:0}

/* The masthead. Until this existed every page opened straight into a headline, which read as a
   document rather than as a place — the tokens were all applied and none of them said whose page
   this was. The mark carries the meaning; the rule under it carries the accent, which otherwise
   appeared nowhere on the page at all. */
.masthead{display:flex;align-items:center;gap:.85rem;padding-bottom:1rem;margin-bottom:1.75rem;
          border-bottom:2px solid var(--signal)}
.masthead a{display:flex;align-items:center;gap:.85rem;text-decoration:none;color:inherit}
.masthead .ring{flex:none}
.wordmark{font-family:var(--mono);font-size:.95rem;font-weight:700;letter-spacing:.16em;
          text-transform:uppercase;color:var(--text);line-height:1.1}
.wordmark small{display:block;font-size:.68rem;font-weight:400;letter-spacing:.06em;
                text-transform:none;color:var(--muted);margin-top:.15rem}
`;

/**
 * The browser half, compiled rather than quoted.
 *
 * These were string literals until the typechecker had nothing to say about them, and a script
 * ended up above the element it drove — correct markup, silent failure, invisible to every test.
 * They are real modules now, checked by `tsconfig.client.json`, and transpiled once at startup.
 *
 * Still inlined into the response rather than served as files: the page has to render from a
 * laptop with no network, which is where this gets demonstrated, and a second request is a second
 * thing that can be missing.
 */
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

const client = (name: string): string =>
  transpiler.transformSync(readFileSync(new URL(`./client/${name}`, import.meta.url), "utf8"));

const REPLAY_JS = client("replay.client.ts");
const COPY_JS = client("copy.client.ts");
const LIVE_JS = client("live.client.ts");

/**
 * The two platform marks, inline.
 *
 * Drawn here rather than fetched: this page has to render from a laptop with no network, and a
 * logo that arrives from a CDN is one more thing that can be missing. They are the platform marks
 * people recognise, used to say which platform, which is what everybody else uses them for. What
 * is deliberately absent is either store's badge lockup, because that asserts a listing and there
 * is none.
 */
const APPLE_MARK = `<svg class="mark" viewBox="0 0 384 512" aria-hidden="true"><path fill="currentColor" d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;

const ANDROID_MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4.2 5.2 2.3M17.5 4.2l1.3-1.9"/></g><path fill="currentColor" d="M5 10.4a7 7 0 0 1 14 0v.3H5v-.3Zm3.6-3a.85.85 0 1 0 0-1.7.85.85 0 0 0 0 1.7Zm6.8 0a.85.85 0 1 0 0-1.7.85.85 0 0 0 0 1.7Z"/><rect fill="currentColor" x="5" y="11.7" width="14" height="8.2" rx="1.6"/><rect fill="currentColor" x="1.6" y="10.6" width="2.4" height="6.6" rx="1.2"/><rect fill="currentColor" x="20" y="10.6" width="2.4" height="6.6" rx="1.2"/></svg>`;

/**
 * The mark with nothing to measure: a closed ring, which is the limit drawn whole.
 *
 * Not `arcRing(0)`. An empty gauge on a page that has no quantity is a lie in the honest direction
 * — it reads as "nought spent" when the truth is "this page is not about a spend" — and on screen
 * it looks like a control that failed to load. A complete ring is the logo rather than a reading.
 */
const IDENTITY_MARK =
  `<svg class="ring" width="40" height="40" viewBox="0 0 100 100" role="img" aria-label="Toll">` +
  `<circle cx="50" cy="50" r="40" fill="none" stroke="var(--text)" stroke-width="9"/></svg>`;

/**
 * The masthead every page opens with.
 *
 * `spent` is what the mark is *for* — a limit and how much of it is gone — so every page states
 * its own: a round page the hour that has run, a run page how much of the maze it has paid to see.
 * `null` means this page measures nothing, and gets the closed ring instead of a false zero.
 */
const masthead = (spent: number | null, label: string): string =>
  `<header class="masthead"><a href="/">${spent === null ? IDENTITY_MARK : arcRing(spent, { size: 40, label })}
<span class="wordmark">Toll<small>a maze that charges to show you the way</small></span></a></header>`;

const shell = (title: string, body: string, head = "", spent: number | null = null,
               markLabel = "Toll", wide = false): string =>
  `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(title)}</title>${head}<style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ''}>${wide ? "" : masthead(spent, markLabel)}${body}
<footer>Every figure is <b>claimed</b>, not settled: Circle batches these payments about a quarter
of an hour later. Send <code>Accept: application/json</code> for the machine-readable version.</footer>
</main></body></html>`;

/** A board, or an honest empty state. A table with no rows explains itself here. */
function boardTable(b: Board): string {
  const head = b.kind === "fewest-steps" ? "Fewest steps" : "Least spent";
  const why = b.kind === "fewest-steps"
    ? "buy the map, sprint, damn the cost"
    : "feel your way, pay for nothing you did not need";

  const rows = (list: readonly Entry[], ranked: boolean): string =>
    list.map((e) => `<tr>
      <td class="rank">${ranked ? e.rank : "—"}</td>
      <td><a href="${esc(runHref(e.run))}">${esc(e.run.slice(0, 8))}</a></td>
      <td>${esc(short(e.payer))}</td>
      <td class="n">${e.steps}</td>
      <td class="n">${esc(usd(e.spentUsd))}</td>
      <td class="n">${e.overOptimal === null ? "—" : `+${e.overOptimal}`}</td>
      <td class="n">${e.settlements}</td>
    </tr>`).join("");

  const table = (list: readonly Entry[], ranked: boolean): string => `<div class="scroll"><table>
    <tr><th>#</th><th>Run</th><th>Payer</th><th>Steps</th><th>Spent</th><th>Over</th><th>Settled</th></tr>
    ${rows(list, ranked)}</table></div>`;

  const solved = `<div class="panel">
    <h3>${head}<span>${why}</span></h3>
    ${b.entries.length === 0
      ? `<p class="empty">${b.of === "all-time" ? "Nobody has solved one yet." : "Nobody has solved this one yet."}</p>`
      : table(b.entries, true)}
  </div>`;

  // A separate panel, because these are not ranked against the ones above — they never finished,
  // and listing them under the same heading would read as a worse position rather than no position.
  const rest = b.unfinished.length === 0 ? "" : `<div class="panel">
    <h3>Did not get out<span>listed, never ranked</span></h3>
    ${table(b.unfinished, false)}
  </div>`;

  return solved + rest;
}


/**
 * The front page, which is the only page most people will ever see.
 *
 * Written for somebody who was handed the link in a chat and knows nothing. The old version led
 * with a table of endpoints, so the first thing a person met was API documentation for a product
 * they had not been told about — and a maze game whose front page contained no maze.
 *
 * Three things, in the order a game gives them:
 *
 * 1. **The maze**, fogged, large. The fog is the pitch rather than a graphic: this is what an agent
 *    sees before it pays to learn anything, and every wall it reveals cost a tenth of a cent.
 * 2. **Who plays.** Nobody can play this in a browser — every move is a paid request — so the page
 *    says so plainly and offers the role that *is* available. Watching is not a consolation here;
 *    it is what a person actually does.
 * 3. **What is at stake, and that it is running out.** A hundred places, how many are gone, and
 *    the minutes left in the hour.
 *
 * The endpoints stay, at the bottom, for the agent that arrives as a person's browser would.
 */
/**
 * The stage: a finished run, played back.
 *
 * Data is precomputed on the server — every wall carries the frame at which the run had paid to
 * establish it — so the script does nothing but add a class and move a dot. No maze logic reaches
 * the browser, and the animation cannot disagree with the maze it is drawing.
 */
function stage(replay: Replay, roundId: string): string {
  const walls = replay.walls.map((w) =>
    `<line class="w${w.solid ? " solid" : ""}" data-at="${w.at}" ` +
    `x1="${w.x1}" y1="${w.y1}" x2="${w.x2}" y2="${w.y2}"/>`).join("");

  // Frames travel as JSON in a data block rather than as generated JavaScript. `<` cannot appear
  // in them, but it is escaped anyway: a script tag closed early by its own payload is the oldest
  // bug on the web, and data that is data cannot be what does it.
  const frames = JSON.stringify(replay.frames).replace(/</g, "\\u003c");

  return `<div class="band"><section class="stage" aria-label="How an agent would walk a closed round">
    <svg id="stage-svg" viewBox="-0.35 -0.35 ${replay.width + 0.7} ${replay.height + 0.7}"
         role="img" aria-label="An agent walking a maze, paying to reveal each wall">
      <rect class="edge" x="0" y="0" width="${replay.width}" height="${replay.height}" rx="0.1"/>
      ${walls}
      <circle class="goal" cx="${replay.exit.x + 0.5}" cy="${replay.exit.y + 0.5}" r="0.24"/>
      <g class="agent" id="agent"><circle r="0.16"/></g>
    </svg>
</section>
<section class="tally" aria-label="What the replay cost">
  <span class="spend" id="spend">$0.000</span>
  <span class="caption">spent so far</span>
  <p>How an agent feels its way out. Every wall it lights up is one it <b>pays</b> to learn. A look
  is $${PRICES.look.toFixed(3)}, a step $${PRICES.move.toFixed(3)}.</p>
  <ul class="legend">
    <li><i class="k-wall"></i> a wall it found</li>
    <li><i class="k-untested"></i> never tested</li>
    <li><i class="k-here"></i> where it is</li>
    <li><i class="k-exit"></i> the way out</li>
  </ul>
  <p class="fine">Drawn by the maze, not played by an agent: an agent that looks before every step,
  walking round <b>${esc(roundId)}</b>, which has closed, would be out in <b>${replay.steps} steps</b>
  for <b>${esc(usd(replay.spent))}</b>.</p>
</section></div>
  <script type="application/json" id="replay-data">${frames}</script>
  <script>${REPLAY_JS}</script>`;
}

/**
 * How much of a round's hour has run, and how to say it.
 *
 * The same quantity the unfurl card puts in its ring, for the same reason: it is the one bounded
 * number a round has, it costs no chain call, and it is what somebody arriving on a shared link
 * needs to know before deciding to play. A closed round reads as a full ring.
 */
function hourGone(round: Round, open: boolean, now = Date.now()): { spent: number; label: string } {
  if (!open) return { spent: 1, label: "this round has closed" };
  const span = round.closesAt.getTime() - round.openedAt.getTime();
  const left = Math.max(0, Math.ceil((round.closesAt.getTime() - now) / 60_000));
  return { spent: (now - round.openedAt.getTime()) / span, label: `${left} minutes left in this round` };
}

/** The app's source. Neither store lists it yet, so both install buttons land here. */
const APP_SOURCE = "https://github.com/nel349/arc-agent-mandate";
/** The connector's own install notes, for agents other than Claude Code. */
const CONNECTOR_GUIDE = `${APP_SOURCE}/tree/main/mcp`;
/** Circle's faucet, which the app's README already sends people to for Arc testnet USDC. */
const TESTNET_FAUCET = "https://faucet.circle.com";
/** Run inside a clone of the app's repository. Single-quoted so the shell variable stays literal. */
const CONNECTOR_INSTALL = 'claude mcp add arc-mandate -s user -- node "$PWD/mcp/server.ts"';

/**
 * The five steps, each with what it needs in the one place it is needed.
 *
 * The titles and sentences come from `STEPS`, the same definition agents are served, so the page and
 * the API cannot describe the path two ways. What is added here is only what a page can do that a
 * list cannot: the install buttons on step 1, the line to copy on step 2, the sentence on step 4.
 */
function steps(link: string): string {
  const extras: readonly string[] = [
    `<div class="getit">
      <a href="${APP_SOURCE}">
        ${APPLE_MARK}
        <span class="words"><span class="plat">Ask for access, or build for</span>
        <span class="how">iOS</span></span>
      </a>
      <a href="${APP_SOURCE}">
        ${ANDROID_MARK}
        <span class="words"><span class="plat">Same code, unproven on</span>
        <span class="how">Android</span></span>
      </a>
    </div>
    <p class="fine">Neither store lists it yet; both buttons go to the source. Test USDC is free from
    <a href="${TESTNET_FAUCET}">Circle&rsquo;s faucet</a>; choose Arc testnet.</p>`,
    `<div class="prompt">
      <code id="install">${esc(CONNECTOR_INSTALL)}</code>
      <button type="button" class="copy" data-copy="install">Copy</button>
    </div>
    <p class="fine">Run it inside a clone of the app&rsquo;s repository. Cursor and Codex:
    <a href="${CONNECTOR_GUIDE}">the connector&rsquo;s notes</a>. Then ask your agent for its pairing
    code.</p>`,
    "",
    `<div class="prompt">
      <code id="prompt">Solve the maze at ${esc(link)} and spend as little as you can.</code>
      <button type="button" class="copy" data-copy="prompt">Copy</button>
    </div>
    <p class="fine">A link alone will not do it: an agent handed a URL reads the page and stops,
    because nothing told it to play. Its first call is <b>POST /game</b>, and it pays from there.</p>`,
    "",
  ];
  return STEPS.map((step, index) => `<li>
    <span class="where">${step.where}</span>
    <h3>${esc(step.title)}</h3>
    <p>${esc(step.detail)}</p>
    ${extras[index] ?? ""}
  </li>`).join("");
}

export function indexPage(
  round: Round, open: boolean, endpoints: readonly Endpoint[],
  extra: {
    /** Null when the store did not answer, which the page says rather than drawing an empty board. */
    readonly boards?: readonly Board[] | null; readonly cohort?: Cohort | null;
    readonly base?: string; readonly replay?: { readonly of: string; readonly run: Replay };
  } = {},
): string {
  const { spent, label } = hourGone(round, open);
  const minutes = Math.max(0, Math.ceil((round.closesAt.getTime() - Date.now()) / 60_000));
  const boards = extra.boards;
  const best = boards?.find((b) => b.kind === "fewest-steps")?.entries[0];
  const unreadable = `<p class="empty">The boards could not be read just now. Reload in a moment.</p>`;
  const link = `${extra.base === undefined || extra.base === "" ? "" : extra.base}/`;

  return shell("Toll, a maze your agent pays to walk", `
  <div class="cells">
    <section class="top">
      ${masthead(spent, label)}
      <div class="titles">
        <div>
          <h1>A maze your agent pays to walk</h1>
          <p class="lede">Every wall is hidden until somebody buys the answer.</p>
        </div>
        ${extra.cohort === undefined || extra.cohort === null
          ? ""
          : `<div class="plate">${cohortPlate(extra.cohort.minted, { of: extra.cohort.of, size: 96 })}
             <span class="caption">badges taken</span></div>`}
      </div>
    </section>

    ${extra.replay === undefined ? "" : stage(extra.replay.run, extra.replay.of)}

    <section>
      <dl class="facts">
        <dt>round</dt><dd>${esc(round.id)}</dd>
        <dt>${open ? "closes in" : "closed"}</dt><dd>${open ? `${minutes} min` : "this one is over"}</dd>
        <dt>shortest way out</dt><dd>${round.optimalSteps} steps</dd>
        <dt>best so far</dt><dd>${boards === null
          ? "could not be read just now"
          : best === undefined
            ? "nobody has solved it"
            : `${best.steps} steps, ${esc(usd(best.spentUsd))}`}</dd>
      </dl>
    </section>

    <section id="words">
      <h2>Rounds, runs and boards</h2>
      <dl class="terms">
        ${TERMS.map((term) => `<dt>${esc(term.word)}</dt><dd>${esc(term.means)}</dd>`).join("")}
      </dl>
      <p class="fine">See <a href="${esc(roundHref(round.id))}">this round&rsquo;s board</a>,
      <a href="${PAGES.board}">the all-time board</a>, or <a href="${PAGES.runs}">every run</a>.
      Each run links to its record, which anyone can replay.</p>
    </section>

    <section class="enter" id="how">
      <h2>How to play</h2>
      <p><b>Your agent plays; you watch.</b> Every move is a paid request, so there is no button here
      for a person. Five steps, and the first three happen once.</p>
      <ol class="steps">
        ${steps(link)}
      </ol>
      <p class="fine"><b>Agents:</b> ${esc(BEFORE_PAYING)}</p>
      <script>${COPY_JS}</script>
    </section>

    <section>
      <h2>The toll</h2>
      <dl class="facts">
        <dt>a step</dt><dd>${esc(usd(PRICES.move))}</dd>
        <dt>a look</dt><dd>${esc(usd(PRICES.look))}</dd>
        <dt>the map</dt><dd>${esc(usd(PRICES.map))}</dd>
      </dl>
      <p class="fine">A wall still costs you. No account, no card, no signup.</p>
    </section>

    <section>
      <h2>Whose money</h2>
      <p class="lede">Not the agent&rsquo;s. It holds nothing, and cannot get any.</p>
      <dl class="facts">
        <dt>granted by</dt><dd>your phone, with your face</dd>
        <dt>bounded by</dt><dd>a limit and a deadline</dd>
        <dt>enforced by</dt><dd>the chain, not by us</dd>
        <dt>revoked</dt><dd>mid-maze, and the next step fails</dd>
      </dl>
      <p class="fine">Your agent shows you an address and a QR code when it needs one. That is what
      the app is for; it is step 1 above.</p>
      <p class="fine"><b>x402</b> over HTTP 402, settled on Arc through <b>Circle&rsquo;s Gateway</b>.
      The allowance is an <b>ERC-6900</b> session key. The <b>ERC-8004</b> record a solve earns
      cannot be written by the agent that earned it.</p>
    </section>

    <section>
      <h2>Every address this answers</h2>
      <p class="fine">This is the whole surface. An agent needs nothing else.</p>
      <div class="scroll"><table class="wire">
        <tr><th>Method</th><th>Path</th><th>What</th><th class="n">Cost</th></tr>
        ${endpoints.map((e) => `<tr>
          <td class="verb">${esc(e.method)}</td>
          <td><code>${esc(e.path)}</code></td>
          <td class="what">${esc(e.what)}</td>
          <td class="n">${e.price === undefined ? "free" : esc(usd(e.price))}</td>
        </tr>`).join("")}
      </table></div>
    </section>

    <section>
      <h2>This round so far</h2>
      ${boards === null ? unreadable : (boards ?? []).map(boardTable).join("")}
      <p class="fine"><a href="${esc(roundHref(round.id))}">this round</a> ·
      <a href="${PAGES.board}">all time</a> · <a href="${PAGES.runs}">every run</a>. The maze comes
      from the round id, so anyone can rebuild it and replay any run without trusting us.</p>
    </section>
  </div>
`,
  "", spent, label, true);
}

export function roundPage(
  round: Round, open: boolean, boards: readonly Board[], unfurl?: Unfurl, maze?: MazeDrawing,
): string {
  return shell(`Round ${round.id} · Toll`, `
  <h1>Round ${esc(round.id)}</h1>
  <p class="lede">One maze an hour, the same for everybody, rebuilt from the id alone.</p>
  <div class="row">
    <span class="tag ${open ? "open" : ""}">${open ? "open now" : "closed"}</span>
    <span class="tag">shortest route <b>${round.optimalSteps} steps</b></span>
    <span class="tag">opened <b>${esc(round.openedAt.toISOString().slice(11, 16))} UTC</b></span>
    <span class="tag">closes <b>${esc(round.closesAt.toISOString().slice(11, 16))} UTC</b></span>
  </div>
  ${maze === undefined ? "" : `<div class="panel">
    <h3>This hour&rsquo;s maze<span>as a run that has paid for nothing sees it</span></h3>
    <div class="drawing">${maze.svg}</div>
    <p class="legend">
      <span class="key"><i class="k-untested"></i>every wall, still hidden</span>
      <span class="key"><i class="k-exit"></i>the way out</span>
    </p>
    <p class="fine">The walls are here, and none of them are drawn. An agent buys them one at a
    time, or buys the map and sees them all at once. The map costs as much as ${MAP_IN_STEPS} steps,
    so it helps on the fewest-steps board and costs on the least-spent one.</p>
  </div>`}
  <h2>This round&rsquo;s runs</h2>
  <p class="fine">A run is one agent&rsquo;s attempt at this maze. It is listed once it has paid for
  something, and ranked once it gets out.</p>
  <div id="boards" data-round="${esc(round.id)}">${boards.map(boardTable).join("")}</div>
  <h2>Elsewhere</h2>
  <p class="lede"><a href="${PAGES.home}">what this is</a> · <a href="${PAGES.board}">the all-time board</a> ·
  <a href="${PAGES.runs}">every run</a></p>
  <!--
    Below the board it drives, not above it. An inline script that runs before its element exists
    finds nothing, returns early through its own guard, and fails in complete silence — which has
    already cost this project one debugging session on the replay animation.
  -->
  <script>${LIVE_JS}</script>`,
  unfurl === undefined ? "" : unfurlMeta(unfurl),
  hourGone(round, open).spent, hourGone(round, open).label);
}

export function boardPage(boards: readonly Board[]): string {
  return shell("All time · Toll", `
  <h1>All time</h1>
  <p class="lede">Every run of every round, ranked the same two ways as a round&rsquo;s board. A run
  is ranked once it gets out; the ones that did not are listed under it.</p>
  ${boards.map(boardTable).join("")}
  <h2>Elsewhere</h2>
  <p class="lede"><a href="${PAGES.home}">what this is</a> · <a href="${PAGES.runs}">every run</a></p>`);
}

/**
 * Every run anybody has paid for, newest first.
 *
 * The page the question "where are all the runs?" had no answer to. The boards rank; this lists,
 * including the runs that never got out, which a board shows only below its ranking.
 */
export function runsPage(runs: readonly RunSummary[]): string {
  const shown = runs.slice(0, SHOWN_RUNS);
  const count = runs.length === 0
    ? "none yet"
    : runs.length > SHOWN_RUNS ? `newest ${SHOWN_RUNS} of ${runs.length}` : `${runs.length} in all`;
  const rows = shown.map((run) => `<tr>
      <td>${esc(run.startedAt.slice(0, 16).replace("T", " "))}</td>
      <td><a href="${esc(roundHref(run.round))}">${esc(run.round)}</a></td>
      <td><a href="${esc(runHref(run.id))}">${esc(run.id.slice(0, 8))}</a></td>
      <td${run.outcome === "solved" ? ' class="open"' : ""}>${esc(OUTCOME_WORDS[run.outcome])}</td>
      <td class="n">${run.steps}</td>
      <td class="n">${esc(usd(run.spentUsd))}</td>
      <td>${esc(short(run.payer))}</td>
    </tr>`).join("");

  return shell("Every run · Toll", `
  <h1>Every run</h1>
  <p class="lede">Every attempt an agent has paid for, in any round, newest first. Open one to see
  what it bought, and to check it yourself.</p>
  <div class="panel">
    <h3>Runs<span>${count}</span></h3>
    ${runs.length === 0
      ? `<p class="empty">No agent has paid for a run yet.</p>`
      : `<div class="scroll"><table>
      <tr><th>Started, UTC</th><th>Round</th><th>Run</th><th>Outcome</th><th>Steps</th><th>Spent</th><th>Payer</th></tr>
      ${rows}</table></div>`}
  </div>
  <h2>Elsewhere</h2>
  <p class="lede"><a href="${PAGES.home}">what this is</a> · <a href="${PAGES.board}">the all-time board</a></p>`);
}

/**
 * Said when the store the pages read from does not answer.
 *
 * Instead of an empty board, which would say nobody has played, or "no such run", which would tell
 * somebody following a reputation record that it cites nothing.
 */
export function storeDownPage(): string {
  return shell("Not readable just now · Toll", `
  <h1>Not readable just now</h1>
  <p class="lede">The runs are kept in a store this page reads, and it did not answer. Nothing is
  lost. Reload in a moment.</p>
  <p class="lede"><a href="${PAGES.home}">what this is</a></p>`);
}

/** The page an on-chain reputation record points at, forever. */
export function runPage(run: PublishedRun, digestHex: string, maze: MazeDrawing): string {
  // A run's action list has no upper bound — an agent that wanders instead of solving can buy
  // thousands, and a table with one row each is a page nobody can read and a browser that stalls.
  // The record itself is complete at /run/:id; this is the readable end of it.
  const shown = run.actions.slice(-SHOWN_ACTIONS);
  const outcome = run.outcome === "solved"
    ? `<span class="open">solved</span>`
    : esc(run.outcome);
  return shell(`Run ${run.id.slice(0, 8)} · Toll`, `
  <h1>One run, replayable</h1>
  <p class="lede">One agent&rsquo;s attempt at round <a href="${esc(roundHref(run.round))}">${esc(run.round)}</a>.
  Everything needed to check it is here, and when a run solves, the ERC-8004 reputation it earns
  points at this address, permanently.</p>
  <div class="row">
    <span class="tag">outcome <b>${outcome}</b></span>
    <span class="tag">steps <b>${run.steps}</b></span>
    <span class="tag">spent <b>${esc(usd(run.spentUsd))}</b></span>
    <span class="tag">shortest <b>${run.optimalSteps}</b></span>
  </div>
  <div class="panel">
    <h3>What this run has paid to see<span>${maze.learned} of ${maze.total} inner walls</span></h3>
    <div class="drawing">${maze.svg}</div>
    <p class="legend">
      <span class="key"><i class="k-wall"></i>a wall it found</span>
      <span class="key"><i class="k-untested"></i>never tested</span>
      <span class="key"><i class="k-here"></i>where it is</span>
      <span class="key"><i class="k-exit"></i>the way out</span>
    </p>
  </div>
  <div class="panel"><dl>
    <dt>run</dt><dd>${esc(run.id)}</dd>
    <dt>payer</dt><dd>${esc(run.payer ?? "nobody yet")}</dd>
    <dt>started</dt><dd>${esc(run.startedAt)}</dd>
    <dt>finished</dt><dd>${esc(run.finishedAt ?? "—")}</dd>
    <dt>digest</dt><dd>${esc(digestHex)}</dd>
  </dl></div>
  <div class="panel"><h3>What was bought<span>${run.actions.length} paid actions${
      run.actions.length > SHOWN_ACTIONS ? `, last ${SHOWN_ACTIONS} shown` : ""}</span></h3>
    <div class="scroll"><table>
      <tr><th>#</th><th>Action</th><th>Cost</th><th>Settled into a batch</th></tr>
      ${shown.map((a, i) => `<tr><td class="rank">${run.actions.length - shown.length + i + 1}</td>
        <td>${esc(a.action)}${"direction" in a ? ` ${esc(a.direction)}` : ""}</td>
        <td class="n">${esc(usd(a.price))}</td>
        <td>${"settlement" in a && a.settlement !== undefined ? esc(a.settlement) : "—"}</td></tr>`).join("")}
    </table></div></div>
  <h2>Check it yourself</h2>
  <p class="lede"><a href="${esc(runHref(run.id))}/verify">replay this run</a> ·
  <a href="${esc(roundHref(run.round))}">the round</a> · <a href="${PAGES.runs}">every run</a> ·
  <a href="${PAGES.home}">what this is</a></p>`,
  "",
  // A run's own limit is the maze: sixty inner walls, and the ones it has paid to establish. The
  // panel above already counts them, so the mark says the same thing from the top of the page.
  maze.total === 0 ? null : maze.learned / maze.total,
  `${maze.learned} of ${maze.total} inner walls established`);
}
