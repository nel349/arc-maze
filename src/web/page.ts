import type { Board, Entry } from "../maze/boards.ts";
import type { Cohort } from "../arc/badge.ts";
import type { PublishedRun } from "../maze/runs.ts";
import { PRICES } from "../maze/runs.ts";
import type { Round } from "../maze/round.ts";
import { MAZE_CSS, type MazeDrawing } from "./maze-svg.ts";
import { arcRing, cohortPlate, MACHINE, paletteVars, PALETTE_CSS, STRUCTURE_CSS } from "./brand.ts";
import type { Replay } from "./replay.ts";
import { unfurlMeta, type Unfurl } from "./card.ts";
import type { Endpoint } from "../server.ts";

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

/**
 * The palette is one accent on a near-neutral ground, and the ground is chosen rather than
 * inherited: a page that leaves `body` transparent borrows whatever is behind it.
 */
const CSS = MAZE_CSS + PALETTE_CSS + STRUCTURE_CSS + `
*{box-sizing:border-box}
/* A viewport width counts the vertical scrollbar, so the full-bleed stage is a few pixels wider
   than the space it has and the whole page scrolls sideways. Clipped rather than hidden, because
   hidden would make the body a scroll container and break anything sticky later. */
body{margin:0;background:var(--ground);color:var(--text);font-family:var(--sans);line-height:1.55;
     overflow-x:hidden;overflow-x:clip}
main{max-width:64rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
a{color:var(--signal)}
h1{font-size:1.6rem;margin:0 0 .25rem;letter-spacing:-.01em;text-wrap:balance}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
   margin:2.5rem 0 .75rem;font-weight:600}
.lede{color:var(--muted);margin:0 0 2rem;max-width:60ch}
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
.drawing{padding:1.5rem 1.25rem 1rem}
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
.stage svg{display:block;width:100%;max-width:34rem;margin:0 auto;overflow:visible}
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
.tally p{font-size:.8rem;color:var(--muted);margin:1.2rem 0 0;line-height:1.5}
.tally .fine{margin-top:0}
.tally b{color:var(--text)}
/* Below a laptop the lattice becomes one column: four tracks of this density is a spreadsheet. */
@media (max-width:64rem){
  .cells{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cells .three{grid-column:span 2}
}
@media (max-width:40rem){
  .cells{grid-template-columns:1fr}
  .cells .wide,.cells .three,.cells .full{grid-column:1}
}

/* The front page's opening: the maze on the left, the stakes on the right. A maze game whose
   front page had no maze in it was the single biggest thing missing — a person could read the
   whole page and never see the thing being sold. */
/* The page laid out the way the subject is: cells, divided by walls.
   The gap is one pixel and the grid's own background shows through it, so every division is a
   hairline drawn once — no doubled borders where two cells meet, and no cards floating on a page.
   A maze is a grid with walls in it; so is this. */
/* One lattice, edge to edge, and everything is a cell in it — the masthead and the stage
   included. The page had been three layout systems stacked: a constrained masthead, a full-bleed
   band, then a constrained grid, so its width changed three times and the band read as a hero
   image dropped into a document. A maze does not have margins, and neither does this. */
main.wide{max-width:none;padding:0}
.cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;
       background:var(--edge);border-bottom:1px solid var(--edge)}
.cells > section{background:var(--ground);padding:2.1rem 1.9rem;min-width:0;
                 display:flex;flex-direction:column;justify-content:center}
/* One cell is a call to action, and says so with the accent rather than a box. */
.cells .enter{background:var(--surface);box-shadow:inset 3px 0 0 var(--signal)}
.cells .wide{grid-column:span 2}
.cells .three{grid-column:span 3}
.cells .full{grid-column:1 / -1}
/* The masthead is a cell now, so its rule would be a second line beside the grid's own. */
.cells .masthead{border-bottom:0;padding-bottom:0;margin-bottom:0}
.cells h2{margin:0 0 .9rem}
.cells p{margin:0 0 .6rem}
.cells .fine{margin:0}
/* Panels inside a cell would be a box in a box: the cell is already the container. */
.cells .panel{background:none;border:0;border-radius:0;margin:0 0 1rem}
.cells .panel h3{padding:0 0 .5rem;border-bottom:1px solid var(--edge)}
.cells .panel .empty,.cells .panel .scroll{padding-left:0;padding-right:0}
.cells table{margin:0}
.cells td:first-child,.cells th:first-child{padding-left:0}
.cells td:last-child,.cells th:last-child{padding-right:0}
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
.prompt{display:flex;align-items:stretch;gap:.5rem;margin:.4rem 0 .7rem}
.enter code{flex:1;font-family:var(--mono);font-size:.9rem;color:var(--signal);
            background:var(--ground);border:1px solid var(--edge);border-radius:6px;
            padding:.6rem .7rem;line-height:1.45}
.copy{flex:none;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;
      color:var(--ground);background:var(--text);border:0;border-radius:6px;padding:0 1rem;
      min-width:5.5rem}
.copy:hover{background:var(--signal)}
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
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
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
      <td><a href="/run/${esc(e.run)}">${esc(e.run.slice(0, 8))}</a></td>
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
      ? `<p class="empty">Nobody has solved this one yet.</p>`
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
    `<line class="w${w.solid ? " solid" : ""}" data-at="${Number.isFinite(w.at) ? w.at : 9999}" ` +
    `x1="${w.x1}" y1="${w.y1}" x2="${w.x2}" y2="${w.y2}"/>`).join("");

  // Only the frames travel as data, and `<` cannot appear in them — but it is escaped anyway,
  // because a script tag closed early by its own payload is the oldest bug on the web.
  const frames = JSON.stringify(replay.frames).replace(/</g, "\\u003c");

  return `<section class="stage three" aria-label="A solved round, replayed">
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
  <p>An agent feeling its way out. Every wall it lights up was <b>paid for</b> — a look is
  $${PRICES.look.toFixed(3)}, a step $${PRICES.move.toFixed(3)}.</p>
  <ul class="legend">
    <li><i class="k-wall"></i> a wall it found</li>
    <li><i class="k-untested"></i> never tested</li>
    <li><i class="k-here"></i> where it is</li>
    <li><i class="k-exit"></i> the way out</li>
  </ul>
  <p class="fine">Out in <b>${replay.steps} steps</b> for <b>${esc(usd(replay.spent))}</b>.
  Replay of round <b>${esc(roundId)}</b>, already closed.</p>
