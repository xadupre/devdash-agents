import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bashOnly = { skip: process.platform === "win32" };

async function setup(
  t: TestContext,
  options: { installed?: boolean; desktop?: boolean; npm?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "arranged-agents-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout with spaces");
  const tools = join(directory, "tools");
  const remote = join(directory, "remote-cli");
  const desktop = join(directory, "desktop bin");
  await Promise.all([root, tools, remote, desktop].map((path) => mkdir(path)));
  await copyFile(resolve(__dirname, "../../start.sh"), join(root, "start.sh"));
  for (const [name, target] of [
    ["node", process.execPath],
    ["bash", "/bin/bash"],
    ["dirname", "/usr/bin/dirname"],
    ["env", "/usr/bin/env"],
  ] as const) {
    await symlink(target, join(tools, name));
  }
  const log = join(directory, "commands.log");
  const command = async (path: string, content: string): Promise<void> => {
    await writeFile(path, `#!/bin/bash\nset -eu\n${content}\n`);
    await chmod(path, 0o755);
  };
  if (options.npm !== false) {
    await command(
      join(tools, "npm"),
      'printf "npm %s\\n" "$*" >> "$COMMAND_LOG"\nexit "${NPM_EXIT_CODE:-0}"',
    );
  }
  await command(
    join(remote, "code"),
    "echo 'Remote CLI was used' >&2; exit 99",
  );
  if (options.desktop !== false) {
    await command(
      join(desktop, "code"),
      'printf "code cwd=%s hook=%s\\n" "$PWD" "${VSCODE_IPC_HOOK_CLI-unset}" >> "$COMMAND_LOG"\n' +
        'printf "%s\\n" "$@" >> "$COMMAND_LOG"',
    );
  }
  if (options.installed) {
    for (const dependency of [
      "typescript/bin/tsc",
      "@github/copilot-sdk/package.json",
      "markdown-it/package.json",
      "@vscode/markdown-it-katex/package.json",
    ]) {
      const path = join(root, "node_modules", dependency);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, "");
    }
  }
  const runWithEnvironment = (
    environment: NodeJS.ProcessEnv,
    ...args: string[]
  ) =>
    exec("/bin/bash", [join(root, "start.sh"), ...args], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: [remote, desktop, tools].join(":"),
        COMMAND_LOG: log,
        VSCODE_IPC_HOOK_CLI: "restricted-remote-hook",
        START_VERBOSE: "",
        NPM_EXIT_CODE: "0",
        ...environment,
      },
    });
  return {
    root,
    log,
    runWithEnvironment,
    run: (...args: string[]) => runWithEnvironment({}, ...args),
  };
}

test(
  "launcher help needs no prerequisites and does not install or launch",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { npm: false, desktop: false });
    for (const flag of ["--help", "-h"]) {
      const { stdout, stderr } = await launcher.run(flag);
      assert.match(stdout, /Usage: \.\/start\.sh/);
      assert.match(stdout, /source checkout parent, not the current directory/);
      assert.match(stdout, /\.\/start\.sh \/path\/to\/repositories --wait/);
      assert.equal(stderr, "");
    }
    await assert.rejects(readFile(launcher.log), { code: "ENOENT" });
  },
);

test(
  "launcher starts with no arguments using the checkout parent",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { installed: true });
    const { stderr } = await launcher.run();
    assert.match(stderr, /Checking prerequisites/);
    assert.match(stderr, /Dependencies already installed/);
    assert.match(stderr, /Compiling TypeScript \(incremental/);
    assert.match(stderr, /Compilation finished/);
    assert.match(stderr, /Launching VS Code/);
    assert.match(stderr, /\[start \+\d+s\]/);
    assert.deepEqual(
      (await readFile(launcher.log, "utf8")).trim().split("\n"),
      [
        "npm run compile -- --incremental --tsBuildInfoFile dist/start.tsbuildinfo",
        `code cwd=${launcher.root} hook=unset`,
        "--new-window",
        "--disable-extensions",
        `--extensionDevelopmentPath=${launcher.root}`,
        dirname(launcher.root),
      ],
    );
  },
);

test(
  "launcher defaults to the checkout parent regardless of cwd and builds from its own directory",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { installed: true });
    await launcher.run("--wait");
    assert.deepEqual(
      (await readFile(launcher.log, "utf8")).trim().split("\n"),
      [
        "npm run compile -- --incremental --tsBuildInfoFile dist/start.tsbuildinfo",
        `code cwd=${launcher.root} hook=unset`,
        "--new-window",
        "--disable-extensions",
        `--extensionDevelopmentPath=${launcher.root}`,
        "--wait",
        dirname(launcher.root),
      ],
    );
  },
);

test(
  "launcher opens an explicitly chosen parent directory rather than the source checkout",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { installed: true });
    await launcher.run(launcher.root, "--wait");
    assert.deepEqual(
      (await readFile(launcher.log, "utf8")).trim().split("\n").slice(-2),
      ["--wait", launcher.root],
    );
  },
);

test(
  "launcher restores missing dependencies before compiling",
  bashOnly,
  async (t) => {
    const launcher = await setup(t);
    await launcher.run();
    assert.match(
      await readFile(launcher.log, "utf8"),
      /^npm ci\nnpm run compile -- --incremental --tsBuildInfoFile dist\/start\.tsbuildinfo\ncode /,
    );
  },
);

test(
  "launcher keeps command tracing off by default and identifies compilation failures",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { installed: true });
    const { stderr } = await launcher.run();
    assert.doesNotMatch(stderr, /\+ npm run compile/);
    await assert.rejects(
      launcher.runWithEnvironment({ NPM_EXIT_CODE: "7" }),
      /Failed at line .*npm run compile.*exit 7/,
    );

    assert.equal(
      (await readFile(launcher.log, "utf8")).match(/code cwd=/g)?.length,
      1,
    );
  },
);

test("launcher can enable command tracing", bashOnly, async (t) => {
  const launcher = await setup(t, { installed: true });
  const { stderr } = await launcher.runWithEnvironment({
    START_VERBOSE: "1",
  });
  assert.match(stderr, /\+ npm run compile/);
  assert.match(stderr, /Compiling TypeScript/);
});

test(
  "launcher fails explicitly when only the restricted remote CLI is available",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { desktop: false });
    await assert.rejects(
      launcher.run(),
      /remote VS Code CLI cannot launch an extension development window/,
    );
    await assert.rejects(readFile(launcher.log), { code: "ENOENT" });
  },
);

test(
  "launcher reports missing prerequisites before installing or launching",
  bashOnly,
  async (t) => {
    const launcher = await setup(t, { npm: false });
    await assert.rejects(launcher.run(), /Required command not found: npm/);
    await assert.rejects(readFile(launcher.log), { code: "ENOENT" });
  },
);
