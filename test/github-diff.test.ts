import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseApplicationMessage } from "../src/application";
import { GitHubRepository, type CommandRunner } from "../src/github";

const base = "a".repeat(40);
const mergeBase = "b".repeat(40);
const head = "c".repeat(40);
const url = "https://github.com/acme/project/pull/7";

interface FixtureBlob {
  content: string;
  reported?: string;
  binary?: boolean;
  truncated?: boolean;
  typename?: string;
}

interface FixtureFile {
  filename: string;
  status: string;
  sha: string;
  previous_filename?: string;
}

function oid(content: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
}

function pullFixture(
  files: FixtureFile[],
  blobs: Map<string, FixtureBlob> = new Map(),
  options: { changedFiles?: number; latestHead?: string } = {},
) {
  const calls: string[][] = [];
  let metadataReads = 0;
  const run: CommandRunner = async (command, args, _cwd, requestSignal) => {
    requestSignal.throwIfAborted();
    assert.equal(command, "gh");
    calls.push(args);
    if (args[0] === "repo")
      return JSON.stringify({
        nameWithOwner: "acme/project",
        url: "https://github.com/acme/project",
      });
    if (args.includes("graphql")) {
      const fields: Record<string, string> = {};
      for (let index = 0; index < args.length; index++)
        if (args[index] === "-f" || args[index] === "-F") {
          const field = args[++index]!;
          const separator = field.indexOf("=");
          fields[field.slice(0, separator)] = field.slice(separator + 1);
        }
      assert.equal(fields.owner, "acme");
      assert.equal(fields.name, "project");
      const responseBlob = (expression: string | undefined) => {
        assert.ok(expression);
        const blob = blobs.get(expression);
        assert.ok(blob, `Missing fixture blob ${expression}`);
        return {
          __typename: blob.typename ?? "Blob",
          oid: oid(blob.content),
          byteSize: Buffer.byteLength(blob.content),
          isBinary: Boolean(blob.binary),
          isTruncated: Boolean(blob.truncated),
          text: blob.binary
            ? null
            : blob.truncated
              ? "partial"
              : (blob.reported ?? blob.content),
        };
      };
      return JSON.stringify({
        data: {
          repository: {
            ...(fields.readOld === "true"
              ? { old: responseBlob(fields.old) }
              : {}),
            ...(fields.readNew === "true"
              ? { new: responseBlob(fields.new) }
              : {}),
          },
        },
      });
    }
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    assert.ok(endpoint);
    if (endpoint === "repos/acme/project/pulls/7") {
      metadataReads++;
      return JSON.stringify({
        base: { sha: base },
        head: { sha: metadataReads > 1 ? (options.latestHead ?? head) : head },
        changed_files: options.changedFiles ?? files.length,
      });
    }
    if (endpoint.startsWith("repos/acme/project/compare/")) {
      assert.match(endpoint, new RegExp(`${base}\\.\\.\\.${head}`));
      return `${mergeBase}\n`;
    }
    if (endpoint.startsWith("repos/acme/project/pulls/7/files?")) {
      const query = new URL(`https://api.github.test/${endpoint}`).searchParams;
      assert.equal(query.get("per_page"), "100");
      const page = Number(query.get("page"));
      return JSON.stringify(files.slice((page - 1) * 100, page * 100));
    }
    if (endpoint.startsWith("repos/acme/project/git/blobs/")) {
      assert.ok(args.includes("Accept: application/vnd.github.raw+json"));
      const blobOid = endpoint.split("/").at(-1);
      const blob = [...blobs.values()].find(
        (item) => oid(item.content) === blobOid,
      );
      assert.ok(blob, `Missing raw fixture blob ${blobOid}`);
      return blob.content;
    }
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  };
  return { calls, repository: new GitHubRepository("/projects/project", run) };
}