</section>
  <script>
  (function () {
    var frames = ${frames};
    var svg = document.getElementById("stage-svg");
    var agent = document.getElementById("agent");
    var spend = document.getElementById("spend");
    if (!svg || !agent || !spend) return;
    var walls = [].slice.call(svg.querySelectorAll(".w"));

    function paint(f) {
      for (var i = 0; i < walls.length; i++) {
        var at = Number(walls[i].getAttribute("data-at"));
        walls[i].classList.toggle("known", at <= f);
      }
      var frame = frames[f];
      agent.style.transform = "translate(" + (frame.x + 0.5) + "px," + (frame.y + 0.5) + "px)";
      spend.textContent = "$" + frame.spent.toFixed(3);
    }

    /* Somebody who has asked for less motion gets the finished run rather than no run: the point
       is what it cost, and that reads perfectly well standing still. */
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(frames.length - 1);
      return;
    }

    var at = 0;
    var timer;
    function tick() {
      paint(at);
      at += 1;
      if (at >= frames.length) {
        /* Hold on the solved maze, then start again from the dark. */
        timer = setTimeout(function () { at = 0; tick(); }, 3200);
        return;
      }
      timer = setTimeout(tick, 560);
    }
    /* A run that plays to an empty room costs battery and proves nothing. */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { clearTimeout(timer); } else { clearTimeout(timer); tick(); }
    });
    tick();
  })();
  </script>`;
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

export function indexPage(
  round: Round, open: boolean, endpoints: readonly Endpoint[],
  extra: {
    readonly boards?: readonly Board[]; readonly cohort?: Cohort | null;
    readonly base?: string; readonly replay?: { readonly of: string; readonly run: Replay };
  } = {},
): string {
  const { spent, label } = hourGone(round, open);
  const minutes = Math.max(0, Math.ceil((round.closesAt.getTime() - Date.now()) / 60_000));
  const best = extra.boards?.find((b) => b.kind === "fewest-steps")?.entries[0];
  const link = `${extra.base === undefined || extra.base === "" ? "" : extra.base}/`;

  return shell("Toll — a maze your agent pays to walk", `
  <div class="cells">
    <section class="wide">
      ${masthead(spent, label)}
      <h1>A maze your agent pays to walk</h1>
      <p class="lede">Every wall is hidden until somebody buys the answer.</p>
    </section>

    <section class="prize-cell">
      <h2>The prize</h2>
      <div class="cohort-row">
        ${extra.cohort === undefined || extra.cohort === null
          ? ""
          : cohortPlate(extra.cohort.minted, { of: extra.cohort.of, size: 92 })}
      </div>
      <p class="fine">A record on your agent's own identity, and one of the
      ${extra.cohort?.of ?? 100} badges.</p>
    </section>

    <section>
      <h2>This hour</h2>
      <div class="clock">${open ? `${minutes} min` : "closed"}<small>${open ? "left" : esc(round.id)}</small></div>
      <p class="stake"><b>${round.optimalSteps} steps</b> is perfect</p>
      <p class="stake">${best === undefined
        ? "Nobody out yet"
        : `Best <b>${best.steps}</b> · <b>${esc(usd(best.spentUsd))}</b>`}</p>
    </section>

    ${extra.replay === undefined ? "" : stage(extra.replay.run, extra.replay.of)}

    <section class="wide enter">
      <h2>Entering</h2>
      <p><b>You cannot play this.</b> Every move is a paid request, so there is no button here for a
      person. Your agent plays; you watch.</p>
      <p class="say">Give it this, word for word:</p>
      <div class="prompt">
        <code id="prompt">Solve the maze at ${esc(link)} — spend as little as you can.</code>
        <button type="button" id="copy" class="copy">Copy</button>
      </div>
    <script>
    /* The address the visitor actually reached, not the one the server was configured to think it
       has. A prompt that quotes PUBLIC_URL is wrong the moment somebody arrives through a tunnel,
       an IP or a preview host — and with nothing configured it rendered a bare "/". The server
       still emits its best guess, so this degrades to something sensible without JavaScript. */
    (function () {
      var code = document.getElementById("prompt");
      var button = document.getElementById("copy");
      if (!code || !button) return;
      var say = function () {
        return "Solve the maze at " + location.origin + "/ \u2014 spend as little as you can.";
      };
      code.textContent = say();
      button.addEventListener("click", function () {
        var done = function () {
          button.textContent = "Copied";
          setTimeout(function () { button.textContent = "Copy"; }, 1600);
        };
        /* Needs a secure context, which localhost is and plain http elsewhere is not. When it is
           refused the text is selected instead, so the next keystroke still copies it. */
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(say()).then(done, select);
        } else { select(); }
        function select() {
          var range = document.createRange();
          range.selectNodeContents(code);
          var selection = window.getSelection();
          if (!selection) return;
          selection.removeAllRanges();
          selection.addRange(range);
          button.textContent = "Press \u2318C";
          setTimeout(function () { button.textContent = "Copy"; }, 2400);
        }
      });
    })();
    </script>
      <p class="fine">A link alone will not do it: an agent handed a URL reads the page and stops,
      because nothing told it to play. Its first call is <b>POST /game</b>, and it pays from there.</p>
    </section>

    <section>
      <h2>The toll</h2>
      <dl class="tolls">
        <dt>a step</dt><dd>${esc(usd(PRICES.move))}</dd>
        <dt>a look</dt><dd>${esc(usd(PRICES.look))}</dd>
        <dt>the map</dt><dd>${esc(usd(PRICES.map))}</dd>
      </dl>
      <p class="fine">A wall still costs you. No account, no card, no signup.</p>
    </section>

    <section>
      <h2>Elsewhere</h2>
      <p class="fine"><a href="/round/${esc(round.id)}">this round</a><br>
      <a href="/board">all time</a></p>
      <p class="fine">The maze comes from the round id, so anyone can rebuild it and replay any run.</p>
    </section>

    <section class="full">
      <h2>This round, as it happens</h2>
      ${(extra.boards ?? []).map(boardTable).join("")}
    </section>

    <section class="full">
      <details>
        <summary>Every address this answers</summary>
        <div class="scroll"><table>
          <tr><th>Method</th><th>Path</th><th>What</th><th class="n">Cost</th></tr>
          ${endpoints.map((e) => `<tr>
            <td>${esc(e.method)}</td>
            <td>${esc(e.path)}</td>
            <td class="what">${esc(e.what)}</td>
            <td class="n">${e.price === undefined ? "free" : esc(usd(e.price))}</td>
          </tr>`).join("")}
        </table></div>
      </details>
    </section>
  </div>
