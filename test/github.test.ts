import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GitHubRepository,
  runCommand,
  type CommandRunner,
  type GitHubUpdate,
  type GitHubDiscussionUpdate,
  type GitHubCommentUpdate,
  MAX_GITHUB_COMMENT_LENGTH,
} from "../src/github";
import { GitHubPanel } from "../src/github-panel";
import { parseApplicationMessage } from "../src/application";

const when = (day: number): string =>
  `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`;
function comment(id: string, login: string, day: number, body = id) {
  return {
    id,
    author: { login },
    createdAt: when(day),
    url: `https://github.com/acme/project/issues/1#${id}`,
    body,
  };
}
function history(nodes: unknown[], cursor?: string) {
  return {
    nodes,
    pageInfo: { hasPreviousPage: Boolean(cursor), startCursor: cursor ?? null },
  };
}
function page(nodes: unknown[], cursor?: string) {
  return {
    nodes,
    pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor ?? null },
  };
}
function issue(id: string, login = "someone", comments: unknown[] = []) {
  return {
    id,
    number: 1,
    title: `<b>${id}</b>`,
    author: { login },
    updatedAt: when(10),
    url: "https://github.com/acme/project/issues/1",
    comments: history(comments),
  };
}
function discussion(kind: "Issue" | "PullRequest" = "Issue") {
  return {
    ...issue("discussion"),
    __typename: kind,
    body: "**Description**",
    createdAt: when(1),
    state: "OPEN",
  };
}
function postedComment(body = "**Comment**") {
  return {
    node_id: "IC_new",
    user: { login: "Ada" },
    body,
    created_at: when(3),
    html_url: "https://github.com/acme/project/issues/1#issuecomment-1",
  };
}
function fixture(
  respond: (
    query: string,
    fields: Record<string, string>,
    signal: AbortSignal,
  ) => unknown,
) {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const run: CommandRunner = async (file, args, cwd, signal) => {
    signal.throwIfAborted();
    calls.push({ file, args, cwd });
    assert.equal(file, "gh");
    if (args[0] === "repo")
      return JSON.stringify({
        nameWithOwner: "acme/project",
        url: "https://github.com/acme/project",
      });
    if (args.at(-1) === "user") return JSON.stringify({ login: "Ada" });
    const fields: Record<string, string> = {};
    if (args.includes("--input")) {
      const path = args[args.indexOf("--input") + 1]!;
      const input: { body: string } = JSON.parse(await readFile(path, "utf8"));
      fields.body = input.body;
      if (process.platform !== "win32") {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      }
    }
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "-f" || args[index] === "-F") {
        const field = args[++index]!;
        const separator = field.indexOf("=");
        fields[field.slice(0, separator)] = field.slice(separator + 1);
      }
    }
    return JSON.stringify(await respond(fields.query!, fields, signal));
  };
  return { run, calls };
}

test("issue and PR comments use one explicit POST with a private JSON payload and the exact literal Unicode body", async () => {
  const body =
    "  **Comment**\n\n$(not a command) = --flag  " + "\u6f22".repeat(50_000);
  for (const kind of ["issues", "pull"]) {
    const source = fixture((_query, fields) => postedComment(fields.body));
    const result = await new GitHubRepository(
      "/projects/project",
      source.run,
    ).postComment(
      `https://github.com/acme/project/${kind}/1`,
      body,
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      id: "IC_new",
      author: "Ada",
      body,
      date: when(3),
      url: "https://github.com/acme/project/issues/1#issuecomment-1",
    });
    assert.equal(source.calls.length, 2);
    const input = source.calls[1]?.args.at(-1);
    assert.ok(input);
    assert.deepEqual(source.calls[1], {
      file: "gh",
      cwd: "/projects/project",
      args: [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "repos/acme/project/issues/1/comments",
        "--input",
        input,
      ],
    });
    await assert.rejects(stat(input), { code: "ENOENT" });
  }
});

