import { GitError } from "@particle-academy/fancy-git";
import type { GitErrorCode } from "@particle-academy/fancy-git";
import type { CheckSummary, Comparison, CreateReviewInput, GitProvider, GitRemote, HostedRepository, Page, ProviderRepositoryRef, Review, ReviewDetails, ReviewQuery } from "@particle-academy/fancy-git";

export interface BitbucketProviderOptions {
  token?: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

/** Trailing slashes stripped by scanning: `replace(/\/+$/, "")` is quadratic on a long run of slashes not at the end. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return value.slice(0, end);
}

/** The fancy-git contract code for a Bitbucket HTTP status, the same table every adapter uses. */
function errorCodeFor(status: number): GitErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 405) return "unsupported";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid_argument";
  if (status === 429) return "rate_limited";
  return "unknown";
}

/** Bitbucket's error body (`{"type":"error","error":{"message":...}}`), bounded and single-line. */
async function errorMessage(response: Response): Promise<string> {
  let message = response.statusText || "no reason given";
  try {
    const content = JSON.parse(await response.text());
    if (typeof content?.error?.message === "string") message = content.error.message;
    else if (typeof content?.message === "string") message = content.message;
  } catch {
    // not JSON: keep the status text
  }
  const line = message.replace(/[\x00-\x1F\x7F]+/g, " ");
  return line.length > 500 ? `${line.slice(0, 500)}...` : line;
}

export class BitbucketProvider implements GitProvider {
  /** How many times a GET that answered 5xx is sent again. Never a POST. */
  static readonly GET_RETRIES = 2;
  /** The wait before retry n is n times this. */
  static readonly RETRY_DELAY_MS = 100;

  readonly kind = "bitbucket" as const;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: BitbucketProviderOptions = {}) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? "https://api.bitbucket.org/2.0");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  identify(remote: GitRemote): ProviderRepositoryRef | null {
    const match = remote.fetchUrl.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match || match[1] !== "bitbucket.org") return null;
    return { provider: this.kind, owner: match[2]!, name: match[3]! };
  }

  async repository(ref: ProviderRepositoryRef): Promise<HostedRepository> {
    const data = await this.request(`/repositories/${this.key(ref)}`);
    return { provider: this.kind, owner: ref.owner, name: ref.name, id: data.uuid, webUrl: data.links.html.href, defaultBranch: data.mainbranch?.name ?? "main", private: data.is_private, description: data.description || undefined };
  }

  async listReviews(ref: ProviderRepositoryRef, query: ReviewQuery = {}): Promise<Page<Review>> {
    const state = query.state === "merged" ? "MERGED" : query.state === "closed" ? "DECLINED" : "OPEN";
    const page = query.cursor ?? "1";
    const data = await this.request(`/repositories/${this.key(ref)}/pullrequests?state=${state}&page=${encodeURIComponent(page)}&pagelen=${query.limit ?? 30}`);
    return { items: data.values.map((item: any) => this.mapReview(item)), ...(data.next ? { nextCursor: new URL(data.next).searchParams.get("page") ?? undefined } : {}), total: data.size };
  }

  async getReview(ref: ProviderRepositoryRef, number: number): Promise<ReviewDetails> {
    const data = await this.request(`/repositories/${this.key(ref)}/pullrequests/${number}`);
    return { ...this.mapReview(data), body: data.description || undefined, createdAt: data.created_on, updatedAt: data.updated_on };
  }

  async createReview(ref: ProviderRepositoryRef, input: CreateReviewInput): Promise<Review> {
    const data = await this.request(`/repositories/${this.key(ref)}/pullrequests`, { method: "POST", body: JSON.stringify({ title: input.title, description: input.body, source: { branch: { name: input.sourceBranch } }, destination: { branch: { name: input.targetBranch } } }) });
    return this.mapReview(data);
  }

  async compare(ref: ProviderRepositoryRef, base: string, head: string): Promise<Comparison> {
    const data = await this.request(`/repositories/${this.key(ref)}/commits/${encodeURIComponent(head)}?exclude=${encodeURIComponent(base)}`);
    return { aheadBy: data.values.length, behindBy: 0, commits: data.values.map((commit: any) => ({ id: commit.hash, shortId: commit.hash.slice(0, 7), parents: commit.parents.map((parent: any) => parent.hash), authorName: commit.author?.raw ?? "unknown", authorEmail: "", authoredAt: commit.date, subject: commit.message.split("\n", 1)[0] })) };
  }

  async checks(ref: ProviderRepositoryRef, revision: string): Promise<CheckSummary[]> {
    const data = await this.request(`/repositories/${this.key(ref)}/commit/${encodeURIComponent(revision)}/statuses`);
    return data.values.map((status: any) => ({ id: status.key, name: status.name || status.key, state: status.state === "SUCCESSFUL" ? "passed" : status.state === "INPROGRESS" ? "running" : status.state === "STOPPED" ? "cancelled" : "failed", webUrl: status.url, startedAt: status.created_on, completedAt: status.updated_on }));
  }

  private key(ref: ProviderRepositoryRef) { return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`; }
  private mapReview(item: any): Review {
    return { id: item.id.toString(), number: item.id, title: item.title, state: item.state === "MERGED" ? "merged" : item.state === "OPEN" ? "open" : "closed", webUrl: item.links.html.href, sourceBranch: item.source.branch.name, targetBranch: item.destination.branch.name, author: item.author?.display_name ?? "unknown" };
  }
  /**
   * One request. A GET that answers 5xx is retried, at most GET_RETRIES times;
   * a POST is never replayed, because Bitbucket may already hold what it
   * created. Every failure is a `GitError` carrying the fancy-git code.
   */
  private async request(path: string, init: RequestInit = {}) {
    const token = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    const method = (init.method ?? "GET").toUpperCase();
    const what = `${method} ${path.split("?", 1)[0]}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
      } catch (error) {
        throw new GitError("unknown", `Bitbucket request ${what} could not be completed: ${(error as Error)?.message ?? String(error)}`);
      }
      if (method !== "GET" || response.status < 500 || response.status > 599 || attempt >= BitbucketProvider.GET_RETRIES) break;
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, BitbucketProvider.RETRY_DELAY_MS * (attempt + 1)));
    }
    if (!response.ok) {
      throw new GitError(errorCodeFor(response.status), `Bitbucket answered ${what} with ${response.status}: ${await errorMessage(response)}`, response.status);
    }
    return response.json();
  }
}