`,
  "", spent, label, true);
}

export function roundPage(
  round: Round, open: boolean, boards: readonly Board[], unfurl?: Unfurl,
): string {
  return shell(`Round ${round.id} — Toll`, `
  <h1>Round ${esc(round.id)}</h1>
  <p class="lede">One maze an hour, the same for everybody, rebuilt from the id alone.</p>
  <div class="row">
    <span class="tag ${open ? "open" : ""}">${open ? "open now" : "closed"}</span>
    <span class="tag">shortest route <b>${round.optimalSteps} steps</b></span>
    <span class="tag">opened <b>${esc(round.openedAt.toISOString().slice(11, 16))} UTC</b></span>
    <span class="tag">closes <b>${esc(round.closesAt.toISOString().slice(11, 16))} UTC</b></span>
  </div>
  ${boards.map(boardTable).join("")}
  <h2>Elsewhere</h2>
  <p class="lede"><a href="/">what this is</a> · <a href="/board">all time</a></p>`,
  unfurl === undefined ? "" : unfurlMeta(unfurl),
  hourGone(round, open).spent, hourGone(round, open).label);
}

export function boardPage(boards: readonly Board[]): string {
  return shell("All time — Toll", `
  <h1>All time</h1>
  <p class="lede">Across every round still in memory. A run that ages out leaves this board — the
  reputation written on chain does not.</p>
  ${boards.map(boardTable).join("")}
  <h2>Elsewhere</h2>
  <p class="lede"><a href="/">what this is</a></p>`);
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
  return shell(`Run ${run.id.slice(0, 8)} — Toll`, `
  <h1>One run, replayable</h1>
  <p class="lede">The address an ERC-8004 reputation record quotes, permanently. Everything needed
  to check it is here.</p>
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
  <p class="lede"><a href="/run/${esc(run.id)}/verify">replay this run</a> ·
  <a href="/round/${esc(run.round)}">the round</a> · <a href="/">what this is</a></p>`,
  "",
  // A run's own limit is the maze: sixty inner walls, and the ones it has paid to establish. The
  // panel above already counts them, so the mark says the same thing from the top of the page.
  maze.total === 0 ? null : maze.learned / maze.total,
  `${maze.learned} of ${maze.total} inner walls established`);
}
