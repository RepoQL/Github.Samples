import type { GitHub, GitHubResponse } from "../src/github-client.js";

export interface Call {
  method: string;
  path: string;
  body: unknown;
  /** Set when the call came through paginate, which the fake answers as one page. */
  paginated?: true;
}

export type Answer = GitHubResponse | { data: unknown; status?: number } | Error;

/** A GitHub that answers from a handler and records every call, so no test reaches the network. */
export class FakeGitHub implements GitHub {
  readonly calls: Call[] = [];

  constructor(private readonly handler: (call: Call) => Answer | undefined = () => ({ data: {} })) {}

  async request(method: string, path: string, body?: unknown): Promise<GitHubResponse> {
    // The body as it went over the wire, so a caller that changes its payload afterwards does not rewrite the record.
    return this.answer({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
  }

  async paginate(path: string, key?: string): Promise<unknown[]> {
    const response = this.answer({ method: "GET", path, body: undefined, paginated: true });
    if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${response.text}`);
    const page = key ? (response.data as Record<string, unknown>)[key] : response.data;
    return Array.isArray(page) ? page : [];
  }

  private answer(call: Call): GitHubResponse {
    this.calls.push(call);
    return respond(this.handler(call));
  }
}

export function respond(answer: Answer | undefined): GitHubResponse {
  if (answer instanceof Error) throw answer;
  if (answer === undefined) return { status: 404, ok: false, data: null, text: "Not Found" };
  if ("ok" in answer) return answer;
  const status = answer.status ?? 200;
  const text = answer.data === undefined ? "" : JSON.stringify(answer.data);
  return { status, ok: status >= 200 && status < 300, data: answer.data ?? null, text };
}
