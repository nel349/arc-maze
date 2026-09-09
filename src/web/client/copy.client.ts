/**
 * The prompt, and taking a copy of it.
 *
 * The address is read from the browser rather than from `PUBLIC_URL`. A prompt quoting the name the
 * server was configured with is wrong the moment somebody arrives through a tunnel, an IP or a
 * preview host — and with nothing configured it rendered a bare "/". The server still emits its
 * best guess, so this degrades to something sensible with no JavaScript at all.
 */

/** Long enough to read, short enough that the button is ready again before it is wanted. */
const CONFIRM_MS = 1600;
/** Longer, because being told which keys to press is only useful if it stays on screen. */
const INSTRUCT_MS = 2400;

(function copyable(): void {
  const code = document.getElementById("prompt");
  const button = document.getElementById("copy");
  if (code === null || button === null) return;

  const prompt = (): string =>
    `Solve the maze at ${window.location.origin}/ — spend as little as you can.`;

  code.textContent = prompt();

  // Consts, not hoisted functions: the compiler will not carry a null check into a `function`,
  // because one can be called before the check runs.
  const say = (message: string, forMs: number): void => {
    button.textContent = message;
    window.setTimeout(() => { button.textContent = "Copy"; }, forMs);
  };

  /**
   * Selecting is the fallback, not a failure message.
   *
   * `writeText` needs a secure context, which localhost is and plain http is not, and it also needs
   * the click to still count as user activation. When it is refused the text is selected instead,
   * so the next keystroke does what the button would have done.
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
    void navigator.clipboard.writeText(prompt()).then(
      () => { say("Copied", CONFIRM_MS); },
      select,
    );
  });
})();