test("PR diff uses the merge base and pinned head, including renames and complete file contents", async () => {
  const signal = AbortSignal.timeout(30_000);
  const renamedOld = "one\nold\nsame\n";
  const renamedNew = "one\nnew\nsame\nextra";
  const added = "added \ufffd\n";
  const removed = "removed\n";
  const modeOnly = "unchanged\n";
  const binary = "\0binary";
  const blobs = new Map<string, FixtureBlob>([
    [`${mergeBase}:src/old name.ts`, { content: renamedOld, truncated: true }],
    [`${head}:src/new name.ts`, { content: renamedNew }],
    [`${head}:added.ts`, { content: added }],
    [`${mergeBase}:removed.ts`, { content: removed }],
    [`${mergeBase}:mode.sh`, { content: modeOnly }],
    [`${head}:mode.sh`, { content: modeOnly }],
    [`${mergeBase}:image.bin`, { content: binary, binary: true }],
    [`${head}:image.bin`, { content: binary, binary: true }],
  ]);
  const files: FixtureFile[] = [
    {
      filename: "src/new name.ts",
      previous_filename: "src/old name.ts",
      status: "renamed",
      sha: oid(renamedNew),
    },
    { filename: "added.ts", status: "added", sha: oid(added) },
    { filename: "removed.ts", status: "removed", sha: oid(removed) },
    { filename: "mode.sh", status: "modified", sha: oid(modeOnly) },
    { filename: "image.bin", status: "modified", sha: oid(binary) },
  ];
  const fixture = pullFixture(files, blobs);
  const snapshot = await fixture.repository.loadPullRequestDiff(url, signal);
  assert.equal(snapshot.list.baseCommit, mergeBase);
  assert.equal(snapshot.list.headCommit, head);
  assert.deepEqual(snapshot.list.files[0], {
    path: "src/new name.ts",
    oldPath: "src/old name.ts",
    status: "R",
  });
  const renamed = await fixture.repository.loadPullRequestDiffFile(
    snapshot,
    "src/new name.ts",
    signal,
  );
  assert.deepEqual(renamed.oldLines, ["one", "old", "same"]);
  assert.deepEqual(renamed.newLines, ["one", "new", "same", "extra"]);
  assert.deepEqual(renamed.changes, [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    { oldStart: 3, oldCount: 0, newStart: 3, newCount: 1 },
  ]);
  assert.equal(renamed.newNoFinalNewline, true);
  assert.ok(
    fixture.calls.some((args) =>
      args.some((arg) => arg.includes("/git/blobs/")),
    ),
  );
  const addedFile = await fixture.repository.loadPullRequestDiffFile(
    snapshot,
    "added.ts",
    signal,
  );
  assert.deepEqual(addedFile.oldLines, []);
  assert.deepEqual(addedFile.newLines, ["added \ufffd"]);
  const removedFile = await fixture.repository.loadPullRequestDiffFile(
    snapshot,
    "removed.ts",
    signal,
  );
  assert.deepEqual(removedFile.oldLines, ["removed"]);
  assert.deepEqual(removedFile.newLines, []);
  const mode = await fixture.repository.loadPullRequestDiffFile(
    snapshot,
    "mode.sh",
    signal,
  );
  assert.deepEqual(mode.oldLines, ["unchanged"]);
  assert.deepEqual(mode.newLines, mode.oldLines);
  assert.deepEqual(mode.changes, []);
  const image = await fixture.repository.loadPullRequestDiffFile(
    snapshot,
    "image.bin",
    signal,
  );
  assert.equal(image.binary, true);
});

test("PR file lists paginate and reject incomplete or changing snapshots", async () => {
  const signal = AbortSignal.timeout(30_000);
  const files = Array.from({ length: 101 }, (_, index) => ({
    filename: `file-${index}.txt`,
    status: "modified",
    sha: oid("content"),
  }));
  const fixture = pullFixture(files);
  const snapshot = await fixture.repository.loadPullRequestDiff(url, signal);
  assert.equal(snapshot.list.files.length, 101);
  assert.equal(
    fixture.calls.filter((args) => args.some((arg) => arg.includes("/files?")))
      .length,
    2,
  );
  await assert.rejects(
    pullFixture(files, new Map(), {
      latestHead: "d".repeat(40),
    }).repository.loadPullRequestDiff(url, signal),
    /pull request changed/,
  );
  await assert.rejects(
    pullFixture(files, new Map(), {
      changedFiles: 102,
    }).repository.loadPullRequestDiff(url, signal),
    /incomplete pull request file list/,
  );
  await assert.rejects(
    pullFixture([], new Map(), {
      changedFiles: 3001,
    }).repository.loadPullRequestDiff(url, signal),
    /more than 3000/,
  );
});