test("comment messages reject invalid text and unrelated targets before any write", async () => {
  const url = "https://github.com/acme/project/issues/1";
  for (const body of ["", " \n ", "x".repeat(MAX_GITHUB_COMMENT_LENGTH + 1)]) {
    const source = fixture(() => {
      throw new Error("Must not write");
    });
    await assert.rejects(
      new GitHubRepository("/projects/project", source.run).postComment(
        url,
        body,
        new AbortController().signal,
      ),
      /GitHub comment/,
    );
    assert.deepEqual(source.calls, []);
    assert.throws(() =>
      parseApplicationMessage({
        type: "github-comment",
        id: "repo",
        url,
        body,
        requestId: "1",
      }),
    );
  }
  const source = fixture(() => {
    throw new Error("Must not write");
  });
  await assert.rejects(
    new GitHubRepository("/projects/project", source.run).postComment(
      "https://github.com/acme/unrelated/pull/1",
      "Comment",
      new AbortController().signal,
    ),
    /selected GitHub repository/,
  );
  assert.equal(source.calls.length, 1);
  for (const requestId of ["", "x".repeat(101), 1]) {
    assert.throws(() =>
      parseApplicationMessage({
        type: "github-comment",
        id: "repo",
        url,
        body: "Comment",
        requestId,
      }),
    );
  }
  const message = {
    type: "github-comment",
    id: "repo",
    url,
    body: "Comment",
    requestId: "request",
  };
  assert.deepEqual(parseApplicationMessage(message), message);
});

test("comment publication guards concurrent submissions and survives reader cancellation or repository removal", async () => {
  const updates: GitHubCommentUpdate[] = [];
  const errors: unknown[] = [];
  let release!: (value: unknown) => void;
  let entered!: () => void;
  let postSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const source = fixture(
    (_query, _fields, signal) =>
      new Promise((resolve) => {
        postSignal = signal;
        release = resolve;
        entered();
      }),
  );
  const panel = new GitHubPanel(
    () => {},
    (error) => errors.push(error),
    (repository) => new GitHubRepository(repository.path, source.run),
  );
  const repository = { id: "repo", name: "Repo", path: "/projects/project" };
  const url = "https://github.com/acme/project/pull/1";
  const first = panel.postComment(
    repository,
    url,
    "First comment",
    "first",
    (update) => updates.push(update),
  );
  await started;
  await panel.postComment(repository, url, "Duplicate", "second", (update) =>
    updates.push(update),
  );
  panel.cancelDiscussion("repo");
  panel.retain(new Set());
  assert.equal(postSignal?.aborted, false);
  release(postedComment("First comment"));
  await first;
  assert.equal(
    source.calls.filter((call) => call.args.includes("POST")).length,
    1,
  );
  const input = source.calls
    .find((call) => call.args.includes("POST"))
    ?.args.at(-1);
  assert.ok(input);
  await assert.rejects(stat(input), { code: "ENOENT" });
  assert.deepEqual(
    updates
      .filter((update) => update.requestId === "first")
      .map((update) => update.status),
    ["posting", "posted"],
  );
  assert.match(
    updates.find((update) => update.requestId === "second")?.error ?? "",
    /already being published/,
  );
  assert.equal(errors.length, 1);
  await panel.dispose();
});

test("publication failures are logged and surfaced without retrying an uncertain POST", async () => {
  const updates: GitHubCommentUpdate[] = [];
  const errors: unknown[] = [];
  const source = fixture(() => {
    throw new Error("Connection reset");
  });
  const panel = new GitHubPanel(
    () => {},
    (error) => errors.push(error),
    (repository) => new GitHubRepository(repository.path, source.run),
  );
  await panel.postComment(
    { id: "repo", name: "Repo", path: "/projects/project" },
    "https://github.com/acme/project/issues/1",
    "Keep this draft",
    "request",
    (update) => updates.push(update),
  );
  assert.deepEqual(
    updates.map((update) => update.status),
    ["posting", "error"],
  );
  assert.match(
    updates.at(-1)?.error ?? "",
    /Connection reset.*Check GitHub before retrying/,
  );
  const input = source.calls
    .find((call) => call.args.includes("POST"))
    ?.args.at(-1);
  assert.ok(input);
  await assert.rejects(stat(input), { code: "ENOENT" });
  assert.equal(
    source.calls.filter((call) => call.args.includes("POST")).length,
    1,
  );
  assert.equal(errors.length, 1);
  await panel.dispose();
});

