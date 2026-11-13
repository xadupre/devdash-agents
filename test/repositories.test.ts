import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverRepositories } from "../src/repositories";

test("discovers only direct Git children, including worktrees, without following directory symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arranged-agents-repositories-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    ".git",
    "alpha/.git",
    "beta",
    "ordinary/nested/.git",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "beta", ".git"), "gitdir: ../worktree");
  await writeFile(join(root, "not-a-directory"), "");
  if (process.platform !== "win32") {
    await symlink(join(root, "alpha"), join(root, "linked-repository"), "dir");
  }
  assert.deepEqual(await discoverRepositories(root), [
    { id: join(root, "alpha"), name: "alpha", path: join(root, "alpha") },
    { id: join(root, "beta"), name: "beta", path: join(root, "beta") },
  ]);
  await assert.rejects(discoverRepositories(join(root, "missing")), {
    code: "ENOENT",
  });
});
