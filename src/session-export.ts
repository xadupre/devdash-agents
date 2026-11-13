import {
  isGitHubDiscussionUrl,
  runCommand,
  type CommandRunner,
} from "./github";
import { isExternalUrl } from "./links";
import type { Repository } from "./repositories";
import type { SavedConversation } from "./storage";
import { machineRepositoryPath } from "./execution";
import { remoteCommandRunner } from "./remote";

export interface SessionExportSource {
  repository: Repository;
  conversation: SavedConversation;
}

interface PullRequest {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefOid: string;
  title?: string;
  body?: string;
  closingIssues?: string[];
}

const hashPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const pullRequestFields =
  "number,url,state,headRefName,headRefOid,baseRefOid,title,body,closingIssuesReferences";

export function findDiscussionReferences(
  conversation: SavedConversation,
): string[] {
  return [...new Set(findDiscussionMentions(conversation))];
}

function findDiscussionMentions(conversation: SavedConversation): string[] {
  const found: string[] = [];
  const pattern =
    /https?:\/\/[^\s<>"'`]+|(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*/g;
  const texts = conversation.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  if (conversation.context) texts.push(conversation.context);
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const reference = match[0].replace(/[),.;]+$/, "");
      if (reference.startsWith("http")) {
        if (!isGitHubDiscussionUrl(reference)) continue;
        const url = new URL(reference);
        url.search = "";
        url.hash = "";
        found.push(url.toString().replace(/\/$/, ""));
      } else {
        found.push(reference);
      }
    }
  }
  return found;
}

function parsePullRequest(output: string): PullRequest {
  const value: unknown = JSON.parse(output);
  if (
    !value ||
    typeof value !== "object" ||
    !("number" in value) ||
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !isExternalUrl(value.url) ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(value.state) ||
    !("headRefName" in value) ||
    typeof value.headRefName !== "string" ||
    !value.headRefName ||
    !("headRefOid" in value) ||
    typeof value.headRefOid !== "string" ||
    !hashPattern.test(value.headRefOid) ||
    !("baseRefOid" in value) ||
    typeof value.baseRefOid !== "string" ||
    !hashPattern.test(value.baseRefOid) ||
    ("title" in value && typeof value.title !== "string") ||
    ("body" in value && typeof value.body !== "string") ||
    ("closingIssuesReferences" in value &&
      (!Array.isArray(value.closingIssuesReferences) ||
        value.closingIssuesReferences.some(
          (issue: unknown) =>
            !issue ||
            typeof issue !== "object" ||
            !("url" in issue) ||
            !isGitHubDiscussionUrl(issue.url),
        )))
  ) {
    throw new Error("Invalid pull request metadata returned by gh.");
  }
  return {
    number: value.number,
    url: value.url,
    state: value.state,
    headRefName: value.headRefName,
    headRefOid: value.headRefOid,
    baseRefOid: value.baseRefOid,
    ...("title" in value && typeof value.title === "string"
      ? { title: value.title }
      : {}),
    ...("body" in value && typeof value.body === "string"
      ? { body: value.body }
      : {}),
    ...("closingIssuesReferences" in value &&
    Array.isArray(value.closingIssuesReferences)
      ? {
          closingIssues: value.closingIssuesReferences.map(
            (issue: { url: string }) => issue.url,
          ),
        }
      : {}),
  };
}