test("the discussion reader loads issue and PR descriptions and paginates all discussion comments", async () => {
  for (const kind of ["Issue", "PullRequest"] as const) {
    const source = fixture((query, fields) => {
      if (query.includes("node(id:")) {
        assert.match(query, new RegExp(`on ${kind}`));
        assert.equal(fields.before, "older-comments");
        return {
          data: { node: { comments: history([comment("first", "Ada", 2)]) } },
        };
      }
      assert.match(query, /issueOrPullRequest\(number:\$number\)/);
      assert.equal(fields.number, "1");
      return {
        data: {
          repository: {
            issueOrPullRequest: {
              ...discussion(kind),
              comments: history(
                [comment("second", "other", 3)],
                "older-comments",
              ),
            },
          },
        },
      };
    });
    const result = await new GitHubRepository(
      "/projects/project",
      source.run,
    ).loadDiscussion(
      `https://github.com/acme/project/${kind === "Issue" ? "issues" : "pull"}/1`,
      new AbortController().signal,
    );
    assert.equal(result.kind, kind);
    assert.equal(result.title, "#1 <b>discussion</b>");
    assert.equal(result.body, "**Description**");
    assert.equal(result.state, "OPEN");
    assert.equal(result.date, when(1));
    assert.deepEqual(
      result.comments.map((entry) => entry.id),
      ["first", "second"],
    );
    assert.ok(source.calls.every((call) => call.cwd === "/projects/project"));
    const request = source.calls.find((call) => call.args.includes("number=1"));
    assert.ok(request);
    assert.equal(request.args[request.args.indexOf("number=1") - 1], "-F");
    assert.equal(source.calls.length, 3);
  }
});

