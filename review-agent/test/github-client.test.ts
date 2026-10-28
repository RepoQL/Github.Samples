import { describe, expect, it } from "vitest";

import { GitHubError, createGitHub, read } from "../src/github-client.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(pages: Record<string, { status?: number; body: unknown; link?: string }>) {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
    const page = pages[url];
    if (!page) return new Response("Not Found", { status: 404 });
    const headers = new Headers(page.link ? { link: page.link } : {});
    return new Response(typeof page.body === "string" ? page.body : JSON.stringify(page.body), { status: page.status ?? 200, headers });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("the GitHub client", () => {
  it("authenticates, sends JSON, and never throws on an HTTP status", async () => {
    const { fetcher, seen } = fakeFetch({ "https://api.github.com/repos/O/R/issues/1/comments": { status: 403, body: { message: "no" } } });
    const github = createGitHub({ token: "t0ken", fetch: fetcher });
    const response = await github.request("POST", "repos/O/R/issues/1/comments", { body: "hi" });
    expect(response).toMatchObject({ status: 403, ok: false, data: { message: "no" } });
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"body":"hi"}' });
    expect(seen[0]?.headers.authorization).toBe("Bearer t0ken");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
  });

  it("follows every next page and concatenates arrays, under a key when given", async () => {
    const { fetcher } = fakeFetch({
      "https://api.example/repos/O/R/pulls/1/files": { body: [1, 2], link: '<https://api.example/page2>; rel="next", <https://api.example/page2>; rel="last"' },
      "https://api.example/page2": { body: [3] },
      "https://api.example/repos/O/R/actions/artifacts": { body: { total_count: 1, artifacts: [{ id: 9 }] } },
    });
    const github = createGitHub({ token: "", apiUrl: "https://api.example/", fetch: fetcher });
    expect(await github.paginate("repos/O/R/pulls/1/files")).toEqual([1, 2, 3]);
    expect(await github.paginate("/repos/O/R/actions/artifacts", "artifacts")).toEqual([{ id: 9 }]);
    await expect(github.paginate("repos/O/R/missing")).rejects.toBeInstanceOf(GitHubError);
  });

  it("sends graphql to the GraphQL endpoint, and read throws on its errors", async () => {
    const { fetcher, seen } = fakeFetch({
      "https://ghe.example/api/graphql": { body: { errors: [{ message: "bad query" }] } },
    });
    const github = createGitHub({ token: "", apiUrl: "https://ghe.example/api/v3", graphqlUrl: "https://ghe.example/api/graphql", fetch: fetcher });
    await expect(read(github, "graphql", { query: "{}" })).rejects.toThrow(/bad query/);
    expect(seen[0]?.method).toBe("POST");
  });

  it("reads a GET, and throws on a non-2xx status with the body in the message", async () => {
    const { fetcher } = fakeFetch({ "https://api.github.com/repos/O/R/pulls/1": { body: { number: 1 } } });
    const github = createGitHub({ token: "", fetch: fetcher });
    expect(await read(github, "repos/O/R/pulls/1")).toEqual({ number: 1 });
    await expect(read(github, "repos/O/R/pulls/2")).rejects.toThrow(/404: Not Found/);
  });
});
