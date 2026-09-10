/**
 * A round that moves while you watch it, without a second place for the board to be wrong.
 *
 * The stream has existed since the round page did, and nothing on the page ever opened it: the
 * board was rendered once by the server and then sat still while agents played, so "watch a round"
 * meant "reload and see if anything happened".
 *
 * The obvious fix is to render the board here from the event data, and it is the wrong one. This
 * module's own rule is one set of numbers and no second source of truth — ranking, formatting and
 * the claimed-versus-settled distinction all live on the server, and a copy of them in the browser
 * is a copy that will disagree the first time either is touched.
 *
 * So the stream is used only as a **notification**. It says something happened; the server is still
 * the one that says what the board now is. The cost is a fetch per burst rather than per event, and
 * what is bought is that a live board and a reloaded board cannot differ.
 */

/** Long enough that a run paying by the step causes one fetch, not eighteen. */
const SETTLE_MS = 700;
/** After this many failures in a row, stop refetching and let the reconnect drive it. */
const GIVE_UP_AFTER = 4;

(function live(): void {
  const boards = document.getElementById("boards");
  const round = boards?.dataset["round"];
  if (boards === null || round === undefined) return;

  let timer: number | undefined;
  let failures = 0;
  let inFlight = false;
  /**
   * Something happened while we were already fetching.
   *
   * Dropping that used to be the bug. Events arrive faster than a round trip while an agent is
   * paying by the step, so a refusal to overlap meant the *last* one — the `finished` that says the
   * run is over — could land mid-fetch and be thrown away, leaving the board one step short of the
   * truth for as long as nobody else played. Remembering it costs a boolean.
   */
  let missed = false;

  const swap = async (): Promise<void> => {
    // One at a time. A second fetch while the first is in the air would race to replace the same
    // node, and the loser could be the newer answer.
    if (inFlight) { missed = true; return; }
    inFlight = true;
    try {
      const response = await fetch(window.location.pathname, {
        headers: { accept: "text/html" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));

      const fresh = new DOMParser()
        .parseFromString(await response.text(), "text/html")
        .getElementById("boards");
      // A page without the node is a page from a different version of this server. Leaving what is
      // on screen is better than emptying it.
      if (fresh !== null) boards.innerHTML = fresh.innerHTML;
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      inFlight = false;
    }
    if (missed) {
      missed = false;
      soon();
    }
  };

  function soon(): void {
    if (failures >= GIVE_UP_AFTER) return;
    // Hidden tabs are not watching. Whatever they missed is collected when they come back.
    if (document.visibilityState === "hidden") return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void swap(); }, SETTLE_MS);
  }

  const stream = new EventSource(`/round/${encodeURIComponent(round)}/stream`);

  // `standing` is the state the page was already rendered from, replayed for anyone arriving
  // mid-round. Refetching on it would mean one wasted request per connection, and one more every
  // time the connection is re-established.
  for (const kind of ["started", "bought", "finished"]) {
    stream.addEventListener(kind, soon);
  }

  // The connection is cut at five minutes on this host, and by any proxy that dislikes an idle
  // socket. `EventSource` reconnects on its own; what it cannot do is tell us what was missed
  // while it was away, so catch up once it is back.
  stream.addEventListener("open", () => { failures = 0; soon(); });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") soon();
  });
})();