test("PR diff rejects unrelated requests, stale file metadata and unsupported objects", async () => {
  const signal = AbortSignal.timeout(30_000);
  const fixture = pullFixture([]);
  await assert.rejects(
    fixture.repository.loadPullRequestDiff(
      "https://github.com/acme/project/issues/7",
      signal,
    ),
    /Invalid GitHub pull request URL/,
  );
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(
    fixture.repository.loadPullRequestDiff(
      "https://github.com/acme/other/pull/7",
      signal,
    ),
    /selected GitHub repository/,
  );
  const message = {
    type: "pull-diff",
    id: "repo",
    view: "copilot",
    url,
    requestId: "request",
    path: "src/file.ts",
  };
  assert.deepEqual(parseApplicationMessage(message), message);
  for (const invalid of [
    { url: "https://github.com/acme/project/issues/7" },
    { url: "https://user:password@github.com/acme/project/pull/7" },
    { path: "../outside" },
    { requestId: "" },
  ])
    assert.throws(
      () => parseApplicationMessage({ ...message, ...invalid }),
      /Invalid pull request diff request/,
    );

  const blobs = new Map<string, FixtureBlob>([
    [`${mergeBase}:file`, { content: "old\n" }],
    [`${head}:file`, { content: "new\n" }],
  ]);
  const stale = pullFixture(
    [{ filename: "file", status: "modified", sha: oid("different\n") }],
    blobs,
  );
  const snapshot = await stale.repository.loadPullRequestDiff(url, signal);
  await assert.rejects(
    stale.repository.loadPullRequestDiffFile(snapshot, "file", signal),
    /does not match the loaded snapshot/,
  );
  blobs.set(`${head}:file`, { content: "new\n", typename: "Commit" });
  await assert.rejects(
    stale.repository.loadPullRequestDiffFile(snapshot, "file", signal),
    /submodules cannot be displayed/,
  );
  await assert.rejects(
    stale.repository.loadPullRequestDiffFile(snapshot, "absent", signal),
    /not in this pull request diff/,
  );
  blobs.set(`${head}:file`, { content: "new\n", reported: "bad\n" });
  const corrupted = pullFixture(
    [{ filename: "file", status: "modified", sha: oid("new\n") }],
    blobs,
  );
  const corruptedSnapshot = await corrupted.repository.loadPullRequestDiff(
    url,
    signal,
  );
  await assert.rejects(
    corrupted.repository.loadPullRequestDiffFile(
      corruptedSnapshot,
      "file",
      signal,
    ),
    /incomplete or unsupported UTF-8/,
  );
});

test("PR diff reports oversized files instead of truncating them", async () => {
  const signal = AbortSignal.timeout(30_000);
  for (const content of [
    "line\n".repeat(10_001),
    "x".repeat(4 * 1024 * 1024 + 1),
  ]) {
    const blob = { content, truncated: content.length > 100_000 };
    const fixture = pullFixture(
      [{ filename: "large.txt", status: "added", sha: oid(content) }],
      new Map([[`${head}:large.txt`, blob]]),
    );
    const snapshot = await fixture.repository.loadPullRequestDiff(url, signal);
    await assert.rejects(
      fixture.repository.loadPullRequestDiffFile(snapshot, "large.txt", signal),
      /too large/,
    );
    if (blob.truncated)
      assert.equal(
        fixture.calls.some((args) =>
          args.some((arg) => arg.includes("/git/blobs/")),
        ),
        false,
      );
  }
});
