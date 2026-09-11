/**
 * The address the page gives out, in the sentence a person copies for their agent.
 *
 * Two readers, two right answers. Someone running the maze on their own laptop has to be told their
 * own address, because the public one would send their agent to a different maze. Everyone else has
 * to be told the public one, even when they arrived through a deployment URL, a preview host or a
 * tunnel: those are addresses of the moment, and a sentence copied from one of them points an agent
 * at a place that may be gone tomorrow.
 *
 * Decided on the server, from the address the request came in on, because the browser scripts here
 * are transpiled one file at a time and cannot share this with the server. It used to be the other
 * way round, with the browser swapping in whatever address the page was opened at, which is how a
 * deployment hostname could end up in the sentence.
 */

/** Addresses that can only mean "this machine". */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** `.local` is how a machine names itself on its own network, so it is local too. */
const LOCAL_SUFFIX = ".local";

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(LOCAL_SUFFIX);
}

/**
 * The site's address, without a trailing slash.
 *
 * `publicUrl` is the configured public address, or empty when none is configured, in which case the
 * request's own address is the best there is.
 */
export function siteFor(requestUrl: string, publicUrl: string): string {
  const url = new URL(requestUrl);
  if (isLocalHost(url.hostname) || publicUrl === "") return url.origin;
  return publicUrl.replace(/\/$/, "");
}
