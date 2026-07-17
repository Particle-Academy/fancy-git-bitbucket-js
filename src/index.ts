import type { CheckSummary, Comparison, CreateReviewInput, GitProvider, GitRemote, HostedRepository, Page, ProviderRepositoryRef, Review, ReviewDetails, ReviewQuery } from "@particle-academy/fancy-git";

export interface BitbucketProviderOptions {
  token?: string | (() => string | Promise<string>);
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export class BitbucketProvider implements GitProvider {
  readonly kind = "bitbucket" as const;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: BitbucketProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/$/, "");
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
  private async request(path: string, init: RequestInit = {}) {
    const token = typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
    if (!response.ok) throw new Error(`Bitbucket API request failed (${response.status}).`);
    return response.json();
  }
}
