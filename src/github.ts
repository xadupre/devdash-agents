import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { isExternalUrl } from "./links";
import {
  compareDiffText,
  isDiffPath,
  MAX_DIFF_BYTES,
  type DiffEntry,
  type DiffFile,
} from "./diff";
import type { SessionView } from "./application";

export type GitHubSection =
  "issues" | "reviews" | "oldest-prs" | "comments" | "commits" | "mentions";
export function isGitHubSection(value: unknown): value is GitHubSection {
  return [
    "issues",
    "reviews",
    "oldest-prs",
    "comments",
    "commits",
    "mentions",
  ].some((section) => section === value);
}

export interface GitHubComment {
  id: string;
  author: string;
  mine: boolean;
  body: string;
  date: string;
  url: string;
}
export interface GitHubItem {
  id: string;
  title: string;
  url?: string;
  author: string;
  date: string;
  mine: boolean;
  replied: boolean;
  afterMe: boolean;
  comments?: GitHubComment[];
}
export interface GitHubPage {
  repository: string;
  viewer?: string;
  items: GitHubItem[];
  cursor?: string;
  notice?: string;
}
export interface GitHubUpdate {
  type: "github";
  id: string;
  section: GitHubSection;
  status: "loading" | "ready" | "error";
  append: boolean;
  page?: GitHubPage;
  error?: string;
}

export interface GitHubDiscussion {
  title: string;
  url: string;
  kind: "Issue" | "PullRequest";
  state: string;
  author: string;
  date: string;
  body: string;
  comments: Omit<GitHubComment, "mine">[];
}
export interface GitHubDiscussionUpdate {
  type: "github-discussion";
  id: string;
  url: string;
  status: "loading" | "ready" | "error";
  discussion?: GitHubDiscussion;
  kind?: GitHubDiscussion["kind"];
  html?: string;
  error?: string;
}

export interface PullRequestDiffList {
  url: string;
  baseCommit: string;
  headCommit: string;
  files: DiffEntry[];
}

interface PullRequestDiffEntry extends DiffEntry {
  oid: string;
}

export interface PullRequestDiffSnapshot {
  list: PullRequestDiffList;
  target: { host: string; owner: string; name: string; number: number };
  entries: PullRequestDiffEntry[];
}

export interface PullRequestDiffUpdate {
  type: "pull-diff";
  id: string;
  view: SessionView;
  url: string;
  requestId: string;
  list?: PullRequestDiffList;
  file?: DiffFile;
  error?: string;
}

export const MAX_GITHUB_COMMENT_LENGTH = 65_536;
export interface GitHubCommentUpdate {
  type: "github-comment";
  id: string;
  url: string;
  requestId: string;
  status: "posting" | "posted" | "error";
  comment?: GitHubDiscussion["comments"][number];
  commentId?: string;
  html?: string;
  error?: string;
}

export function isGitHubCommentBody(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= MAX_GITHUB_COMMENT_LENGTH
  );
}

export function isGitHubDiscussionUrl(value: unknown): value is string {
  if (typeof value !== "string" || !isExternalUrl(value)) return false;
  const parsed = new URL(value);
  const match = parsed.pathname.match(
    /^\/[^/]+\/[^/]+\/(?:issues|pull)\/([1-9]\d*)\/?$/,
  );
  return Boolean(match && Number.isSafeInteger(Number(match[1])));
}

export function isGitHubPullRequestUrl(value: unknown): value is string {
  if (!isGitHubDiscussionUrl(value)) return false;
  const parsed = new URL(value);
  return (
    !parsed.username &&
    !parsed.password &&
    /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(parsed.pathname)
  );
}

