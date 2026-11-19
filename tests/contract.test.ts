import { describe, expect, it } from "vitest";
import { GitError } from "@particle-academy/fancy-git";
import { BitbucketProvider } from "../src/index.js";

/**
 * Found by the fancy-labs git-adapter test: failures were bare `Error`s with no
 * fancy-git code, a transient 5xx on a GET was not retried, and only ONE
 * trailing slash was stripped from the base URL. The PHP twin is held to the
 * same rules.
 */

const REF = { provider: "bitbucket" as const, owner: "team", name: "app" };
const REPO = { uuid: "{42}", links: { html: { href: "https://bitbucket.org/team/app" } }, mainbranch: { name: "main" }, is_private: true, description: "" };

interface Call {
  url: string;
  method: string;
}

function fake(...responses: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: (init.method ?? "GET").toUpperCase() });
    const next = responses.shift();
    if (next === undefined) throw new Error(`no response queued for ${String(input)}`);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function caught(call: () => Promise<unknown>): Promise<GitError> {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(GitError);
    return error as GitError;
  }
  throw new Error("Expected a GitError.");
}

describe("Bitbucket's failures carry the fancy-git contract code", () => {
  it.each([
    [400, "invalid_argument"],
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [405, "unsupported"],
    [409, "conflict"],
    [422, "invalid_argument"],
    [429, "rate_limited"],
  ])("maps %i to its code", async (status, code) => {
    const { fetch, calls } = fake({ status, body: { type: "error", error: { message: "Nope here" } } });

    const e = await caught(() => new BitbucketProvider({ fetch, token: "t" }).repository(REF));

    expect(e.code).toBe(code);
    expect(e.exitCode).toBe(status);
    expect(e.message).toContain("Nope here");
    expect(calls).toHaveLength(1);
  });

  it("maps a network failure to unknown", async () => {
    const { fetch } = fake(new TypeError("fetch failed"));

    expect((await caught(() => new BitbucketProvider({ fetch }).repository(REF))).code).toBe("unknown");
  });
});

describe("GET retry on a transient 5xx", () => {
  it.each([500, 502, 503, 504])("retries a GET that answered %i", async (status) => {
    const { fetch, calls } = fake({ status, body: { type: "error", error: { message: "down" } } }, { body: REPO });

    const repository = await new BitbucketProvider({ fetch }).repository(REF);

    expect(repository.id).toBe("{42}");
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of retries, with the last 5xx", async () => {
    const { fetch, calls } = fake(...Array.from({ length: 10 }, () => ({ status: 503, body: {} })));

    const e = await caught(() => new BitbucketProvider({ fetch }).repository(REF));

    expect(calls).toHaveLength(1 + BitbucketProvider.GET_RETRIES);
    expect(e.code).toBe("unknown");
    expect(e.exitCode).toBe(503);
  });

  it("never replays a POST", async () => {
    const { fetch, calls } = fake({ status: 502, body: {} }, { status: 201, body: {} });

    const e = await caught(() => new BitbucketProvider({ fetch }).createReview(REF, { title: "T", sourceBranch: "f", targetBranch: "main" }));

    expect(calls).toHaveLength(1);
    expect(e.exitCode).toBe(502);
  });
});

describe("base URL", () => {
  it("strips every trailing slash", async () => {
    const { fetch, calls } = fake({ body: REPO });

    await new BitbucketProvider({ fetch, baseUrl: "https://bb.example.test/2.0///" }).repository(REF);

    expect(calls[0]!.url).toBe("https://bb.example.test/2.0/repositories/team/app");
  });

  it("strips 100,000 trailing slashes in linear time", async () => {
    const { fetch, calls } = fake({ body: REPO });

    const started = performance.now();
    await new BitbucketProvider({ fetch, baseUrl: `https://bb.example.test/2.0${"/".repeat(100_000)}` }).repository(REF);

    expect(performance.now() - started).toBeLessThan(200);
    expect(calls[0]!.url).toBe("https://bb.example.test/2.0/repositories/team/app");
  });
});

describe("pagination", () => {
  it("takes the next cursor from the page number in `next`", async () => {
    const pr = { id: 1, title: "PR", state: "OPEN", links: { html: { href: "x" } }, source: { branch: { name: "f" } }, destination: { branch: { name: "main" } } };
    const { fetch } = fake({ body: { values: [pr], size: 3, next: "https://api.bitbucket.org/2.0/repositories/team/app/pullrequests?state=OPEN&page=2&pagelen=1" } });

    const page = await new BitbucketProvider({ fetch }).listReviews(REF, { limit: 1 });

    expect(page.nextCursor).toBe("2");
  });
});
