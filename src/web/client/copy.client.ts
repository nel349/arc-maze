/**
 * Lines to copy, and taking a copy of them.
 *
 * Any button carrying `data-copy` copies the text of the element it names, so the page can offer
 * more than one line to copy: the connector's install line and the sentence for the agent.
 *
 * The text is copied exactly as the server wrote it. The sentence's address used to be swapped here
 * for whatever address the page happened to be opened at, which put deployment hostnames into a
 * sentence meant to outlive them. The server now decides the address from the request — the
 * reader's own on a laptop, the public one otherwise, see `src/web/site.ts` — so there is one
 * decision and nothing here to disagree with it.
 */

/** Long enough to read, short enough that the button is ready again before it is wanted. */
const CONFIRM_MS = 1600;
/** Longer, because being told which keys to press is only useful if it stays on screen. */
const INSTRUCT_MS = 2400;

(function copyable(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-copy]"))) {
    const code = document.getElementById(button.dataset["copy"] ?? "");
    if (code === null) continue;

    // Consts, not hoisted functions: the compiler will not carry a null check into a `function`,
    // because one can be called before the check runs.
    const say = (message: string, forMs: number): void => {
      button.textContent = message;
      window.setTimeout(() => { button.textContent = "Copy"; }, forMs);
    };

    /**
     * Selecting is the fallback, not a failure message.
     *
     * `writeText` needs a secure context, which localhost is and plain http is not, and it also
     * needs the click to still count as user activation. When it is refused the text is selected
     * instead, so the next keystroke does what the button would have done.
     */
    const select = (): void => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      if (selection === null) return;
      selection.removeAllRanges();
      selection.addRange(range);
      say("Press ⌘C", INSTRUCT_MS);
    };

    button.addEventListener("click", () => {
      if (navigator.clipboard === undefined) {
        select();
        return;
      }
      void navigator.clipboard.writeText(code.textContent ?? "").then(
        () => { say("Copied", CONFIRM_MS); },
        select,
      );
    });
  }
})();
