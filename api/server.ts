import { readdirSync, existsSync } from "node:fs";

/**
 * The function Vercel invokes. It starts the real server, and explains itself if it cannot.
 *
 * The server proper lives at the repository root so that running it locally and running it here are
 * the same program. This file exists only because the platform looks for a function in `api/`.
 *
 * The fallback is here because a boot failure in this runtime surfaces as `ResolveMessage {}` — a
 * 500 with no name of the import that failed, and no handler ever runs to say more. Catching the
 * import turns a silent 500 into a readable answer. It cost two deploys to learn that the first
 * time; it should cost none the next.
 */
try {
  await import("../server.ts");
} catch (cause) {
  const look = (path: string): string[] | string => {
    try {
      return existsSync(path) ? readdirSync(path).slice(0, 40) : "(absent)";
    } catch (unreadable) {
      return `(unreadable: ${String(unreadable)})`;
    }
  };

  console.error("the server did not start:", cause);

  Bun.serve({
    fetch: () =>
      Response.json(
        {
          error: "the server did not start",
          because: `${(cause as Error).name}: ${(cause as Error).message}`,
          cwd: process.cwd(),
          here: look("."),
          src: look("./src"),
          // The last failure was a dependency that could not resolve its own subpath, because the
          // file behind it was never deployed. If that happens again, this says so directly.
          noble: look("./node_modules/@noble/hashes/esm"),
        },
        { status: 500 },
      ),
  });
}
