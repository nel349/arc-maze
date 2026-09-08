import type { Board, Entry } from "../maze/boards.ts";
import type { PublishedRun } from "../maze/runs.ts";
import { PRICES } from "../maze/runs.ts";
import type { Round } from "../maze/round.ts";
import { MAZE_CSS, type MazeDrawing } from "./maze-svg.ts";
import { PALETTE_CSS, STRUCTURE_CSS } from "./brand.ts";
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
`;

const shell = (title: string, body: string, head = ""): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${head}<style>${CSS}</style></head><body><main>${body}
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

export function indexPage(round: Round, open: boolean, endpoints: readonly Endpoint[]): string {
  return shell("Cohort 0 — a maze on Arc", `
  <h1>A maze on Arc that charges by the step</h1>
  <p class="lede">It pays out <b>reputation</b>, not money: a record on the agent's own ERC-8004
  identity, written by us — which is the point, since an agent cannot award itself one.</p>
  ${priceRow()}
  <div class="row">
    <span class="tag">round <b>${esc(round.id)}</b></span>
    <span class="tag ${open ? "open" : ""}">${open ? "open now" : "closed"}</span>
    <span class="tag">shortest route <b>${round.optimalSteps} steps</b></span>
    <span class="tag">closes <b>${esc(round.closesAt.toISOString().slice(11, 16))} UTC</b></span>
  </div>
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
  <p class="lede">The maze comes from the round id, so anyone can rebuild it and replay any run.
  <a href="/round/${esc(round.id)}">This round</a> · <a href="/board">all time</a></p>`);
}

export function roundPage(
  round: Round, open: boolean, boards: readonly Board[], unfurl?: Unfurl,
): string {
  return shell(`Round ${round.id} — Cohort 0`, `
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
  unfurl === undefined ? "" : unfurlMeta(unfurl));
}

export function boardPage(boards: readonly Board[]): string {
  return shell("All time — Cohort 0", `
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
  return shell(`Run ${run.id.slice(0, 8)} — Cohort 0`, `
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
  <a href="/round/${esc(run.round)}">the round</a> · <a href="/">what this is</a></p>`);
}
