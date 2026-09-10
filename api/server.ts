import { readdirSync, existsSync } from "node:fs";

/**
 * A diagnostic, not the server.
 *
 * Two guesses have now been spent on `ResolveMessage {}`, which is Bun failing to resolve an import
 * and saying nothing about which one. Rather than guess a third time, this reports what is actually
 * on disk beside the function and what the failing import says when it is caught — which a static
 * import cannot do, because it fails before any handler runs.
 */
const look = (path: string): string[] | string => {
  try {
    return existsSync(path) ? readdirSync(path).slice(0, 40) : "(absent)";
  } catch (cause) {
    return `(unreadable: ${String(cause)})`;
  }
};

Bun.serve({
  async fetch() {
    let imported: string;
    try {
      await import("../server.ts");
      imported = "resolved";
    } catch (cause) {
      imported = `${(cause as Error).name}: ${(cause as Error).message}`;
    }

    return Response.json({
      cwd: process.cwd(),
      importOfRootServer: imported,
      here: look("."),
      parent: look(".."),
      src: look("./src"),
      srcFromParent: look("../src"),
      webClient: look("./src/web/client"),
      env: {
        SELLER_ADDRESS: process.env["SELLER_ADDRESS"] === undefined ? "unset" : "set",
        PUBLIC_URL: process.env["PUBLIC_URL"] ?? "unset",
      },
    }, { status: 200 });
  },
});