test("the discussion reader rejects unrelated repositories, invalid URLs and pre-cancelled work", async () => {
  for (const target of [
    "https://example.com/acme/project/issues/1",
    "https://github.com/acme/other/pull/1",
  ]) {
    const source = fixture(() => {
      throw new Error("Must not fetch unrelated discussions");
    });
    await assert.rejects(
      new GitHubRepository("/projects/project", source.run).loadDiscussion(
        target,
        new AbortController().signal,
      ),
      /selected GitHub repository/,
    );
    assert.equal(source.calls.length, 1);
  }
  for (const url of [
    "file:///acme/project/issues/1",
    "https://github.com/acme/project/pull/0",
    "https://github.com/acme/project/pull/9007199254740992",
    "https://github.com/acme/project/pull/1/files",
  ]) {
    assert.throws(() =>
      parseApplicationMessage({ type: "github-discussion", id: "repo", url }),
    );
  }
  const source = fixture(() => ({}));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new GitHubRepository("/projects/project", source.run).loadDiscussion(
      "https://github.com/acme/project/issues/1",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(source.calls, []);
  assert.deepEqual(
    parseApplicationMessage({
      type: "github-discussion",
      id: "repo",
      url: "https://github.com/acme/project/pull/1",
    }),
    {
      type: "github-discussion",
      id: "repo",
      url: "https://github.com/acme/project/pull/1",
    },
  );
});

test("the discussion reader surfaces missing discussions and invalid response fields", async () => {
  for (const response of [
    { errors: [{ message: "Access denied" }], data: {} },
    { data: { repository: { issueOrPullRequest: null } } },
    ...[
      { number: "1" },
      { body: null },
      { createdAt: "invalid" },
      { url: "javascript:alert(1)" },
    ].map((invalid) => ({
      data: {
        repository: { issueOrPullRequest: { ...discussion(), ...invalid } },
      },
    })),
  ]) {
    const source = fixture(() => response);
    await assert.rejects(
      new GitHubRepository("/projects/project", source.run).loadDiscussion(
        "https://github.com/acme/project/issues/1",
        new AbortController().signal,
      ),
      /GitHub/,
    );
  }
});

test("issue flags use the authenticated viewer and paginate older replies rather than guessing from updatedAt", async () => {
  const mine = {
    ...issue("mine", "aDA", [comment("new", "other", 9)]),
    comments: history([comment("new", "other", 9)], "older"),
  };
  const replied = issue("replied", "other", [
    comment("before", "other", 1),
    comment("own", "Ada", 8),
  ]);
  const ownWithoutReply = issue("authored", "Ada");
  const { run, calls } = fixture((query, fields) => {
    if (query.includes("node(id:")) {
      assert.equal(fields.id, "mine");
      assert.equal(fields.before, "older");
      return {
        data: { node: { comments: history([comment("old-own", "Ada", 2)]) } },
      };
    }
    assert.match(query, /issues\(first:20/);
    assert.match(query, /states:OPEN/);
    return {
      data: {
        repository: { issues: page([mine, replied, ownWithoutReply], "next") },
      },
    };
  });
  const result = await new GitHubRepository("/projects/project", run).load(
    "issues",
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.viewer, "Ada");
  assert.equal(result.cursor, "next");
  assert.deepEqual(
    result.items.map(({ mine, replied, afterMe }) => ({
      mine,
      replied,
      afterMe,
    })),
    [
      { mine: true, replied: true, afterMe: true },
      { mine: false, replied: true, afterMe: false },
      { mine: true, replied: false, afterMe: false },
    ],
  );
  assert.ok(result.items.every((item) => item.comments === undefined));
  assert.ok(calls.every((call) => call.cwd === "/projects/project"));
  assert.equal(calls.filter((call) => call.args.includes("graphql")).length, 2);
});

test("comments include all own replies and only later external responses, including PR reviews and inline threads", async () => {
  const review = {
    id: "review",
    author: { login: "Ada" },
    body: "My review",
    state: "COMMENTED",
    submittedAt: when(3),
    url: "https://github.com/acme/project/pull/1#review",
    comments: history(
      [comment("inline-own", "Ada", 5), comment("inline-before", "other", 4)],
      "inline-older",
    ),
  };
  const pull = {
    ...issue("pull", "Ada", [
      comment("own-first", "Ada", 1),
      comment("after", "other", 6),
    ]),
    reviews: history(
      [
        review,
        { ...review, id: "draft", submittedAt: null, body: "Unsubmitted" },
      ],
      "older-reviews",
    ),
  };
  const { run, calls } = fixture((query, fields) => {
    if (query.includes("node(id:")) {
      return {
        data: {
          node:
            fields.id === "pull"
              ? { reviews: history([]) }
              : { comments: history([comment("inline-old-own", "Ada", 2)]) },
        },
      };
    }
    assert.match(fields.commentedQuery!, /commenter:Ada/);
    assert.match(fields.reviewedQuery!, /reviewed-by:Ada/);
    assert.doesNotMatch(fields.commentedQuery!, /is:open/);
    if (fields.commented) {
      assert.equal(fields.commented, "next-comments");
      assert.equal(fields.loadReviewed, "false");
      return { data: { commented: page([]) } };
    }
    return {
      data: {
        commented: page([pull], "next-comments"),
        reviewed: page([pull]),
      },
    };
  });
  const repository = new GitHubRepository("/projects/project", run);
  const result = await repository.load(
    "comments",
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.afterMe, true);
  assert.deepEqual(
    result.items[0]?.comments?.map((entry) => entry.id),
    ["after", "inline-own", "review", "inline-old-own", "own-first"],
  );
  assert.equal(result.items[0]?.date, when(6));
  assert.ok(
    result.items[0]?.comments?.every((entry) =>
      entry.url.startsWith("https://github.com/"),
    ),
  );
  assert.equal(
    calls.filter((call) => call.args.some((arg) => arg === "id=review")).length,
    1,
  );
  assert.ok(result.cursor);
  const next = await repository.load(
    "comments",
    result.cursor,
    new AbortController().signal,
  );
  assert.deepEqual(next.items, []);
  assert.equal(next.cursor, undefined);
});

test("PR lists preserve ownership and review participation flags", async () => {
  const review = {
    id: "review",
    author: { login: "Ada" },
    body: "",
    state: "APPROVED",
    submittedAt: when(3),
    url: "https://github.com/acme/project/pull/1#review",
    comments: history([]),
  };
  const { run } = fixture((query, fields) => {
    assert.match(query, /pullRequests\(first:20/);
    assert.equal(fields.cursor, "page-two");
    return {
      data: {
        repository: {
          pullRequests: page([
            {
              ...issue("pull", "other", [comment("later", "other", 4)]),
              reviews: history([review]),
            },
          ]),
        },
      },
    };
  });
  const result = await new GitHubRepository("/projects/project", run).load(
    "reviews",
    "page-two",
    new AbortController().signal,
  );
  assert.deepEqual(
    result.items.map(({ mine, replied, afterMe }) => ({
      mine,
      replied,
      afterMe,
    })),
    [{ mine: false, replied: true, afterMe: true }],
  );
});

test("oldest PRs fetch only 10 open PRs by creation date without participation histories or pagination", async () => {
  const { run, calls } = fixture((query, fields) => {
    assert.match(
      query,
      /pullRequests\(first:10,states:OPEN,orderBy:\{field:CREATED_AT,direction:ASC\}\)/,
    );
    assert.doesNotMatch(query, /comments|reviews|updatedAt|after:/);
    assert.equal(fields.owner, "acme");
    assert.equal(fields.name, "project");
    assert.equal(fields.cursor, undefined);
    return {
      data: {
        repository: {
          pullRequests: page(
            Array.from({ length: 10 }, (_, index) => ({
              id: `pull-${index}`,
              number: index + 1,
              title: `PR ${index + 1}`,
              author: index === 0 ? null : { login: "aDA" },
              createdAt: when(10 - index),
              url: `https://github.com/acme/project/pull/${index + 1}`,
            })),
            "more-prs",
          ),
        },
      },
    };
  });
  const result = await new GitHubRepository("/projects/project", run).load(
    "oldest-prs",
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.repository, "acme/project");
  assert.equal(result.viewer, "Ada");
  assert.equal(result.items.length, 10);
  assert.deepEqual(
    result.items.map((item) => item.date),
    Array.from({ length: 10 }, (_, index) => when(index + 1)),
  );
  assert.equal(result.items[0]?.title, "#10 PR 10");
  assert.equal(result.items[0]?.mine, true);
  assert.equal(result.items[0]?.url, "https://github.com/acme/project/pull/10");
  assert.equal(result.items[9]?.author, "[deleted]");
  assert.equal(result.items[9]?.mine, false);
  assert.equal(result.cursor, undefined);
  assert.ok(
    result.items.every(
      (item) => !item.replied && !item.afterMe && !item.comments,
    ),
  );
  assert.equal(calls.filter((call) => call.args.includes("graphql")).length, 1);
  assert.ok(calls.every((call) => call.cwd === "/projects/project"));
  assert.deepEqual(
    parseApplicationMessage({
      type: "github",
      id: "repo",
      section: "oldest-prs",
    }),
    { type: "github", id: "repo", section: "oldest-prs", cursor: undefined },
  );
});

test("oldest PRs handle empty repositories and surface invalid responses", async () => {
  const empty = fixture(() => ({
    data: { repository: { pullRequests: page([]) } },
  }));
  const result = await new GitHubRepository(
    "/projects/project",
    empty.run,
  ).load("oldest-prs", undefined, new AbortController().signal);
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, undefined);
  for (const response of [
    { errors: [{ message: "Access denied" }], data: {} },
    ...[
      { number: "1" },
      { createdAt: "not a date" },
      { url: "javascript:alert(1)" },
    ].map((invalid) => ({
      data: {
        repository: {
          pullRequests: page([
            {
              ...issue("pull"),
              createdAt: when(1),
              ...invalid,
            },
          ]),
        },
      },
    })),
  ]) {
    const source = fixture(() => response);
    await assert.rejects(
      new GitHubRepository("/projects/project", source.run).load(
        "oldest-prs",
        undefined,
        new AbortController().signal,
      ),
      /GitHub/,
    );
  }
});

test("mentions show only direct pings after the viewer's latest response, including descriptions", async () => {
  const discussion = (
    id: string,
    comments: unknown[] = [],
    body = "",
    login = "other",
  ) => ({ ...issue(id, login, comments), body, createdAt: when(1) });
  const source = fixture((query, fields) => {
    assert.match(query, /search\(query:\$searchQuery,type:ISSUE/);
    assert.match(query, /on Issue.*body createdAt/);
    assert.match(query, /on PullRequest.*body createdAt/);
    assert.equal(
      fields.searchQuery,
      "repo:acme/project mentions:Ada sort:updated-desc",
    );
    assert.equal(fields.cursor, undefined);
    return {
      data: {
        search: page([
          discussion("description", [], "Please check, @aDA!"),
          discussion("unanswered", [
            comment("ping", "other", 5, "@Ada please reply"),
          ]),
          discussion(
            "answered",
            [
              comment("ping", "other", 2, "@Ada"),
              comment("reply", "aDA", 3),
              comment("unrelated", "other", 4, "Not a new ping"),
            ],
            "@Ada",
          ),
          discussion("ping-again", [
            comment("old-ping", "other", 2, "@Ada"),
            comment("reply", "Ada", 3),
            comment("new-ping", "other", 6, "(@ADA), another question"),
            comment("unrelated", "other", 8),
          ]),
          discussion(
            "own-ping",
            [comment("self", "Ada", 9, "@Ada")],
            "@Ada",
            "Ada",
          ),
          discussion("not-direct", [
            comment("email", "other", 9, "mail@Ada"),
            comment("longer", "other", 9, "@Ada-other @Adam @Ada1"),
            comment("team", "other", 9, "@Ada/team @org/Ada"),
          ]),
        ]),
      },
    };
  });
  const result = await new GitHubRepository(
    "/projects/project",
    source.run,
  ).load("mentions", undefined, new AbortController().signal);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["ping-again", "unanswered", "description"],
  );
  assert.deepEqual(
    result.items.map((item) => item.comments?.map((entry) => entry.id)),
    [["new-ping"], ["ping"], ["description"]],
  );
  assert.equal(result.items[0]?.date, when(6));
  assert.equal(result.cursor, undefined);
  assert.match(result.notice ?? "", /Includes closed/);
  assert.equal(
    parseApplicationMessage({ type: "github", id: "repo", section: "mentions" })
      .type,
    "github",
  );
});

test("mentions paginate empty filtered pages and read older inline pings and submitted reviews", async () => {
  const review = {
    id: "review",
    author: { login: "Ada" },
    body: "",
    state: "APPROVED",
    submittedAt: when(4),
    url: "https://github.com/acme/project/pull/1#review",
    comments: history([], "inline-older"),
  };
  const pull = {
    ...issue("pull"),
    body: "",
    createdAt: when(1),
    reviews: history([
      review,
      { ...review, id: "draft", submittedAt: null, body: "@Ada" },
    ]),
  };
  const { run } = fixture((query, fields) => {
    if (query.includes("node(id:")) {
      assert.equal(fields.id, "review");
      assert.equal(fields.before, "inline-older");
      return {
        data: {
          node: {
            comments: history([comment("inline-ping", "other", 3, "@Ada")]),
          },
        },
      };
    }
    if (fields.cursor) {
      assert.equal(fields.cursor, "next-mentions");
      return {
        data: {
          search: page([
            {
              ...pull,
              reviews: history([
                {
                  ...review,
                  comments: history([
                    comment("pending-inline", "other", 5, "@Ada"),
                  ]),
                },
                {
                  ...review,
                  id: "review-ping",
                  author: { login: "other" },
                  body: "@Ada please check",
                  submittedAt: when(6),
                  comments: history([]),
                },
              ]),
            },
          ]),
        },
      };
    }
    return { data: { search: page([pull], "next-mentions") } };
  });
  const repository = new GitHubRepository("/projects/project", run);
  const first = await repository.load(
    "mentions",
    undefined,
    new AbortController().signal,
  );
  assert.deepEqual(first.items, []);
  assert.equal(first.cursor, "next-mentions");
  const next = await repository.load(
    "mentions",
    first.cursor,
    new AbortController().signal,
  );
  assert.equal(next.cursor, undefined);
  assert.deepEqual(
    next.items[0]?.comments?.map((entry) => entry.id),
    ["review-ping", "pending-inline"],
  );
});

test("issue and PR lists sort by update time, while merged comment searches sort by the latest displayed response", async () => {
  const older = {
    ...issue("older", "Ada", [comment("old-response", "Ada", 2)]),
    updatedAt: when(20),
  };
  const newer = {
    ...issue("newer", "other", [comment("new-response", "Ada", 8)]),
    updatedAt: when(10),
    reviews: history([]),
  };
  const { run } = fixture((query) => {
    if (query.includes("commented:search")) {
      return { data: { commented: page([older]), reviewed: page([newer]) } };
    }
    return {
      data: {
        repository: {
          [query.includes("pullRequests(") ? "pullRequests" : "issues"]: page([
            newer,
            older,
          ]),
        },
      },
    };
  });
  const repository = new GitHubRepository("/projects/project", run);
  for (const section of ["issues", "reviews", "comments"] as const) {
    const result = await repository.load(
      section,
      undefined,
      new AbortController().signal,
    );
    assert.deepEqual(
      result.items.map((item) => item.id),
      section === "comments" ? ["newer", "older"] : ["older", "newer"],
    );
  }
});

test("a failed thread aborts sibling history requests instead of leaving CLI work behind", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const { run } = fixture(async (query, fields, signal) => {
    if (!query.includes("node(id:")) {
      return {
        data: {
          repository: {
            issues: page([
              { ...issue("bad"), comments: history([], "bad-history") },
              { ...issue("waiting"), comments: history([], "waiting-history") },
            ]),
          },
        },
      };
    }
    if (fields.id === "bad") {
      await waiting;
      throw new Error("History access denied");
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
      entered();
    });
  });
  await assert.rejects(
    new GitHubRepository("/projects/project", run).load(
      "issues",
      undefined,
      new AbortController().signal,
    ),
    /History access denied/,
  );
  assert.equal(aborted, true);
});

