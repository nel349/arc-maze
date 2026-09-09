import type { Board, Entry } from "../maze/boards.ts";
import { nothingKnown } from "../maze/grid.ts";
import type { Cohort } from "../arc/badge.ts";
import type { PublishedRun } from "../maze/runs.ts";
import { PRICES } from "../maze/runs.ts";
import type { Round } from "../maze/round.ts";
import { drawMaze, MAZE_CSS, type MazeDrawing } from "./maze-svg.ts";
import { arcRing, cohortPlate, PALETTE_CSS, STRUCTURE_CSS } from "./brand.ts";
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
body{margin:0;background:var(--ground);color:var(--text);font-family:var(--sans);line-height:1.55}
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

/* The front page's opening: the maze on the left, the stakes on the right. A maze game whose
   front page had no maze in it was the single biggest thing missing — a person could read the
   whole page and never see the thing being sold. */
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(13rem,17rem);gap:2rem;
      align-items:start;margin:0 0 2.5rem}
.hero .board{background:var(--surface);border:1px solid var(--edge);border-radius:10px;
             padding:1.4rem;display:flex;justify-content:center}
/* Capped rather than stretched: a six-by-six grid blown across a wide column stops looking like a
   maze and starts looking like a spreadsheet. */
.hero svg.maze{display:block;width:100%;max-width:22rem;height:auto}
.stakes{display:flex;flex-direction:column;gap:1rem}
.stakes .plate{align-self:flex-start}
.clock{font-family:var(--mono);font-size:1.5rem;font-weight:700;color:var(--text);
       letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.clock small{display:block;font-size:.72rem;font-weight:400;letter-spacing:.06em;
             text-transform:uppercase;color:var(--muted);margin-top:.2rem}
.stake{font-family:var(--mono);font-size:.82rem;color:var(--muted)}
.stake b{color:var(--text)}
/* The one instruction on the page. It is a call to action, so it gets the accent and a box. */
.enter{border:1px solid var(--edge);border-left:3px solid var(--signal);border-radius:8px;
       background:var(--surface);padding:1rem 1.15rem;margin:0 0 2.5rem}
.enter p{margin:0 0 .5rem}
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
@media (max-width:44rem){.hero{grid-template-columns:1fr}}

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
               markLabel = "Toll"): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${esc(title)}</title>${head}<style>${CSS}</style></head><body><main>${masthead(spent, markLabel)}${body}
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

const priceRow = (): string =>
  `<p class="tag">a step <b>${usd(PRICES.move)}</b> · a look <b>${usd(PRICES.look)}</b> ·
   the whole map <b>${usd(PRICES.map)}</b></p>`;

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
export function indexPage(
  round: Round, open: boolean, endpoints: readonly Endpoint[],
  extra: { readonly boards?: readonly Board[]; readonly cohort?: Cohort | null; readonly base?: string } = {},
): string {
  const { spent, label } = hourGone(round, open);
  const minutes = Math.max(0, Math.ceil((round.closesAt.getTime() - Date.now()) / 60_000));
  const best = extra.boards?.find((b) => b.kind === "fewest-steps")?.entries[0];
  const link = `${extra.base === undefined || extra.base === "" ? "" : extra.base}/`;

  // Nothing known: the maze as a run sees it before it has bought anything. Drawn from the real
  // round, so the shape on the page is the shape being played right now.
  const fog = drawMaze(round.cells, nothingKnown());

  return shell("Toll — a maze your agent pays to walk", `
  <h1>A maze your agent pays to walk</h1>
  <p class="lede">Every wall is hidden until somebody buys the answer. A step costs a tenth of a
  cent, and the shortest way out is <b>${round.optimalSteps} steps</b>.</p>

  <div class="hero">
    <div class="board">${fog.svg}</div>
    <div class="stakes">
      ${extra.cohort === undefined || extra.cohort === null
        ? ""
        : cohortPlate(extra.cohort.minted, { of: extra.cohort.of, size: 132 })}
      <div class="clock">${open ? `${minutes} min` : "closed"}<small>${open ? "left in this round" : `round ${esc(round.id)}`}</small></div>
      <p class="stake">${round.optimalSteps} steps is perfect</p>
      <p class="stake">${best === undefined
        ? "Nobody has solved this one yet"
        : `Best so far <b>${best.steps} steps</b> for <b>${esc(usd(best.spentUsd))}</b>`}</p>
      <p class="stake">Winners keep a permanent record, and one of the
      ${extra.cohort?.of ?? 100} badges.</p>
    </div>
  </div>

  <div class="enter">
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
    because nothing told it to play. Its first call is <b>POST /game</b>, and it pays from there.
    No account, no card, no signup.</p>
  </div>

  <h2>Watch it happen</h2>
  <p class="lede">This round, live as agents walk it.
  <a href="/round/${esc(round.id)}">${esc(round.id)}</a> · <a href="/board">all time</a></p>
  ${(extra.boards ?? []).map(boardTable).join("")}

  ${priceRow()}
  <h2>Every address this answers</h2>
  <div class="panel"><div class="scroll"><table>
    <tr><th>Method</th><th>Path</th><th>What</th><th class="n">Cost</th></tr>
    ${endpoints.map((e) => `<tr>
      <td>${esc(e.method)}</td>
      <td>${esc(e.path)}</td>
      <td class="what">${esc(e.what)}</td>
      <td class="n">${e.price === undefined ? "free" : esc(usd(e.price))}</td>
    </tr>`).join("")}
  </table></div></div>
  <h2>Check it yourself</h2>
  <p class="lede">The maze comes from the round id, so anyone can rebuild it and replay any run.</p>`,
  "", spent, label);
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
