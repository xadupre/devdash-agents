import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bashOnly = { skip: process.platform === "win32" };
const installerScript = resolve("install.sh");
const cleanupScript = resolve("clean.sh");

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "arranged-scripts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function executable(path: string, lines: string[]): Promise<void> {
  await writeFile(
    path,
    ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n"),
  );
  await chmod(path, 0o755);
}

async function installerFixture(t: TestContext, nvidia = true) {
  const directory = await temporaryDirectory(t);
  const tools = join(directory, "tools with spaces");
  await mkdir(tools);
  for (const name of ["mktemp", "rm"]) {
    const { stdout } = await exec("/bin/bash", [
      "-c",
      'command -v "$1"',
      "bash",
      name,
    ]);
    await symlink(stdout.trim(), join(tools, name));
  }
  const downloadLog = join(directory, "download.log");
  const installLog = join(directory, "install.log");
  await executable(join(tools, "uname"), [
    'case "$1" in',
    '  -s) printf "%s\\n" "$TEST_OS" ;;',
    '  -m) printf "%s\\n" "$TEST_ARCH" ;;',
    "esac",
  ]);
  if (nvidia) {
    await executable(join(tools, "nvidia-smi"), [
      '[[ "$1" == -L ]]',
      'if [[ "$NVIDIA_STATE" != gpu ]]; then exit 1; fi',
      'printf "GPU 0: NVIDIA test device\\n"',
    ]);
  }
  await executable(join(tools, "curl"), [
    'printf "%s\\n" "$@" > "$DOWNLOAD_LOG"',
    'if [[ "$DOWNLOAD_EXIT" != 0 ]]; then echo "download failed" >&2; exit "$DOWNLOAD_EXIT"; fi',
    '[[ "$1" == -fL && "$2" == --retry && "$3" == 3 && "$4" == -o ]]',
    'printf "local VSIX" > "$5"',
  ]);
  await executable(join(tools, "code"), [
    'printf "%s\\n" "$@" > "$INSTALL_LOG"',
    '[[ -f "$2" ]]',
    'exit "$INSTALL_EXIT"',
  ]);
  return {
    downloadLog,
    installLog,
    run: (environment: NodeJS.ProcessEnv = {}) =>
      exec("/bin/bash", [installerScript], {
        cwd: directory,
        env: {
          PATH: tools,
          TMPDIR: directory,
          CODE: join(tools, "code"),
          TEST_OS: "Linux",
          TEST_ARCH: "x86_64",
          NVIDIA_STATE: "none",
          DOWNLOAD_EXIT: "0",
          INSTALL_EXIT: "0",
          DOWNLOAD_LOG: downloadLog,
          INSTALL_LOG: installLog,
          ...environment,
        },
      }),
  };
}

test(
  "installer selects CPU or CUDA packages matching the host",
  bashOnly,
  async (t) => {
    const installer = await installerFixture(t);
    for (const [os, arch, gpu, target, variant] of [
      ["Linux", "x86_64", "none", "linux-x64", "cpu"],
      ["Linux", "x86_64", "gpu", "linux-x64", "cuda"],
      ["MINGW64_NT-10.0", "amd64", "none", "win32-x64", "cpu"],
      ["MINGW64_NT-10.0", "amd64", "gpu", "win32-x64", "cuda"],
      ["Darwin", "arm64", "gpu", "darwin-arm64", "cpu"],
    ]) {
      await installer.run({
        TEST_OS: os,
        TEST_ARCH: arch,
        NVIDIA_STATE: gpu,
      });
      const download = (await readFile(installer.downloadLog, "utf8"))
        .trim()
        .split("\n");
      const file = download[4];
      assert.ok(file);
      assert.equal(
        download[5],
        `https://github.com/xadupre/arranged-agents/releases/latest/download/arranged-agents-${target}-${variant}.vsix`,
      );
      assert.deepEqual(
        (await readFile(installer.installLog, "utf8")).trim().split("\n"),
        ["--install-extension", file, "--force"],
      );
      await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
    }
  },
);

test("installer selects CPU when nvidia-smi is absent", bashOnly, async (t) => {
  const installer = await installerFixture(t, false);
  await installer.run();
  assert.match(
    await readFile(installer.downloadLog, "utf8"),
    /arranged-agents-linux-x64-cpu\.vsix/,
  );
});

test(
  "installer rejects hosts without a native package before downloading",
  bashOnly,
  async (t) => {
    const installer = await installerFixture(t);
    for (const [os, arch, message] of [
      ["FreeBSD", "x86_64", /Unsupported operating system/],
      ["Linux", "ppc64", /Unsupported architecture/],
      ["Linux", "aarch64", /No native package available for linux-arm64/],
      ["MSYS_NT-10.0", "arm64", /No native package available for win32-arm64/],
      ["Darwin", "x86_64", /No native package available for darwin-x64/],
    ] as const) {
      await assert.rejects(
        installer.run({ TEST_OS: os, TEST_ARCH: arch }),
        message,
      );
    }
    await assert.rejects(readFile(installer.downloadLog), { code: "ENOENT" });
  },
);

test(
  "installer reports download failures without silently falling back to CPU",
  bashOnly,
  async (t) => {
    const installer = await installerFixture(t);
    await assert.rejects(
      installer.run({ NVIDIA_STATE: "gpu", DOWNLOAD_EXIT: "22" }),
      /Failed to download arranged-agents-linux-x64-cuda\.vsix/,
    );
    const download = (await readFile(installer.downloadLog, "utf8"))
      .trim()
      .split("\n");
    const file = download[4];
    assert.ok(file);
    await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
    await assert.rejects(readFile(installer.installLog), { code: "ENOENT" });
  },
);

test(
  "installer reports missing VS Code and propagates installation failures",
  bashOnly,
  async (t) => {
    const installer = await installerFixture(t);
    await assert.rejects(
      installer.run({ CODE: "/missing-vscode" }),
      /VS Code CLI .* not found/,
    );
    await assert.rejects(readFile(installer.downloadLog), { code: "ENOENT" });
    await assert.rejects(installer.run({ INSTALL_EXIT: "9" }), { code: 9 });
    const file = (await readFile(installer.installLog, "utf8"))
      .trim()
      .split("\n")[1];
    assert.ok(file);
    await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
  },
);

test(
  "clean removes node_modules and build outputs in an isolated checkout",
  bashOnly,
  async (t) => {
    const directory = await temporaryDirectory(t);
    const root = join(directory, "checkout with spaces");
    const origin = join(directory, "origin.git");
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    await exec("git", ["init", "--quiet", "--bare", origin], {
      cwd: directory,
      env,
    });
    await exec("git", ["init", "--quiet", "--initial-branch=main", root], {
      cwd: directory,
      env,
    });
    await exec("git", ["remote", "add", "origin", origin], { cwd: root, env });
    for (const name of ["build", "dist", "node_modules"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "generated"), "generated");
    }
    await writeFile(join(root, "preserved"), "source");
    await exec("/bin/bash", [cleanupScript], { cwd: root, env });
    for (const name of ["build", "dist", "node_modules"]) {
      await assert.rejects(stat(join(root, name)), { code: "ENOENT" });
    }
    assert.equal(await readFile(join(root, "preserved"), "utf8"), "source");
  },
);