async function loadDiscussions(
  references: string[],
  cwd: string,
  signal: AbortSignal,
  run: CommandRunner,
  hasRemote: boolean,
): Promise<{
  discussions: {
    url: string;
    number: number;
    kind: string;
    title: string;
    state: string;
    body: string;
  }[];
  unresolved: { reference: string; reason: string }[];
}> {
  if (!references.length) return { discussions: [], unresolved: [] };
  let base: URL | undefined;
  if (
    hasRemote &&
    references.some(
      (reference) =>
        !reference.startsWith("http") ||
        new URL(reference).hostname.toLowerCase() !== "github.com",
    )
  ) {
    const repository: unknown = JSON.parse(
      await run("gh", ["repo", "view", "--json", "url"], cwd, signal),
    );
    if (
      !repository ||
      typeof repository !== "object" ||
      !("url" in repository) ||
      typeof repository.url !== "string" ||
      !isExternalUrl(repository.url)
    )
      throw new Error("Invalid GitHub repository metadata.");
    base = new URL(repository.url);
  }
  const targets = new Map<string, { url: URL; mentions: number }>();
  for (const reference of references) {
    let target: URL;
    if (reference.startsWith("http")) {
      target = new URL(reference);
    } else {
      const [name, number] = reference.split("#");
      target = new URL(base!.origin);
      target.pathname = `${name ? `/${name}` : base!.pathname.replace(/\/$/, "")}/issues/${number}`;
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      (target.hostname.toLowerCase() !== "github.com" &&
        target.origin !== base?.origin)
    )
      throw new Error(
        "Discussion references must use github.com or the configured GitHub repository host over HTTPS.",
      );
    const parts = target.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 4 ||
      !/^[\w.-]+$/.test(parts[0]!) ||
      !/^[\w.-]+$/.test(parts[1]!) ||
      !/^[1-9]\d*$/.test(parts[3]!) ||
      !Number.isSafeInteger(Number(parts[3]))
    )
      throw new Error("Invalid GitHub discussion reference.");
    const key = `${target.host.toLowerCase()}/${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}/${parts[3]}`;
    targets.set(key, {
      url: target,
      mentions: (targets.get(key)?.mentions ?? 0) + 1,
    });
  }
  const load = async (target: URL) => {
    const [owner, repo, , number] = target.pathname.split("/").filter(Boolean);
    let output: string;
    try {
      output = await run(
        "gh",
        [
          "api",
          "--hostname",
          target.hostname,
          `repos/${owner}/${repo}/issues/${number}`,
        ],
        cwd,
        signal,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("gh: ") ||
        !/\bHTTP 404\b/.test(error.message)
      )
        throw error;
      return {
        unresolved: {
          reference: target.toString(),
          reason: "GitHub returned HTTP 404.",
        },
      };
    }
    const value: unknown = JSON.parse(output);
    if (
      !value ||
      typeof value !== "object" ||
      !("html_url" in value) ||
      !isGitHubDiscussionUrl(value.html_url) ||
      !("number" in value) ||
      value.number !== Number(number) ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("state" in value) ||
      typeof value.state !== "string" ||
      !("body" in value) ||
      (typeof value.body !== "string" && value.body !== null)
    )
      throw new Error("Invalid GitHub issue or pull request metadata.");
    const actual = new URL(value.html_url);
    if (
      actual.host.toLowerCase() !== target.host.toLowerCase() ||
      Number(actual.pathname.split("/")[4]) !== Number(number) ||
      actual.pathname.split("/").slice(1, 3).join("/").toLowerCase() !==
        `${owner}/${repo}`.toLowerCase()
    )
      throw new Error("GitHub returned a different discussion.");
    return {
      discussion: {
        url: value.html_url,
        number: value.number,
        kind: "pull_request" in value ? "pull-request" : "issue",
        title: value.title,
        state: value.state,
        body: value.body ?? "",
      },
    };
  };
  const discussions = [];
  const unresolved = [];
  const rankedTargets = [...targets.values()];
  if (rankedTargets.length > 50) {
    rankedTargets.sort((a, b) => b.mentions - a.mentions);
    unresolved.push(
      ...rankedTargets.slice(50).map(({ url }) => ({
        reference: url.toString(),
        reason:
          "Omitted by the 50-lookup limit: the mention-frequency heuristic may omit relevant issues or PRs.",
      })),
    );
  }
  const uniqueTargets = rankedTargets.slice(0, 50).map(({ url }) => url);
  for (let index = 0; index < uniqueTargets.length; index += 4) {
    const results = await Promise.allSettled(
      uniqueTargets.slice(index, index + 4).map(load),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value.discussion) discussions.push(result.value.discussion);
      if (result.value.unresolved) unresolved.push(result.value.unresolved);
    }
  }
  return { discussions, unresolved };
}