test("GitHub errors, invalid links, bad pagination and pre-cancelled work fail explicitly", async () => {
  for (const response of [
    { errors: [{ message: "Access denied" }], data: {} },
    {
      data: {
        repository: {
          issues: page([{ ...issue("bad"), url: "javascript:alert(1)" }]),
        },
      },
    },
    {
      data: {
        repository: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      },
    },
  ]) {
    const { run } = fixture(() => response);
    await assert.rejects(
      new GitHubRepository("/projects/project", run).load(
        "issues",
        undefined,
        new AbortController().signal,
      ),
      /GitHub/,
    );
  }
  const { run, calls } = fixture(() => ({}));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new GitHubRepository("/projects/project", run).load(
      "issues",
      undefined,
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, []);
  for (const value of [
    { type: "github", id: "repo", section: "unknown" },
    { type: "github", id: "repo", section: "issues", cursor: 1 },
    { type: "github", id: "repo", section: "issues", cursor: "x".repeat(4097) },
  ])
    assert.throws(() => parseApplicationMessage(value));
  assert.deepEqual(
    parseApplicationMessage({
      type: "github",
      id: "repo",
      section: "comments",
    }),
    {
      type: "github",
      id: "repo",
      section: "comments",
      cursor: undefined,
    },
  );
});

