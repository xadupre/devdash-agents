import {
  GitHubRepository,
  type GitHubDiscussionUpdate,
  type GitHubCommentUpdate,
  type GitHubSection,
  type GitHubUpdate,
} from "./github";
import type { Repository } from "./repositories";

type LoadResult<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

export class GitHubPanel {
  private readonly requests = new Map<
    string,
    {
      id: string;
      controller: AbortController;
      cancelOnRemoval: boolean;
    }
  >();
  private closed = false;
  private readonly operations = new Set<Promise<void>>();

  constructor(
    private readonly publish: (update: GitHubUpdate) => void,
    private readonly report: (error: unknown) => void,
    private readonly create = (repository: Repository) =>
      new GitHubRepository(repository.path),
  ) {}

  load(
    repository: Repository,
    section: GitHubSection,
    cursor?: string,
  ): Promise<void> {
    const base = {
      type: "github" as const,
      id: repository.id,
      section,
      append: Boolean(cursor),
    };
    return this.request(
      repository,
      JSON.stringify([repository.id, section]),
      (signal) => this.create(repository).load(section, cursor, signal),
      (update) =>
        this.publish({
          ...base,
          status: update.status,
          page: update.status === "ready" ? update.value : undefined,
          error: update.status === "error" ? update.error : undefined,
        }),
    );
  }

  loadDiscussion(
    repository: Repository,
    url: string,
    publish: (update: GitHubDiscussionUpdate) => void,
  ): Promise<void> {
    return this.request(
      repository,
      JSON.stringify([repository.id, "discussion"]),
      (signal) => this.create(repository).loadDiscussion(url, signal),
      (update) =>
        publish({
          type: "github-discussion",
          id: repository.id,
          url,
          status: update.status,
          discussion: update.status === "ready" ? update.value : undefined,
          error: update.status === "error" ? update.error : undefined,
        }),
    );
  }

  cancelDiscussion(id: string): void {
    const key = JSON.stringify([id, "discussion"]);
    this.requests.get(key)?.controller.abort();
    this.requests.delete(key);
  }

  postComment(
    repository: Repository,
    url: string,
    body: string,
    requestId: string,
    publish: (update: GitHubCommentUpdate) => void,
  ): Promise<void> {
    const base = {
      type: "github-comment" as const,
      id: repository.id,
      url,
      requestId,
    };
    const key = JSON.stringify([repository.id, "comment", url]);
    if (this.requests.has(key)) {
      const error = "A comment is already being published for this discussion.";
      this.report(new Error(error));
      publish({ ...base, status: "error", error });
      return Promise.resolve();
    }
    return this.request(
      repository,
      key,
      (signal) => this.create(repository).postComment(url, body, signal),
      (update) =>
        publish({
          ...base,
          status:
            update.status === "loading"
              ? "posting"
              : update.status === "ready"
                ? "posted"
                : "error",
          comment: update.status === "ready" ? update.value : undefined,
          error:
            update.status === "error"
              ? `${update.error} Publication could not be confirmed. Check GitHub before retrying; the comment may already have been created.`
              : undefined,
        }),
      false,
    );
  }

  private request<T>(
    repository: Repository,
    key: string,
    read: (signal: AbortSignal) => Promise<T>,
    publish: (result: LoadResult<T>) => void,
    cancelOnRemoval = true,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("The GitHub panel is closed."));
    }
    this.requests.get(key)?.controller.abort();
    const controller = new AbortController();
    const current = (): boolean =>
      !this.closed && this.requests.get(key)?.controller === controller;
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const value = await read(controller.signal);
        if (current()) publish({ status: "ready", value });
      } catch (error) {
        if (current() && !controller.signal.aborted) {
          this.report(error);
          publish({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (current()) this.requests.delete(key);
        this.operations.delete(promise);
      }
    });
    this.operations.add(promise);
    this.requests.set(key, { id: repository.id, controller, cancelOnRemoval });
    publish({ status: "loading" });
    return promise;
  }

  retain(ids: Set<string>): void {
    for (const [key, request] of this.requests) {
      if (request.cancelOnRemoval && !ids.has(request.id)) {
        request.controller.abort();
        this.requests.delete(key);
      }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const pending = [...this.requests.values()];
    for (const request of pending) request.controller.abort();
    await Promise.allSettled(this.operations);
    this.requests.clear();
  }
}
