import { expect, test } from "bun:test";
import { isLocalHost, siteFor } from "../src/web/site.ts";

const PUBLIC = "https://arc-maze.vercel.app";

test("someone running the maze on their laptop is given their own address", () => {
  expect(siteFor("http://localhost:4319/", PUBLIC)).toBe("http://localhost:4319");
  expect(siteFor("http://127.0.0.1:3000/", PUBLIC)).toBe("http://127.0.0.1:3000");
  expect(siteFor("http://[::1]:3000/", PUBLIC)).toBe("http://[::1]:3000");
  expect(siteFor("http://norman-mbp.local:3000/", PUBLIC)).toBe("http://norman-mbp.local:3000");
});

test("everyone else is given the public address, whichever host they came in through", () => {
  expect(siteFor("https://arc-maze.vercel.app/", PUBLIC)).toBe(PUBLIC);
  // A deployment URL and a tunnel are addresses of the moment; the sentence must outlive them.
  expect(siteFor("https://arc-maze-k2uj7o0wk-nel349s-projects.vercel.app/", PUBLIC)).toBe(PUBLIC);
  expect(siteFor("https://abc123.ngrok-free.app/", PUBLIC)).toBe(PUBLIC);
});

test("with no public address configured, the request's own address is the best there is", () => {
  expect(siteFor("https://maze.example.org/", "")).toBe("https://maze.example.org");
});

test("a trailing slash on the configured address does not double up", () => {
  expect(siteFor("https://arc-maze.vercel.app/", `${PUBLIC}/`)).toBe(PUBLIC);
});

test("only this machine's names count as local", () => {
  expect(isLocalHost("localhost")).toBe(true);
  expect(isLocalHost("arc-maze.vercel.app")).toBe(false);
  expect(isLocalHost("localhost.evil.com")).toBe(false);
});