test("commits read the real local branch and link to GitHub without requiring gh authentication", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "arranged-agents-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const git = (args: string[]) => runCommand("git", args, cwd, signal);
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Example"]);
  await git(["config", "user.email", "example@example.invalid"]);
  await writeFile(join(cwd, "example.txt"), "A local file");
  await git(["add", "example.txt"]);
  await git([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--date=2026-01-20T12:00:00Z",
    "-m",
    "<script>Not HTML</script>",
  ]);
  await writeFile(
    join(cwd, "example.txt"),
    "A second commit with an earlier author date",
  );
  await git(["add", "example.txt"]);
  await git([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--date=2026-01-01T12:00:00Z",
    "-m",
    "Earlier author date",
  ]);
  await git(["remote", "add", "origin", "git@github.com:acme/project.git"]);
  const repository = new GitHubRepository(cwd);
  const result = await repository.load("commits", undefined, signal);
  assert.equal(result.items.length, 2);
  assert.match(result.items[0]?.title ?? "", /<script>Not HTML<\/script>/);
  assert.deepEqual(
    result.items.map((item) => Date.parse(item.date)),
    [Date.parse(when(20)), Date.parse(when(1))],
  );
  assert.equal(
    result.items[0]?.url,
    `https://github.com/acme/project/commit/${result.items[0]?.id}`,
  );
  assert.equal(result.repository, "acme/project");
  await mkdir(join(cwd, "local-remote"));
  await git(["remote", "set-url", "origin", join(cwd, "local-remote")]);
  const local = await repository.load("commits", undefined, signal);
  assert.equal(local.items[0]?.url, undefined);
  assert.match(local.notice ?? "", /No GitHub remote/);
  await git(["remote", "remove", "origin"]);
  assert.equal(
    (await repository.load("commits", undefined, signal)).items.length,
    2,
  );
});

