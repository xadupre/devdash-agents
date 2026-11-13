import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runCommand, type CommandRunner } from "../src/github";
import {
  exportSessionJson,
  findDiscussionReferences,
  type SessionExportSource,
} from "../src/session-export";
import { testImage } from "./helpers";

async function setup(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "devdash-agents-export-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => runCommand("git", args, cwd, signal);
  await git(["init", "--quiet"]);
  await writeFile(join(cwd, "tracked.txt"), "before\n");
  await git(["add", "tracked.txt"]);
  await git([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const branch = (await git(["branch", "--show-current"])).trim();
  const source: SessionExportSource = {
    repository: { id: cwd, name: "example", path: cwd },
    conversation: {
      sessionId: "session-123",
      generatedTokens: 42,
      draft: "Unsent draft",
      messages: [
        { role: "user", content: "Change the file", images: [testImage] },
        { role: "system", title: "event", content: '{"technical":true}' },
        { role: "tool", content: "Edit tracked.txt", details: "tool metadata" },
      ],
    },
  };
  return { cwd, signal, git, commit, branch, source };
}

test("session export starts with the commit, preserves all records and ends with the tracked working-tree diff", async (t) => {
  const { cwd, signal, git, commit, source } = await setup(t);
  await writeFile(join(cwd, "tracked.txt"), "before\nstaged\n");
  await git(["add", "tracked.txt"]);
  await writeFile(join(cwd, "tracked.txt"), "before\nstaged\nunstaged\n");
  await writeFile(join(cwd, "untracked.txt"), "not included\n");
  source.conversation.messages.push(
    ...Array.from({ length: 3_841 }, (_, index) => ({
      role: "system" as const,
      content: `Event ${index}: ${"x".repeat(1_000)}`,
    })),
  );
  const calls: string[] = [];
  const run: CommandRunner = (file, args, directory, requestSignal) => {
    calls.push(`${file} ${args[0]}`);
    return runCommand(file, args, directory, requestSignal);
  };
  const json = await exportSessionJson(source, signal, run);
  const result = JSON.parse(json);
  assert.match(json, new RegExp(`^\\{\\n  "commit": "${commit}"`));
  assert.equal(Object.keys(result).at(-1), "diff");
  assert.equal(result.commit, commit);
  assert.equal(result.sessionId, "session-123");
  assert.equal(result.draft, "Unsent draft");
  assert.equal(result.messages.length, 3_844);
  assert.deepEqual(result.messages, source.conversation.messages);
  assert.deepEqual(result.diffSource, {
    type: "working-tree",
    baseCommit: commit,
  });
  assert.match(result.diff, /\+staged\n/);
  assert.match(result.diff, /\+unstaged\n/);
  assert.doesNotMatch(result.diff, /untracked\.txt/);
  assert.equal(calls.filter((call) => call.startsWith("git ")).length, 4);
  assert.equal(
    calls.some((call) => call.startsWith("gh ")),
    false,
  );
});

test("a submitted PR exports the GitHub diff and identifies its head even when local HEAD differs", async (t) => {
  const { signal, git, commit, branch, source } = await setup(t);
  await git(["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  const pr = {
    number: 12,
    url: "https://github.com/acme/repo/pull/12",
    state: "OPEN",
    headRefName: branch,
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
  };
  const patch = "diff --git a/example b/example\n+submitted change\n";
  const requests: string[][] = [];
  const run: CommandRunner = async (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    requests.push(args);
    if (args[1] === "view") return JSON.stringify(pr);
    if (args[1] === "diff") return patch;
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const json = await exportSessionJson(source, signal, run);
  const result = JSON.parse(json);
  assert.equal(Object.keys(result)[0], "commit");
  assert.equal(Object.keys(result).at(-1), "diff");
  assert.equal(result.commit, commit);
  assert.deepEqual(result.diffSource, { type: "pull-request", ...pr });
  assert.equal(result.diff, patch);
  assert.deepEqual(
    requests.map((args) => args[1]),
    ["view", "diff", "view"],
  );
  assert.equal(requests[1]?.[2], pr.url);
});

test("a branch without a PR uses its working-tree diff, but GitHub failures and changing PRs fail explicitly", async (t) => {
  const { cwd, signal, git, branch, source } = await setup(t);
  await git(["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  await writeFile(join(cwd, "tracked.txt"), "local change\n");
  const withoutPr: CommandRunner = (file, args, directory, requestSignal) => {
    if (file === "gh")
      throw new Error(`gh: no pull requests found for branch "${branch}"`);
    return runCommand(file, args, directory, requestSignal);
  };
  const local = JSON.parse(await exportSessionJson(source, signal, withoutPr));
  assert.equal(local.diffSource.type, "working-tree");
  assert.match(local.diff, /\+local change/);

  const failed: CommandRunner = (file, args, directory, requestSignal) => {
    if (file === "gh") throw new Error("gh: HTTP 403: access denied");
    return runCommand(file, args, directory, requestSignal);
  };
  await assert.rejects(exportSessionJson(source, signal, failed), /HTTP 403/);

  const failedDiff: CommandRunner = (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    if (args[1] === "diff") throw new Error("gh: diff unavailable");
    return Promise.resolve(
      JSON.stringify({
        number: 12,
        url: "https://github.com/acme/repo/pull/12",
        state: "OPEN",
        headRefName: branch,
        headRefOid: "a".repeat(40),
        baseRefOid: "b".repeat(40),
      }),
    );
  };
  await assert.rejects(
    exportSessionJson(source, signal, failedDiff),
    /diff unavailable/,
  );

  let views = 0;
  const changed: CommandRunner = (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    if (args[1] === "diff") return Promise.resolve("diff");
    return Promise.resolve(
      JSON.stringify({
        number: 12,
        url: "https://github.com/acme/repo/pull/12",
        state: "OPEN",
        headRefName: branch,
        headRefOid: (++views === 1 ? "a" : "c").repeat(40),
        baseRefOid: "b".repeat(40),
      }),
    );
  };
  await assert.rejects(
    exportSessionJson(source, signal, changed),
    /pull request changed during export/i,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    exportSessionJson(source, cancelled.signal, () => {
      throw new Error("A cancelled export must not run a command.");
    }),
    { name: "AbortError" },
  );
});

test("export includes annotations, models and automatically resolved issue and PR context", async (t) => {
  const { signal, git, branch, source } = await setup(t);
  await git(["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  source.conversation.models = ["model-one", "model-two"];
  source.conversation.annotation = {
    mark: "failure",
    reason: "Tests failed",
    comments: "Needs investigation",
  };
  source.conversation.messages.push({
    role: "user",
    content:
      "Implement #84 and acme/repo#99; see https://github.com/acme/repo/issues/84.",
  });

  const pr = {
    number: 12,
    url: "https://github.com/acme/repo/pull/12",
    state: "OPEN",
    headRefName: branch,
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
    title: "Implement feature",
    body: "Closes #84",
    closingIssuesReferences: [
      { url: "https://github.com/acme/repo/issues/84" },
    ],
  };
  const apiCalls: string[] = [];
  const run: CommandRunner = async (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    if (args[0] === "repo")
      return JSON.stringify({ url: "https://github.com/acme/repo" });
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pr);
    if (args[0] === "pr" && args[1] === "diff") return "submitted diff";
    if (args[0] === "api") {
      apiCalls.push(args[3]!);
      const number = Number(args[3]!.split("/").at(-1));
      return JSON.stringify({
        html_url: `https://github.com/acme/repo/${number === 99 ? "pull" : "issues"}/${number}`,
        number,
        title: number === 99 ? "Related PR" : "Requested issue",
        body: "Description",
        state: "open",
        ...(number === 99 ? { pull_request: {} } : {}),
      });
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const result = JSON.parse(await exportSessionJson(source, signal, run));
  assert.deepEqual(result.models, ["model-one", "model-two"]);
  assert.deepEqual(result.annotation, source.conversation.annotation);
  assert.equal(result.diffSource.title, pr.title);
  assert.equal(result.diffSource.body, pr.body);
  assert.deepEqual(
    result.discussions.map((entry: { number: number; kind: string }) => [
      entry.number,
      entry.kind,
    ]),
    [
      [84, "issue"],
      [99, "pull-request"],
    ],
  );
  assert.deepEqual(apiCalls, [
    "repos/acme/repo/issues/84",
    "repos/acme/repo/issues/99",
  ]);
  let warning = "";
  const missing: CommandRunner = (file, args, directory, requestSignal) => {
    if (file === "gh" && args[0] === "api" && args[3]?.endsWith("/99"))
      throw new Error("gh: Not Found (HTTP 404)");
    return run(file, args, directory, requestSignal);
  };
  const partial = JSON.parse(
    await exportSessionJson(source, signal, missing, (message) => {
      warning = message;
    }),
  );
  assert.equal(partial.discussions.length, 1);
  assert.match(partial.unresolvedReferences[0].reason, /404/);
  assert.match(warning, /could not be resolved/);
  const failed: CommandRunner = (file, args, directory, requestSignal) => {
    if (file === "gh" && args[0] === "api")
      throw new Error("gh: access denied");
    return run(file, args, directory, requestSignal);
  };
  await assert.rejects(
    exportSessionJson(source, signal, failed),
    /access denied/,
  );
});

test("a local repository exports unresolved shorthand references with a warning", async (t) => {
  const { signal, source } = await setup(t);
  source.conversation.messages.push({ role: "user", content: "See #84 #84" });
  assert.deepEqual(findDiscussionReferences(source.conversation), ["#84"]);
  let warning = "";
  const json = await exportSessionJson(source, signal, undefined, (message) => {
    warning = message;
  });
  const result = JSON.parse(json);
  assert.deepEqual(result.unresolvedReferences, [
    { reference: "#84", reason: "No GitHub remote is configured." },
  ]);
  assert.match(warning, /could not be resolved/i);
});

test("the discussion limit applies to distinct normalized targets", async (t) => {
  const { signal, git, branch, source } = await setup(t);
  await git(["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  const urls = Array.from(
    { length: 50 },
    (_, index) => `https://github.com/acme/repo/issues/${index + 1}`,
  );
  source.conversation.messages.push({
    role: "user",
    content: `${urls.join(" ")} #1 ACME/REPO#2`,
  });
  const pr = {
    number: 100,
    url: "https://github.com/acme/repo/pull/100",
    state: "OPEN",
    headRefName: branch,
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
    closingIssuesReferences: [{ url: urls[0] }],
  };
  const apiCalls: string[] = [];
  const run: CommandRunner = async (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    if (args[0] === "repo")
      return JSON.stringify({ url: "https://github.com/acme/repo" });
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pr);
    if (args[0] === "pr" && args[1] === "diff") return "submitted diff";
    if (args[0] === "api") {
      apiCalls.push(args[3]!);
      const number = Number(args[3]!.split("/").at(-1));
      return JSON.stringify({
        html_url: `https://github.com/acme/repo/issues/${number}`,
        number,
        title: `Issue ${number}`,
        state: "open",
        body: "",
      });
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const result = JSON.parse(await exportSessionJson(source, signal, run));
  assert.equal(result.discussions.length, 50);
  assert.equal(apiCalls.length, 50);
  assert.equal(new Set(apiCalls.map((call) => call.toLowerCase())).size, 50);

  apiCalls.length = 0;
  source.conversation.messages.push({ role: "user", content: "See #51" });
  let warning = "";
  const limited = JSON.parse(
    await exportSessionJson(source, signal, run, (message) => {
      warning = message;
    }),
  );
  assert.equal(apiCalls.length, 50);
  assert.equal(limited.discussions.length, 50);
  assert.equal(limited.unresolvedReferences.length, 1);
  assert.equal(
    limited.unresolvedReferences[0].reference,
    "https://github.com/acme/repo/issues/51",
  );
  assert.match(limited.unresolvedReferences[0].reason, /heuristic/);
  assert.match(warning, /could not be resolved/);
  assert.equal(limited.diffSource.url, pr.url);
  assert.equal(limited.diff, "submitted diff");

  apiCalls.length = 0;
  source.conversation.messages.push({
    role: "user",
    content: "#51 #51 #51",
  });
  source.conversation.context =
    "See ACME/REPO#50 and https://github.com/acme/repo/issues/50?ref=context#details";
  const ranked = JSON.parse(await exportSessionJson(source, signal, run));
  assert.equal(apiCalls.length, 50);
  assert.deepEqual(
    ranked.discussions
      .slice(0, 4)
      .map((entry: { number: number }) => entry.number),
    [51, 1, 50, 2],
  );
  assert.equal(
    ranked.unresolvedReferences[0].reference,
    "https://github.com/acme/repo/issues/49",
  );
  assert.equal(ranked.diffSource.url, pr.url);
  assert.equal(ranked.diff, "submitted diff");
});

test("issue lookup never sends GitHub credentials to an untrusted reference host", async (t) => {
  const { signal, source } = await setup(t);
  source.conversation.messages.push({
    role: "user",
    content: "See https://untrusted.invalid/acme/repo/issues/1",
  });
  let queried = false;
  const run: CommandRunner = (file, args, directory, requestSignal) => {
    if (file === "gh") queried = true;
    return runCommand(file, args, directory, requestSignal);
  };
  await assert.rejects(
    exportSessionJson(source, signal, run),
    /configured GitHub repository host/,
  );
  assert.equal(queried, false);
});

test("issue lookups use bounded concurrency and retain reference order", async (t) => {
  const { signal, source } = await setup(t);
  source.conversation.messages.push({
    role: "user",
    content: Array.from(
      { length: 12 },
      (_, index) => `https://github.com/acme/repo/issues/${index + 1}`,
    ).join(" "),
  });
  let active = 0;
  let peak = 0;
  let calls = 0;
  const run: CommandRunner = async (file, args, directory, requestSignal) => {
    if (file !== "gh") return runCommand(file, args, directory, requestSignal);
    assert.equal(args[0], "api");
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    const number = Number(args[3]!.split("/").at(-1));
    return JSON.stringify({
      html_url: `https://github.com/acme/repo/issues/${number}`,
      number,
      title: `Issue ${number}`,
      state: "open",
      body: "",
    });
  };
  const result = JSON.parse(await exportSessionJson(source, signal, run));
  assert.equal(calls, 12);
  assert.equal(peak, 4);
  assert.deepEqual(
    result.discussions.map((entry: { number: number }) => entry.number),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
});
