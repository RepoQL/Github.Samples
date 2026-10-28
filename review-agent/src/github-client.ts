/** The GitHub REST and GraphQL API over fetch, with the one shape every module and test fake shares. */

export interface GitHubResponse {
  status: number;
  ok: boolean;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  data: unknown;
  /** The raw body, for error messages. */
  text: string;
}

export interface GitHub {
  /** One request. Never throws for an HTTP status; throws only when the request cannot be made. */
  request(method: string, path: string, body?: unknown): Promise<GitHubResponse>;
  /** Every page of a GET whose body is an array (or holds one under `key`), following `Link: rel="next"`. Throws on a non-2xx page. */
  paginate(path: string, key?: string): Promise<unknown[]>;
}

export class GitHubError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly response: GitHubResponse,
  ) {
    super(`${method} ${path} returned ${response.status}: ${response.text.slice(0, 2000)}`);
  }
}

/** A GET, or a POST when body is given; throws on a non-2xx status or on GraphQL errors. */
export async function read(github: GitHub, path: string, body?: unknown): Promise<unknown> {
  const method = body === undefined ? "GET" : "POST";
  const response = await github.request(method, path, body);
  if (!response.ok) throw new GitHubError(method, path, response);
  const data = response.data as { errors?: unknown } | null;
  const errors = data && typeof data === "object" && !Array.isArray(data) ? data.errors : undefined;
  if (errors && !(Array.isArray(errors) && errors.length === 0)) {
    throw new Error(`${method} ${path} returned errors: ${JSON.stringify(errors)}`);
  }
  return response.data;
}

export interface ClientOptions {
  token: string;
  /** GITHUB_API_URL on Actions; api.github.com elsewhere. */
  apiUrl?: string;
  /** GITHUB_GRAPHQL_URL on Actions; `<apiUrl>/graphql` elsewhere. The path `graphql` goes here. */
  graphqlUrl?: string;
  fetch?: typeof fetch;
}

export function createGitHub({ token, apiUrl = "https://api.github.com", graphqlUrl, fetch: fetcher = fetch }: ClientOptions): GitHub {
  const base = apiUrl.replace(/\/+$/, "");
  const url = (path: string) => {
    if (/^https?:\/\//.test(path)) return path;
    if (path === "graphql") return graphqlUrl ?? `${base}/graphql`;
    return `${base}/${path.replace(/^\/+/, "")}`;
  };

  async function send(method: string, target: string, body?: unknown): Promise<{ response: GitHubResponse; next: string | null }> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "repoql-review-agent",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const reply = await fetcher(url(target), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await reply.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    const link = reply.headers.get("link") ?? "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { response: { status: reply.status, ok: reply.ok, data, text }, next };
  }

  return {
    async request(method, path, body) {
      return (await send(method, path, body)).response;
    },
    async paginate(path, key) {
      const rows: unknown[] = [];
      let target: string | null = path;
      while (target) {
        const { response, next }: { response: GitHubResponse; next: string | null } = await send("GET", target);
        if (!response.ok) throw new GitHubError("GET", target, response);
        const page = key ? (response.data as Record<string, unknown> | null)?.[key] : response.data;
        if (!Array.isArray(page)) throw new Error(`GET ${target} did not return an array${key ? ` under ${key}` : ""}`);
        rows.push(...page);
        target = next;
      }
      return rows;
    },
  };
}

/** The client a step or the CLI uses: the token from GH_TOKEN or GITHUB_TOKEN, the API from GITHUB_API_URL. */
export function githubFromEnvironment(environ: NodeJS.ProcessEnv = process.env, token?: string): GitHub {
  const options: ClientOptions = { token: token ?? environ.GH_TOKEN ?? environ.GITHUB_TOKEN ?? "" };
  if (environ.GITHUB_API_URL) options.apiUrl = environ.GITHUB_API_URL;
  if (environ.GITHUB_GRAPHQL_URL) options.graphqlUrl = environ.GITHUB_GRAPHQL_URL;
  return createGitHub(options);
}
