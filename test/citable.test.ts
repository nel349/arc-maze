import { expect, test } from "bun:test";
import { uncitable } from "../src/citable.ts";

/**
 * What a permanent record is allowed to quote.
 *
 * A reputation record on Arc carries a `/run/:id` URL for ever, so the question is not "is this
 * host up" but "can somebody else fetch this tomorrow". The guard used to check only one of the two
 * ways of failing that — names that expire — and missed the one that is the **default**.
 *
 * With `PUBLIC_URL` unset the server calls itself `http://localhost:8790`, which passed the check
 * and wrote permanent claims citing evidence nobody but that laptop could ever produce. It is the
 * likeliest configuration in existence, and it was the one exempted.
 */

test("a real hostname can be quoted for ever", () => {
  for (const url of [
    "https://arc-maze.vercel.app",
    "https://toll.example.com",
    "http://maze.example.co.uk:8790",
  ]) {
    expect(uncitable(url)).toBeNull();
  }
});

test("an address only this machine can reach is refused, which is what unset gives you", () => {
  for (const url of [
    "http://localhost:8790",
    "http://localhost",
    "http://app.localhost:3000",
    "http://127.0.0.1:8790",
    "http://127.1.2.3:8790",   // the whole 127/8 block is loopback, not just .0.1
    "http://0.0.0.0:8790",
    "http://[::1]:8790",
  ]) {
    expect(uncitable(url), `${url} should be refused`).toBe("private");
  }
});

/** A laptop on a home network is no more reachable by a stranger than a loopback address. */
test("private and link-local ranges are refused too", () => {
  for (const url of [
    "http://10.0.0.5:8790",
    "http://192.168.1.42:8790",
    "http://172.16.0.1:8790",
    "http://172.31.255.254:8790",
    "http://169.254.1.1:8790",
    "http://normans-laptop.local:8790",
  ]) {
    expect(uncitable(url), `${url} should be refused`).toBe("private");
  }
});

/**
 * And the public ranges that merely *look* private must not be caught.
 *
 * `172.32.x` is outside RFC 1918 and `10.example.com` is a hostname, not an address. A guard that
 * over-refuses would stop a legitimate deployment writing anything, which is a worse failure than
 * the one it prevents — the maze would look broken rather than careful.
 */
test("addresses that only resemble private ones are still citable", () => {
  for (const url of [
    "https://172.32.0.1",
    "https://172.15.0.1",
    "https://10.example.com",
    "https://localhost.example.com",
    "https://mylocalhost.io",
  ]) {
    expect(uncitable(url), `${url} should be allowed`).toBeNull();
  }
});

test("names that expire are refused, and named as the different problem they are", () => {
  for (const url of [
    "https://abc-def.trycloudflare.com",
    "https://x.ngrok.app",
    "https://x.ngrok-free.app",
    "https://x.ngrok.io",
    "https://x.loca.lt",
  ]) {
    expect(uncitable(url), `${url} should be refused`).toBe("temporary");
  }
});

/**
 * Something that is not a URL refuses rather than throwing.
 *
 * This runs at startup, before anything is served. Throwing here would take the whole maze down
 * over a typo in a variable that only governs whether records are written.
 */
test("nonsense is refused rather than thrown at", () => {
  for (const bad of ["", "not a url", "://missing-scheme", "http://"]) {
    expect(uncitable(bad)).toBe("private");
  }
});
