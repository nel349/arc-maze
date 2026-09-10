/**
 * Whether a permanent record may quote this address.
 *
 * A reputation record written to Arc carries a `/run/:id` URL and carries it for ever. The rule it
 * has to satisfy is not "is this host up" but **"can somebody else fetch this tomorrow"** — and
 * there are two quite different ways to fail that, only one of which was being checked.
 *
 * A tunnel fails it by expiring: the name resolves right now and is gone by the morning. That was
 * caught. A loopback or private address fails it more completely — `http://localhost:8790/run/…`
 * was never fetchable by anyone but the machine that wrote it, and it is the **default** when
 * `PUBLIC_URL` is unset, which makes it far likelier than any tunnel. Running the maze locally with
 * a reputation key therefore wrote permanent claims citing evidence that could never be produced,
 * which is the exact failure the check exists to prevent, missed in its most ordinary form.
 *
 * The escape hatch stays a deliberate sentence somebody has to write down, because every use of it
 * is a promise that the address will still answer years from now.
 */

/** Names that expire. Fine to play against, never fine to cite. */
const TEMPORARY = /\.(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io|loca\.lt)$/i;

/**
 * Names nobody else can reach, by name rather than by number.
 *
 * `.local` is mDNS and `localhost` is reserved; neither resolves off this network.
 */
const PRIVATE_NAME = /^localhost$|\.localhost$|\.local$/i;

/** IPv6 loopback, with or without the brackets a URL puts round it. */
const IPV6_LOOPBACK = /^\[?::1\]?$/;

/** A dotted quad, and only a dotted quad. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Whether an address is one of the ranges the internet cannot route to.
 *
 * Applied only after confirming the host really is an IPv4 address. Matching these as text against
 * any hostname is a trap the first draft of this fell into: `^10\.` happily refuses
 * `10.example.com`, which is an ordinary public name, and a guard that over-refuses stops a
 * legitimate deployment writing anything — a worse failure than the one being prevented, because
 * the maze then looks broken rather than careful.
 */
function unroutable(hostname: string): boolean {
  const parts = IPV4.exec(hostname);
  if (parts === null) return false;
  const [a, b] = [Number(parts[1]), Number(parts[2])];
  if (a > 255 || b > 255 || Number(parts[3]) > 255 || Number(parts[4]) > 255) return false;

  if (a === 127) return true;                    // 127.0.0.0/8, all of it
  if (a === 0) return true;                      // 0.0.0.0/8
  if (a === 10) return true;                     // RFC 1918
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;       // link-local
  return false;
}

export type Uncitable = "temporary" | "private";

/**
 * Why this address cannot appear in a permanent record, or null if it can.
 *
 * Returns the reason rather than a boolean so the warning can say which of the two problems it is:
 * they need different things from whoever reads it. A tunnel wants a real host; a loopback address
 * usually means `PUBLIC_URL` was simply never set.
 */
export function uncitable(publicUrl: string): Uncitable | null {
  let hostname: string;
  try {
    hostname = new URL(publicUrl).hostname;
  } catch {
    // Not a URL at all. Nothing can be quoted from it, and "private" is the safer of the two
    // readings: it refuses, and the message tells somebody to set a real address.
    return "private";
  }
  if (PRIVATE_NAME.test(hostname) || IPV6_LOOPBACK.test(hostname) || unroutable(hostname)) {
    return "private";
  }
  if (TEMPORARY.test(hostname)) return "temporary";
  return null;
}
