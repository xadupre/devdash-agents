import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runCommand } from "../src/github";
import { listLocalDiff, loadLocalDiffFile } from "../src/local-diff";
import { parseApplicationMessage } from "../src/application";
import type { MachineConfiguration } from "../src/execution";

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devdash-local-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "alpha");
  await mkdir(cwd);
  const signal = AbortSignal.timeout(30_000);
  const git = (args: string[]) => runCommand("git", args, cwd, signal);
  await git(["init", "--quiet"]);
  await writeFile(join(cwd, "tracked.txt"), "one\ntwo\nthree\nfour\nend\n");
  await writeFile(join(cwd, "deleted.txt"), "deleted\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  await git(["add", "--all"]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  const machine: MachineConfiguration = {
    id: "local",
    name: "This computer",
    command: "",
    repositoriesPath: root,
    modelsPath: root,
    workerPath: "worker",
    cliPath: "copilot",
  };
  return { root, cwd, signal, git, machine };
}

test("local diff compares tracked staged and unstaged changes with HEAD", async (t) => {
  const { cwd, signal, git, machine } = await repository(t);
  await writeFile(
    join(cwd, "tracked.txt"),
    "one\ntwo replaced\nthree\nfour\nend\n",
  );
  await git(["add", "tracked.txt"]);
  await writeFile(
    join(cwd, "tracked.txt"),
    "one\ntwo replaced\ninsert\nthree\nfour\nend\nextra",
  );
  await unlink(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "added file.txt"), "added\n");
  await git(["add", "added file.txt"]);
  await writeFile(join(cwd, "untracked.txt"), "not included\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 9, 8]));

  const list = await listLocalDiff(cwd, machine, signal);
  assert.deepEqual(
    list.files.map(({ path, status }) => [path, status]),
    [
      ["added file.txt", "A"],
      ["binary.dat", "M"],
      ["deleted.txt", "D"],
      ["tracked.txt", "M"],
    ],
  );
  const changed = await loadLocalDiffFile(
    cwd,
    machine,
    list.commit,
    "tracked.txt",
    signal,
  );
  assert.deepEqual(changed.oldLines, ["one", "two", "three", "four", "end"]);
  assert.deepEqual(changed.newLines, [
    "one",
    "two replaced",
    "insert",
    "three",
    "four",
    "end",
    "extra",
  ]);
  assert.deepEqual(changed.changes, [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 },
    { oldStart: 5, oldCount: 0, newStart: 6, newCount: 1 },
  ]);
  assert.equal(changed.newNoFinalNewline, true);
  assert.equal(changed.oldNoFinalNewline, false);
  const added = await loadLocalDiffFile(
    cwd,
    machine,
    list.commit,
    "added file.txt",
    signal,
  );
  assert.deepEqual(added.oldLines, []);
  assert.deepEqual(added.newLines, ["added"]);
  const deleted = await loadLocalDiffFile(
    cwd,
    machine,
    list.commit,
    "deleted.txt",
    signal,
  );
  assert.deepEqual(deleted.oldLines, ["deleted"]);
  assert.deepEqual(deleted.newLines, []);
  const binary = await loadLocalDiffFile(
    cwd,
    machine,
    list.commit,
    "binary.dat",
    signal,
  );
  assert.equal(binary.binary, true);
  await assert.rejects(
    loadLocalDiffFile(cwd, machine, list.commit, "../outside", signal),
    /Invalid diff file request/,
  );
  await assert.rejects(
    loadLocalDiffFile(cwd, machine, "a".repeat(40), "tracked.txt", signal),
    /HEAD changed/,
  );
});

test(
  "diff paths are literal and webview requests cannot escape the repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const { cwd, signal, git, machine } = await repository(t);
    const path = ":(glob)*.txt";
    await writeFile(join(cwd, path), "literal\n");
    await git(["--literal-pathspecs", "add", "--", path]);
    const list = await listLocalDiff(cwd, machine, signal);
    const file = await loadLocalDiffFile(
      cwd,
      machine,
      list.commit,
      path,
      signal,
    );
    assert.deepEqual(file.newLines, ["literal"]);
    const request = {
      type: "local-diff",
      id: "alpha",
      view: "copilot",
      requestId: "request-1",
      path,
      commit: list.commit,
    };
    assert.deepEqual(parseApplicationMessage(request), request);
    assert.throws(
      () => parseApplicationMessage({ ...request, path: "../outside" }),
      /Invalid local diff request/,
    );
    assert.throws(
      () => parseApplicationMessage({ ...request, commit: "--help" }),
      /Invalid local diff request/,
    );
  },
);

test(
  "type changes and executable-mode changes retain their content",
  { skip: process.platform === "win32" },
  async (t) => {
    const { cwd, signal, machine } = await repository(t);
    await chmod(join(cwd, "tracked.txt"), 0o755);
    await unlink(join(cwd, "deleted.txt"));
    await symlink("tracked.txt", join(cwd, "deleted.txt"));
    const list = await listLocalDiff(cwd, machine, signal);
    assert.deepEqual(list.files, [
      { path: "deleted.txt", status: "T" },
      { path: "tracked.txt", status: "M" },
    ]);
    const mode = await loadLocalDiffFile(
      cwd,
      machine,
      list.commit,
      "tracked.txt",
      signal,
    );
    assert.deepEqual(mode.oldLines, ["one", "two", "three", "four", "end"]);
    assert.deepEqual(mode.newLines, mode.oldLines);
    assert.deepEqual(mode.changes, []);
    const type = await loadLocalDiffFile(
      cwd,
      machine,
      list.commit,
      "deleted.txt",
      signal,
    );
    assert.deepEqual(type.oldLines, ["deleted"]);
    assert.deepEqual(type.newLines, ["tracked.txt"]);
    assert.deepEqual(type.changes, [
      { oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 },
    ]);
  },
);

test(
  "local diff reads the selected session's remote execution clone",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, cwd, signal } = await repository(t);
    await writeFile(join(cwd, "tracked.txt"), "remote change\n");
    const machine: MachineConfiguration = {
      id: "remote",
      name: "Remote host",
      command: `"${process.execPath}" "${join(__dirname, "fixtures", "remote-shell.js")}"`,
      repositoriesPath: root,
      modelsPath: "/models",
      workerPath: "worker",
      cliPath: "copilot",
    };
    const missingLocal = join(root, "missing-local", "alpha");
    const list = await listLocalDiff(missingLocal, machine, signal);
    assert.equal(list.repositoryPath, cwd);
    assert.equal(list.machine, "Remote host");
    assert.deepEqual(list.files, [{ path: "tracked.txt", status: "M" }]);
    const file = await loadLocalDiffFile(
      missingLocal,
      machine,
      list.commit,
      "tracked.txt",
      signal,
    );
    assert.deepEqual(file.newLines, ["remote change"]);
  },
);

test("diff requests without a recorded execution machine fail explicitly", async (t) => {
  const { cwd, signal } = await repository(t);
  await assert.rejects(
    listLocalDiff(cwd, undefined, signal),
    /no recorded execution machine/,
  );
  await assert.rejects(
    loadLocalDiffFile(cwd, undefined, "a".repeat(40), "tracked.txt", signal),
    /no recorded execution machine/,
  );
});