export type CommandRunner = (
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<string>;

const execute = promisify(execFile);
export const runCommand: CommandRunner = async (file, args, cwd, signal) => {
  try {
    const { stdout } = await execute(file, args, {
      cwd,
      signal,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.trim()
    ) {
      throw new Error(`${file}: ${error.stderr.trim()}`, { cause: error });
    }
    throw error;
  }
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub response: expected an object.");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid GitHub response: expected text.");
  }
  return value;
}
function url(value: unknown): string {
  const result = text(value);
  if (!isExternalUrl(result)) {
    throw new Error("Invalid GitHub response: expected an HTTP/HTTPS URL.");
  }
  return result;
}
function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error("Invalid GitHub response: expected a timestamp.");
  }
  return result;
}
function author(value: unknown): string {
  return value === null ? "[deleted]" : text(record(value).login);
}
function discussionComment(
  value: unknown,
): GitHubDiscussion["comments"][number] {
  const comment = record(value);
  return {
    id: text(comment.id),
    author: author(comment.author),
    body: text(comment.body),
    date: date(comment.createdAt),
    url: url(comment.url),
  };
}
function connection(value: unknown, backwards = false) {
  const data = record(value);
  const info = record(data.pageInfo);
  const more = info[backwards ? "hasPreviousPage" : "hasNextPage"];
  const cursor = info[backwards ? "startCursor" : "endCursor"];
  if (
    !Array.isArray(data.nodes) ||
    typeof more !== "boolean" ||
    (more && (typeof cursor !== "string" || !cursor))
  ) {
    throw new Error("Invalid GitHub pagination response.");
  }
  return {
    nodes: data.nodes.map(record),
    cursor: more ? text(cursor) : undefined,
  };
}
const commentFields = "id author { login } body createdAt url";
const pageFields = "pageInfo { hasPreviousPage startCursor }";
const commentsField = `comments(last:50) { ${pageFields} nodes { ${commentFields} } }`;
const reviewFields = `id author { login } body submittedAt state url
  comments(last:20) { ${pageFields} nodes { ${commentFields} } }`;
const issueFields = `id number title url author { login } updatedAt ${commentsField}`;
const pullFields = `${issueFields}
  reviews(last:20) { ${pageFields} nodes { ${reviewFields} } }`;
const nextPageFields = "pageInfo { hasNextPage endCursor }";
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MAX_PULL_FILES = 3_000;