test("sidebar loads cancel superseded or removed requests and shutdown waits for cleanup", async () => {
  const updates: GitHubUpdate[] = [];
  const errors: unknown[] = [];
  const gates: { resolve: (value: string) => void; signal: AbortSignal }[] = [];
  const entered: (() => void)[] = [];
  const run: CommandRunner = async (_file, args, _cwd, signal) => {
    if (args[0] === "repo")
      return JSON.stringify({
        nameWithOwner: "acme/project",
        url: "https://github.com/acme/project",
      });
    if (args.at(-1) === "user") return JSON.stringify({ login: "Ada" });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      gates.push({ resolve, signal });
      entered.shift()?.();
    });
  };
  const panel = new GitHubPanel(
    (update) => updates.push(update),
    (error) => errors.push(error),
    (repository) => new GitHubRepository(repository.path, run),
  );
  const repository = { id: "alpha", name: "Alpha", path: "/projects/alpha" };
  const firstEntered = new Promise<void>((resolve) => entered.push(resolve));
  const first = panel.load(repository, "issues");
  await firstEntered;
  const secondEntered = new Promise<void>((resolve) => entered.push(resolve));
  const second = panel.load(repository, "issues");
  await secondEntered;
  await first;
  assert.equal(gates[0]?.signal.aborted, true);
  gates[1]?.resolve(
    JSON.stringify({
      data: { repository: { issues: page([issue("latest")]) } },
    }),
  );
  await second;
  assert.equal(updates.filter((update) => update.status === "ready").length, 1);
  const thirdEntered = new Promise<void>((resolve) => entered.push(resolve));
  const third = panel.load(repository, "issues");
  await thirdEntered;
  panel.retain(new Set());
  await panel.dispose();
  await third;
  assert.equal(gates[2]?.signal.aborted, true);
  assert.deepEqual(errors, []);
  await assert.rejects(panel.load(repository, "issues"), /closed/);
});