export async function exportSessionJson(
  source: SessionExportSource,
  signal: AbortSignal,
  run?: CommandRunner,
  onWarning?: (message: string) => void,
): Promise<string> {
  signal.throwIfAborted();
  const machine = source.conversation.assignment?.executionMachine;
  const cwd = machine
    ? machineRepositoryPath(machine, source.repository.path)
    : source.repository.path;
  run ??= machine?.command ? remoteCommandRunner(machine) : runCommand;
  const [commitOutput, branchOutput, remotes] = await Promise.all([
    run("git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd, signal),
    run("git", ["branch", "--show-current"], cwd, signal),
    run("git", ["remote"], cwd, signal),
  ]);
  const commit = commitOutput.trim();
  const branch = branchOutput.trim();
  if (!hashPattern.test(commit)) {
    throw new Error("Git returned an invalid HEAD commit hash.");
  }

  let pullRequest: PullRequest | undefined;
  if (branch && remotes.trim()) {
    try {
      pullRequest = parsePullRequest(
        await run(
          "gh",
          ["pr", "view", "--json", pullRequestFields],
          cwd,
          signal,
        ),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("gh: no pull requests found for branch ")
      ) {
        throw error;
      }
    }
    if (pullRequest && pullRequest.headRefName !== branch) {
      throw new Error("GitHub returned a pull request for a different branch.");
    }
  }

  let diff: string;
  if (pullRequest) {
    diff = await run(
      "gh",
      ["pr", "diff", pullRequest.url, "--color", "never"],
      cwd,
      signal,
    );
    const latest = parsePullRequest(
      await run(
        "gh",
        ["pr", "view", pullRequest.url, "--json", pullRequestFields],
        cwd,
        signal,
      ),
    );
    if (
      latest.number !== pullRequest.number ||
      latest.url !== pullRequest.url ||
      latest.state !== pullRequest.state ||
      latest.headRefName !== pullRequest.headRefName ||
      latest.headRefOid !== pullRequest.headRefOid ||
      latest.baseRefOid !== pullRequest.baseRefOid ||
      latest.title !== pullRequest.title ||
      latest.body !== pullRequest.body ||
      JSON.stringify(latest.closingIssues) !==
        JSON.stringify(pullRequest.closingIssues)
    ) {
      throw new Error("The pull request changed during export. Try again.");
    }
  } else {
    diff = await run(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        commit,
        "--",
      ],
      cwd,
      signal,
    );
  }
  signal.throwIfAborted();
  const references = [
    ...findDiscussionMentions(source.conversation),
    ...(pullRequest?.closingIssues ?? []),
  ];
  const unresolvedReferences = remotes.trim()
    ? []
    : [...new Set(references)]
        .filter((reference) => !reference.startsWith("http"))
        .map((reference) => ({
          reference,
          reason: "No GitHub remote is configured.",
        }));
  const loaded = await loadDiscussions(
    remotes.trim()
      ? references
      : references.filter((reference) => reference.startsWith("http")),
    cwd,
    signal,
    run,
    Boolean(remotes.trim()),
  );
  unresolvedReferences.push(...loaded.unresolved);
  if (unresolvedReferences.length)
    onWarning?.(
      "Some GitHub references could not be resolved; see unresolvedReferences in the exported JSON.",
    );
  signal.throwIfAborted();
  return (
    JSON.stringify(
      {
        commit,
        version: 1,
        exportedAt: new Date().toISOString(),
        repository: source.repository,
        ...source.conversation,
        discussions: loaded.discussions,
        ...(unresolvedReferences.length ? { unresolvedReferences } : {}),
        diffSource: pullRequest
          ? { type: "pull-request", ...pullRequest }
          : { type: "working-tree", baseCommit: commit },
        diff,
      },
      null,
      2,
    ) + "\n"
  );
}