interface Identity {
  owner: string;
  name: string;
  host: string;
  viewer: string;
}
interface CommentCursor {
  commented?: string;
  reviewed?: string;
  commentedDone: boolean;
  reviewedDone: boolean;
}
function commentCursor(cursor?: string): CommentCursor {
  if (!cursor) {
    return { commentedDone: false, reviewedDone: false };
  }
  const value = record(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
  if (
    typeof value.commentedDone !== "boolean" ||
    typeof value.reviewedDone !== "boolean" ||
    (value.commented !== undefined && typeof value.commented !== "string") ||
    (value.reviewed !== undefined && typeof value.reviewed !== "string")
  ) {
    throw new Error("Invalid comments page cursor.");
  }
  return {
    commented: value.commented,
    reviewed: value.reviewed,
    commentedDone: value.commentedDone,
    reviewedDone: value.reviewedDone,
  };
}

function pullDiffRefs(value: unknown): {
  base: string;
  head: string;
  changedFiles: number;
} {
  const pull = record(value);
  const base = text(record(pull.base).sha);
  const head = text(record(pull.head).sha);
  const changedFiles = pull.changed_files;
  if (
    !hashPattern.test(base) ||
    !hashPattern.test(head) ||
    typeof changedFiles !== "number" ||
    !Number.isSafeInteger(changedFiles) ||
    changedFiles < 0
  )
    throw new Error("Invalid pull request diff metadata returned by GitHub.");
  return { base, head, changedFiles };
}

function pullDiffEntry(value: unknown): PullRequestDiffEntry {
  const file = record(value);
  const path = file.filename;
  const oid = text(file.sha);
  const status = text(file.status);
  const statuses: Record<string, DiffEntry["status"]> = {
    added: "A",
    removed: "D",
    modified: "M",
    renamed: "R",
    copied: "C",
    changed: "T",
    unchanged: "M",
  };
  const mapped = Object.hasOwn(statuses, status) ? statuses[status] : undefined;
  if (
    !mapped ||
    !isDiffPath(path) ||
    path.includes("\ufffd") ||
    !hashPattern.test(oid)
  )
    throw new Error("GitHub returned an unsupported pull request file.");
  if (mapped === "R" || mapped === "C") {
    if (
      !isDiffPath(file.previous_filename) ||
      file.previous_filename.includes("\ufffd")
    )
      throw new Error("GitHub returned an invalid previous file path.");
    return { path, status: mapped, oldPath: file.previous_filename, oid };
  }
  return { path, status: mapped, oid };
}

function publicPullDiffEntry(entry: PullRequestDiffEntry): DiffEntry {
  return {
    path: entry.path,
    status: entry.status,
    ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
  };
}

interface PullDiffBlob {
  oid: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

function pullDiffBlob(value: unknown): PullDiffBlob {
  const blob = record(value);
  if (blob.__typename !== "Blob")
    throw new Error(
      "The pull request file is not a Git blob; submodules cannot be displayed as text.",
    );
  const oid = text(blob.oid);
  const size = blob.byteSize;
  const binary = blob.isBinary;
  const truncated = blob.isTruncated;
  const content = blob.text;
  if (
    !hashPattern.test(oid) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof binary !== "boolean" ||
    typeof truncated !== "boolean" ||
    (content !== null && typeof content !== "string")
  )
    throw new Error("Invalid GitHub blob metadata.");
  return { oid, size, binary, truncated, content };
}

export class GitHubRepository {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = runCommand,
  ) {}

  private async discussionTarget(target: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isGitHubDiscussionUrl(target)) {
      throw new Error("Invalid GitHub issue or pull request URL.");
    }
    const repository = record(
      JSON.parse(
        await this.run(
          "gh",
          ["repo", "view", "--json", "nameWithOwner,url"],
          this.cwd,
          signal,
        ),
      ),
    );
    const repositoryUrl = new URL(url(repository.url));
    const targetUrl = new URL(target);
    const [owner, name, extra] = text(repository.nameWithOwner).split("/");
    if (
      !owner ||
      !name ||
      extra ||
      repositoryUrl.origin !== targetUrl.origin ||
      targetUrl.pathname.split("/").slice(1, 3).join("/").toLowerCase() !==
        `${owner}/${name}`.toLowerCase()
    ) {
      throw new Error(
        "The discussion must belong to the selected GitHub repository.",
      );
    }
    return {
      host: repositoryUrl.hostname,
      owner,
      name,
      number: Number(targetUrl.pathname.split("/")[4]),
    };
  }

  private pullDiffApi(
    target: PullRequestDiffSnapshot["target"],
    endpoint: string,
    signal: AbortSignal,
    args: string[] = [],
  ): Promise<string> {
    return this.run(
      "gh",
      [
        "api",
        "--hostname",
        target.host,
        `repos/${target.owner}/${target.name}/${endpoint}`,
        ...args,
      ],
      this.cwd,
      signal,
    );
  }

  async loadPullRequestDiff(
    url: string,
    signal: AbortSignal,
  ): Promise<PullRequestDiffSnapshot> {
    if (!isGitHubPullRequestUrl(url))
      throw new Error("Invalid GitHub pull request URL.");
    const target = await this.discussionTarget(url, signal);
    const refs = pullDiffRefs(
      JSON.parse(
        await this.pullDiffApi(target, `pulls/${target.number}`, signal),
      ),
    );
    if (refs.changedFiles > MAX_PULL_FILES)
      throw new Error(
        `The pull request contains more than ${MAX_PULL_FILES} changed files; GitHub does not provide a complete file list.`,
      );
    const baseCommit = (
      await this.pullDiffApi(
        target,
        `compare/${refs.base}...${refs.head}?per_page=1`,
        signal,
        ["--jq", ".merge_base_commit.sha"],
      )
    ).trim();
    if (!hashPattern.test(baseCommit))
      throw new Error("GitHub returned an invalid pull request merge base.");
    const entries: PullRequestDiffEntry[] = [];
    for (let page = 1; entries.length < refs.changedFiles; page++) {
      const response: unknown = JSON.parse(
        await this.pullDiffApi(
          target,
          `pulls/${target.number}/files?per_page=100&page=${page}`,
          signal,
          ["--jq", "map({filename, status, previous_filename, sha})"],
        ),
      );
      if (!Array.isArray(response) || !response.length || response.length > 100)
        throw new Error(
          "GitHub returned an incomplete pull request file list.",
        );
      entries.push(...response.map(pullDiffEntry));
      if (entries.length > refs.changedFiles)
        throw new Error(
          "The pull request changed while loading its diff. Refresh and try again.",
        );
    }
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
      throw new Error("GitHub returned duplicate pull request file paths.");
    const latest = pullDiffRefs(
      JSON.parse(
        await this.pullDiffApi(target, `pulls/${target.number}`, signal),
      ),
    );
    if (
      latest.base !== refs.base ||
      latest.head !== refs.head ||
      latest.changedFiles !== refs.changedFiles
    )
      throw new Error(
        "The pull request changed while loading its diff. Refresh and try again.",
      );
    signal.throwIfAborted();
    return {
      target,
      entries,
      list: {
        url,
        baseCommit,
        headCommit: refs.head,
        files: entries.map(publicPullDiffEntry),
      },
    };
  }

  async loadPullRequestDiffFile(
    snapshot: PullRequestDiffSnapshot,
    path: string,
    signal: AbortSignal,
  ): Promise<DiffFile> {
    if (!isDiffPath(path)) throw new Error("Invalid pull request file path.");
    const entry = snapshot.entries.find((file) => file.path === path);
    if (!entry)
      throw new Error(
        "The file is not in this pull request diff. Refresh and try again.",
      );
    const { target, list } = snapshot;
    const data = await this.graphql(
      target,
      `query($owner:String!,$name:String!,$old:String!,$new:String!,$readOld:Boolean!,$readNew:Boolean!) {
        repository(owner:$owner,name:$name) {
          old:object(expression:$old) @include(if:$readOld) {
            __typename ... on Blob { oid byteSize isBinary isTruncated text }
          }
          new:object(expression:$new) @include(if:$readNew) {
            __typename ... on Blob { oid byteSize isBinary isTruncated text }
          }
        }
      }`,
      {
        owner: target.owner,
        name: target.name,
        old: `${list.baseCommit}:${entry.oldPath ?? entry.path}`,
        new: `${list.headCommit}:${entry.path}`,
        readOld: entry.status !== "A",
        readNew: entry.status !== "D",
      },
      signal,
    );
    const repository = record(data.repository);
    const oldBlob =
      entry.status === "A" ? undefined : pullDiffBlob(repository.old);
    const newBlob =
      entry.status === "D" ? undefined : pullDiffBlob(repository.new);
    if (newBlob && newBlob.oid.toLowerCase() !== entry.oid.toLowerCase())
      throw new Error(
        "The pull request file does not match the loaded snapshot. Refresh and try again.",
      );
    const file = publicPullDiffEntry(entry);
    if (oldBlob?.binary || newBlob?.binary)
      return {
        ...file,
        oldLines: [],
        newLines: [],
        changes: [],
        binary: true,
        oldNoFinalNewline: false,
        newNoFinalNewline: false,
      };
    const readBlob = async (
      blob: PullDiffBlob | undefined,
    ): Promise<string> => {
      if (!blob) return "";
      if (blob.size > MAX_DIFF_BYTES)
        throw new Error(
          "The changed file is too large to display in the diff viewer.",
        );
      const content = blob.truncated
        ? await this.pullDiffApi(target, `git/blobs/${blob.oid}`, signal, [
            "--header",
            "Accept: application/vnd.github.raw+json",
          ])
        : blob.content;
      if (
        typeof content !== "string" ||
        Buffer.byteLength(content, "utf8") !== blob.size
      )
        throw new Error(
          "GitHub returned incomplete or unsupported UTF-8 file content.",
        );
      const actual = createHash(blob.oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${blob.size}\0`)
        .update(content, "utf8")
        .digest("hex");
      if (actual !== blob.oid.toLowerCase())
        throw new Error(
          "GitHub returned incomplete or unsupported UTF-8 file content.",
        );
      return content;
    };
    const [oldText, newText] = await Promise.all([
      readBlob(oldBlob),
      readBlob(newBlob),
    ]);
    return compareDiffText(file, oldText, newText, signal);
  }

  async postComment(
    target: string,
    body: string,
    signal: AbortSignal,
  ): Promise<GitHubDiscussion["comments"][number]> {
    if (!isGitHubCommentBody(body)) {
      throw new Error(
        `A GitHub comment must contain 1 to ${MAX_GITHUB_COMMENT_LENGTH} characters of non-empty text.`,
      );
    }
    const { host, owner, name, number } = await this.discussionTarget(
      target,
      signal,
    );
    const directory = await mkdtemp(join(tmpdir(), "devdash-github-comment-"));
    try {
      const input = join(directory, "comment.json");
      await writeFile(input, JSON.stringify({ body }), { mode: 0o600 });
      signal.throwIfAborted();
      const response = record(
        JSON.parse(
          await this.run(
            "gh",
            [
              "api",
              "--hostname",
              host,
              "--method",
              "POST",
              `repos/${owner}/${name}/issues/${number}/comments`,
              "--input",
              input,
            ],
            this.cwd,
            signal,
          ),
        ),
      );
      return discussionComment({
        id: response.node_id,
        author: response.user,
        body: response.body,
        createdAt: response.created_at,
        url: response.html_url,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async loadDiscussion(
    target: string,
    callerSignal: AbortSignal,
  ): Promise<GitHubDiscussion> {
    if (!isGitHubDiscussionUrl(target)) {
      throw new Error("Invalid GitHub issue or pull request URL.");
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      callerSignal,
      lifetime.signal,
      AbortSignal.timeout(120_000),
    ]);
    try {
      const { host, owner, name, number } = await this.discussionTarget(
        target,
        signal,
      );
      const identity = { host };
      const data = await this.graphql(
        identity,
        `query($owner:String!,$name:String!,$number:Int!) {
        repository(owner:$owner,name:$name) {
          issueOrPullRequest(number:$number) {
            __typename
            ... on Issue {
              id number title url state body createdAt author { login } ${commentsField}
            }
            ... on PullRequest {
              id number title url state body createdAt author { login } ${commentsField}
            }
          }
        }
      }`,
        { owner, name, number },
        signal,
      );
      const node = record(record(data.repository).issueOrPullRequest);
      if (node.__typename !== "Issue" && node.__typename !== "PullRequest") {
        throw new Error("Invalid GitHub discussion type.");
      }
      if (typeof node.number !== "number") {
        throw new Error("Invalid GitHub issue/PR number.");
      }
      const comments = await this.history(
        node.comments,
        text(node.id),
        node.__typename,
        "comments",
        commentFields,
        identity,
        signal,
      );
      return {
        title: `#${node.number} ${text(node.title)}`,
        url: url(node.url),
        kind: node.__typename,
        state: text(node.state),
        author: author(node.author),
        date: date(node.createdAt),
        body: text(node.body),
        comments: comments
          .map(discussionComment)
          .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
      };
    } finally {
      lifetime.abort();
    }
  }

  async load(
    section: GitHubSection,
    cursor: string | undefined,
    callerSignal: AbortSignal,
  ): Promise<GitHubPage> {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      callerSignal,
      lifetime.signal,
      AbortSignal.timeout(120_000),
    ]);
    try {
      return await this.read(section, cursor, signal);
    } finally {
      lifetime.abort();
    }
  }

  private async read(
    section: GitHubSection,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<GitHubPage> {
    signal.throwIfAborted();
    if (section === "commits") {
      return this.commits(signal);
    }
    const repository = record(
      JSON.parse(
        await this.run(
          "gh",
          ["repo", "view", "--json", "nameWithOwner,url"],
          this.cwd,
          signal,
        ),
      ),
    );
    const nameWithOwner = text(repository.nameWithOwner);
    const [owner, name, extra] = nameWithOwner.split("/");
    if (!owner || !name || extra) {
      throw new Error("Invalid GitHub repository identity.");
    }
    const host = new URL(url(repository.url)).hostname;
    const user = record(
      JSON.parse(
        await this.run(
          "gh",
          ["api", "--hostname", host, "user"],
          this.cwd,
          signal,
        ),
      ),
    );
    const identity = { owner, name, host, viewer: text(user.login) };
    if (section === "oldest-prs") {
      const data = await this.graphql(
        identity,
        `query($owner:String!,$name:String!) {
          repository(owner:$owner,name:$name) {
            pullRequests(first:10,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
              ${nextPageFields}
              nodes { id number title url author { login } createdAt }
            }
          }
        }`,
        { owner, name },
        signal,
      );
      const page = connection(record(data.repository).pullRequests);
      return {
        repository: nameWithOwner,
        viewer: identity.viewer,
        items: page.nodes
          .map((node) => {
            if (typeof node.number !== "number") {
              throw new Error("Invalid GitHub issue/PR number.");
            }
            const login = author(node.author);
            return {
              id: text(node.id),
              title: `#${node.number} ${text(node.title)}`,
              url: url(node.url),
              author: login,
              date: date(node.createdAt),
              mine: login.toLowerCase() === identity.viewer.toLowerCase(),
              replied: false,
              afterMe: false,
            };
          })
          .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
        notice:
          "The 10 oldest open pull requests, by creation date (oldest first). Participation history is not loaded.",
      };
    }
    const variables: Record<string, string | boolean> = { owner, name };
    if (section === "comments") {
      const current = commentCursor(cursor);
      Object.assign(variables, {
        commentedQuery: `repo:${nameWithOwner} commenter:${identity.viewer} sort:updated-desc`,
        reviewedQuery: `repo:${nameWithOwner} is:pr reviewed-by:${identity.viewer} sort:updated-desc`,
        loadCommented: !current.commentedDone,
        loadReviewed: !current.reviewedDone,
      });
      if (current.commented) variables.commented = current.commented;
      if (current.reviewed) variables.reviewed = current.reviewed;
      const data = await this.graphql(
        identity,
        `query(
        $commentedQuery:String!, $reviewedQuery:String!,
        $commented:String, $reviewed:String, $loadCommented:Boolean!, $loadReviewed:Boolean!
      ) {
        commented:search(query:$commentedQuery,type:ISSUE,first:10,after:$commented)
          @include(if:$loadCommented) { ${nextPageFields} nodes {
            ... on Issue { ${issueFields} }
            ... on PullRequest { ${pullFields} }
          } }
        reviewed:search(query:$reviewedQuery,type:ISSUE,first:10,after:$reviewed)
          @include(if:$loadReviewed) { ${nextPageFields} nodes {
            ... on PullRequest { ${pullFields} }
          } }
      }`,
        variables,
        signal,
      );
      const commented = current.commentedDone
        ? undefined
        : connection(data.commented);
      const reviewed = current.reviewedDone
        ? undefined
        : connection(data.reviewed);
      const next: CommentCursor = {
        commented: commented?.cursor,
        reviewed: reviewed?.cursor,
        commentedDone: !commented?.cursor,
        reviewedDone: !reviewed?.cursor,
      };
      const nodes = [
        ...new Map(
          [...(commented?.nodes ?? []), ...(reviewed?.nodes ?? [])].map(
            (node) => [text(node.id), node],
          ),
        ).values(),
      ];
      return {
        repository: nameWithOwner,
        viewer: identity.viewer,
        items: (await this.items(nodes, identity, signal, true)).filter(
          (item) => item.replied,
        ),
        cursor:
          next.commentedDone && next.reviewedDone
            ? undefined
            : Buffer.from(JSON.stringify(next)).toString("base64url"),
        notice:
          "Your comments and submitted reviews, plus comments posted after your latest response in each issue or PR. Includes closed discussions.",
      };
    }
    if (cursor) variables.cursor = cursor;
    if (section === "mentions") {
      variables.searchQuery = `repo:${nameWithOwner} mentions:${identity.viewer} sort:updated-desc`;
      const data = await this.graphql(
        identity,
        `query($searchQuery:String!,$cursor:String) {
          search(query:$searchQuery,type:ISSUE,first:20,after:$cursor) {
            ${nextPageFields} nodes {
              ... on Issue { ${issueFields} body createdAt }
              ... on PullRequest { ${pullFields} body createdAt }
            }
          }
        }`,
        variables,
        signal,
      );
      const page = connection(data.search);
      return {
        repository: nameWithOwner,
        viewer: identity.viewer,
        items: (
          await this.items(page.nodes, identity, signal, true, true)
        ).filter((item) => item.comments?.length),
        cursor: page.cursor,
        notice:
          "Direct @mentions with no later comment or submitted review from you in the discussion. Includes closed issues and PRs; team mentions are excluded. Search indexing may delay results.",
      };
    }
    const field = section === "issues" ? "issues" : "pullRequests";
    const fields = section === "issues" ? issueFields : pullFields;
    const data = await this.graphql(
      identity,
      `query($owner:String!,$name:String!,$cursor:String) {
      repository(owner:$owner,name:$name) {
        ${field}(first:20,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) {
          ${nextPageFields} nodes { ${fields} }
        }
      }
    }`,
      variables,
      signal,
    );
    const page = connection(record(data.repository)[field]);
    return {
      repository: nameWithOwner,
      viewer: identity.viewer,
      items: await this.items(page.nodes, identity, signal, false),
      cursor: page.cursor,
      notice: "Open discussions, most recently updated first.",
    };
  }

  private async graphql(
    identity: Pick<Identity, "host">,
    query: string,
    variables: Record<string, string | boolean | number>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const args = [
      "api",
      "--hostname",
      identity.host,
      "graphql",
      "-f",
      `query=${query}`,
    ];
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
    }
    const response = record(
      JSON.parse(await this.run("gh", args, this.cwd, signal)),
    );
    if (response.errors !== undefined) {
      throw new Error(
        `GitHub GraphQL error: ${JSON.stringify(response.errors)}`,
      );
    }
    return record(response.data);
  }

  private async history(
    initial: unknown,
    nodeId: string,
    nodeType: string,
    field: string,
    fields: string,
    identity: Pick<Identity, "host">,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    let page = connection(initial, true);
    const nodes = [...page.nodes];
    const seen = new Set<string>();
    while (page.cursor) {
      signal.throwIfAborted();
      if (seen.has(page.cursor)) {
        throw new Error("GitHub returned a repeated history cursor.");
      }
      seen.add(page.cursor);
      const data = await this.graphql(
        identity,
        `query($id:ID!,$before:String!) {
        node(id:$id) { ... on ${nodeType} {
          ${field}(last:50,before:$before) { ${pageFields} nodes { ${fields} } }
        } }
      }`,
        { id: nodeId, before: page.cursor },
        signal,
      );
      page = connection(record(data.node)[field], true);
      nodes.push(...page.nodes);
    }
    return nodes;
  }

  private async items(
    nodes: Record<string, unknown>[],
    identity: Identity,
    signal: AbortSignal,
    includeComments: boolean,
    pendingMentions = false,
  ): Promise<GitHubItem[]> {
    const result: GitHubItem[] = [];
    for (let offset = 0; offset < nodes.length; offset += 4) {
      result.push(
        ...(await Promise.all(
          nodes.slice(offset, offset + 4).map(async (node) => {
            const id = text(node.id);
            const isPull = node.reviews !== undefined;
            const comments = await this.history(
              node.comments,
              id,
              isPull ? "PullRequest" : "Issue",
              "comments",
              commentFields,
              identity,
              signal,
            );
            if (isPull) {
              const reviews = await this.history(
                node.reviews,
                id,
                "PullRequest",
                "reviews",
                reviewFields,
                identity,
                signal,
              );
              for (const review of reviews) {
                if (review.submittedAt === null) continue;
                comments.push({
                  ...review,
                  createdAt: review.submittedAt,
                  body: text(review.body) || `Review: ${text(review.state)}`,
                });
                comments.push(
                  ...(await this.history(
                    review.comments,
                    text(review.id),
                    "PullRequestReview",
                    "comments",
                    commentFields,
                    identity,
                    signal,
                  )),
                );
              }
            }
            const events: GitHubComment[] = [
              ...new Map(
                comments.map((comment) => {
                  const login = author(comment.author);
                  const event = {
                    id: text(comment.id),
                    author: login,
                    mine: login.toLowerCase() === identity.viewer.toLowerCase(),
                    body: text(comment.body),
                    date: date(comment.createdAt),
                    url: url(comment.url),
                  };
                  return [event.id, event] as const;
                }),
              ).values(),
            ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
            const own = events.filter((event) => event.mine);
            const last = own[0];
            const after = (event: GitHubComment): boolean =>
              Boolean(
                last &&
                !event.mine &&
                Date.parse(event.date) > Date.parse(last.date),
              );
            const mine =
              author(node.author).toLowerCase() ===
              identity.viewer.toLowerCase();
            let displayed = events.filter(
              (event) => event.mine || after(event),
            );
            if (pendingMentions) {
              const candidates = [...events];
              if (!mine) {
                candidates.push({
                  id,
                  author: author(node.author),
                  mine: false,
                  body: text(node.body),
                  date: date(node.createdAt),
                  url: url(node.url),
                });
              }
              displayed = candidates
                .filter(
                  (event) =>
                    !event.mine &&
                    (!last || Date.parse(event.date) > Date.parse(last.date)) &&
                    [
                      ...event.body.matchAll(
                        /(?:^|[^\w@/])@([a-z\d](?:[a-z\d-]*[a-z\d])?)(?![\w/-])/gi,
                      ),
                    ].some(
                      (match) =>
                        match[1]!.toLowerCase() ===
                        identity.viewer.toLowerCase(),
                    ),
                )
                .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
            }
            if (typeof node.number !== "number") {
              throw new Error("Invalid GitHub issue/PR number.");
            }
            return {
              id,
              title: `#${node.number} ${text(node.title)}`,
              url: url(node.url),
              author: author(node.author),
              date:
                includeComments && displayed[0]
                  ? displayed[0].date
                  : date(node.updatedAt),
              mine,
              replied: own.length > 0,
              afterMe: events.some(after),
              comments: includeComments ? displayed : undefined,
            };
          }),
        )),
      );
    }
    return result.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  }

  private async commits(signal: AbortSignal): Promise<GitHubPage> {
    const [log, remotes] = await Promise.all([
      this.run(
        "git",
        ["log", "-n", "30", "--format=%H%x00%an%x00%aI%x00%s%x00"],
        this.cwd,
        signal,
      ),
      this.run("git", ["remote", "-v"], this.cwd, signal),
    ]);
    const fetches = remotes
      .split(/\r?\n/)
      .filter((line) => line.endsWith("(fetch)"));
    const remote = (
      fetches.find((line) => line.startsWith("origin\t")) ?? fetches[0]
    )?.split(/\s+/)[1];
    let github: string | undefined;
    if (remote) {
      const normalized = remote.replace(/^git@([^:]+):/, "https://$1/");
      const parsed = URL.canParse(normalized) ? new URL(normalized) : undefined;
      if (parsed) {
        const path = parsed.pathname
          .replace(/\.git\/?$/, "")
          .replace(/\/$/, "");
        if (
          ["github.com", process.env.GH_HOST].includes(parsed.hostname) &&
          /^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(path)
        ) {
          github = `https://${parsed.hostname}${path}`;
        }
      }
    }
    const fields = log.split("\0");
    const items: GitHubItem[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const hash = fields[index]!.trim();
      if (!/^[a-f0-9]{40,64}$/.test(hash)) {
        throw new Error("Invalid Git commit hash.");
      }
      items.push({
        id: hash,
        title: `${hash.slice(0, 8)} ${fields[index + 3]!}`,
        author: fields[index + 1]!,
        date: date(fields[index + 2]),
        url: github ? `${github}/commit/${hash}` : undefined,
        mine: false,
        replied: false,
        afterMe: false,
      });
    }
    return {
      repository: github
        ? new URL(github).pathname.slice(1)
        : basename(this.cwd),
      items: items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
      notice: `Latest 30 commits on the current local branch.${github ? "" : " No GitHub remote detected; commit links are unavailable."}`,
    };
  }
}