test("sidebar authentication failures are published and logged rather than returned as empty activity", async () => {
  const updates: GitHubUpdate[] = [];
  const errors: unknown[] = [];
  const panel = new GitHubPanel(
    (update) => updates.push(update),
    (error) => errors.push(error),
    (repository) =>
      new GitHubRepository(repository.path, async () => {
        throw new Error("Run gh auth login");
      }),
  );
  await panel.load(
    { id: "repo", name: "Repo", path: "/projects/repo" },
    "issues",
  );
  assert.equal(updates.at(-1)?.status, "error");
  assert.match(updates.at(-1)?.error ?? "", /gh auth login/);
  assert.equal(updates.at(-1)?.page, undefined);
  assert.equal(errors.length, 1);
  const discussions: GitHubDiscussionUpdate[] = [];
  await panel.loadDiscussion(
    { id: "repo", name: "Repo", path: "/projects/repo" },
    "https://github.com/acme/project/issues/1",
    (update) => discussions.push(update),
  );
  assert.equal(discussions.at(-1)?.status, "error");
  assert.match(discussions.at(-1)?.error ?? "", /gh auth login/);
  assert.equal(errors.length, 2);
  await panel.dispose();
});

test("discussion loads cancel superseded reads and explicit closes without publishing stale results", async () => {
  const updates: GitHubDiscussionUpdate[] = [];
  const errors: unknown[] = [];
  const entered: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  const source = fixture(async (_query, fields, signal) => {
    if (fields.number === "1") {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        signals.push(signal);
        entered.shift()?.();
      });
    }
    return { data: { repository: { issueOrPullRequest: discussion() } } };
  });
  const panel = new GitHubPanel(
    () => {},
    (error) => errors.push(error),
    (repository) => new GitHubRepository(repository.path, source.run),
  );
  const repository = { id: "repo", name: "Repo", path: "/projects/repo" };
  const start = () =>
    panel.loadDiscussion(
      repository,
      "https://github.com/acme/project/issues/1",
      (update) => updates.push(update),
    );
  const firstEntered = new Promise<void>((resolve) => entered.push(resolve));
  const first = start();
  await firstEntered;
  await panel.loadDiscussion(
    repository,
    "https://github.com/acme/project/pull/2",
    (update) => updates.push(update),
  );
  await first;
  assert.equal(signals[0]?.aborted, true);
  assert.deepEqual(
    updates
      .filter((update) => update.status === "ready")
      .map((update) => update.url),
    ["https://github.com/acme/project/pull/2"],
  );
  const secondEntered = new Promise<void>((resolve) => entered.push(resolve));
  const second = start();
  await secondEntered;
  panel.cancelDiscussion("repo");
  await second;
  assert.equal(signals[1]?.aborted, true);
  assert.deepEqual(errors, []);
  await panel.dispose();
});
