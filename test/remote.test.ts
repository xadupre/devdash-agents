import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseApplicationMessage } from "../src/application";
import { executeLocalTool, type LocalToolHost } from "../src/local-tools";
import { LocalWorker } from "../src/local-worker";
import {
  inspectRemoteModel,
  parseRemoteMachines,
  remoteInvocation,
  remoteRepositoryPath,
  splitCommandLine,
  type RemoteMachine,
} from "../src/remote";
import { ensureRemoteWorker } from "../src/remote-worker";

const posix = process.platform !== "win32";
const connection = `"${process.execPath}" "${join(__dirname, "fixtures", "remote-shell.js")}"`;
// Like `az ssh vm`, this connection always exits with status 0.
const lossyConnection = `sh -c '"$0" "$@"; exit 0' "${process.execPath}" "${join(__dirname, "fixtures", "remote-shell.js")}"`;

const machine: RemoteMachine = {
  name: "azure-vm",
  command:
    "az ssh vm --ip 192.0.2.10 --subscription 00000000-0000-0000-0000-000000000001",
  workerPath: "devdash-genai-worker",
  modelPath: "/home/azureuser/models/phi",
  repositoriesPath: "/home/azureuser/github",
};

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devdash-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("remote invocations quote the remote command after the connection arguments", () => {
  assert.deepEqual(remoteInvocation(machine, ["/opt/worker", "it's"]), {
    executable: "az",
    args: [
      "ssh",
      "vm",
      "--ip",
      "192.0.2.10",
      "--subscription",
      "00000000-0000-0000-0000-000000000001",
      "--",
      `'/opt/worker' 'it'\\''s'`,
    ],
  });
  assert.deepEqual(splitCommandLine(`ssh -i "my key" 'user@host'`), [
    "ssh",
    "-i",
    "my key",
    "user@host",
  ]);
  assert.throws(() => splitCommandLine(`ssh "host`), /Unterminated/);
  assert.equal(
    remoteRepositoryPath(machine, "/local/src/devdash-agents"),
    "/home/azureuser/github/devdash-agents",
  );
});

test("remote machine settings are validated before being saved", () => {
  assert.deepEqual(
    parseApplicationMessage({
      type: "remote-machines",
      machines: [machine],
      selected: "azure-vm",
    }),
    { type: "remote-machines", machines: [machine], selected: "azure-vm" },
  );
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "remote-machines",
        machines: [machine],
        selected: "other",
      }),
    /configured execution machine/,
  );
  assert.throws(
    () => parseRemoteMachines([machine, machine]),
    /must be unique/,
  );
  assert.throws(
    () => parseRemoteMachines([{ ...machine, modelPath: "models/phi" }]),
    /must be absolute/,
  );
  assert.throws(
    () => parseRemoteMachines([{ ...machine, command: "az\nrm" }]),
    /Invalid connection command/,
  );
});

test(
  "remote tools read, search, edit and run commands inside the remote repository",
  { skip: !posix },
  async (t) => {
    const root = await directory(t);
    const repository = join(root, "repository");
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "src", "main.ts"), "const value = 1;\n");
    await writeFile(join(root, "secret.txt"), "secret\n");
    await symlink(join(root, "secret.txt"), join(repository, "escape.txt"));
    await symlink(
      join(repository, "src", "main.ts"),
      join(repository, "link.ts"),
    );
    const permissions: string[] = [];
    const host: LocalToolHost = {
      repositoryPath: repository,
      remote: { name: "test-vm", command: connection },
      requestPermission: async (permission) => {
        permissions.push(permission.kind);
        return true;
      },
    };
    const signal = new AbortController().signal;
    assert.equal(
      await executeLocalTool(
        { name: "read_file", arguments: { path: "src/main.ts" } },
        host,
        signal,
      ),
      "const value = 1;\n",
    );
    for (const path of ["../secret.txt", "/etc/passwd"])
      await assert.rejects(
        executeLocalTool(
          { name: "read_file", arguments: { path } },
          host,
          signal,
        ),
        /inside the repository|repository-relative/,
      );
    await assert.rejects(
      executeLocalTool(
        { name: "read_file", arguments: { path: "escape.txt" } },
        host,
        signal,
      ),
      /resolves outside the repository/,
    );
    assert.equal(
      await executeLocalTool(
        { name: "search_files", arguments: { query: "value" } },
        host,
        signal,
      ),
      "src/main.ts:1: const value = 1;",
    );
    await assert.rejects(
      executeLocalTool(
        {
          name: "edit_file",
          arguments: { path: "link.ts", oldText: "1", newText: "2" },
        },
        host,
        signal,
      ),
      /symbolic links/,
    );
    assert.match(
      await executeLocalTool(
        {
          name: "edit_file",
          arguments: { path: "src/main.ts", oldText: "1", newText: "it's 2" },
        },
        host,
        signal,
      ),
      /Updated .*main\.ts on test-vm/,
    );
    assert.equal(
      await readFile(join(repository, "src", "main.ts"), "utf8"),
      "const value = it's 2;\n",
    );
    assert.equal(
      await executeLocalTool(
        {
          name: "run_command",
          arguments: {
            program: "sh",
            args: ["-c", 'pwd; echo "$1"', "sh", "a b"],
          },
        },
        host,
        signal,
      ),
      `${repository}\na b\n`,
    );
    await assert.rejects(
      executeLocalTool(
        {
          name: "run_command",
          arguments: { program: "sh", args: ["-c", "echo failed >&2; exit 3"] },
        },
        host,
        signal,
      ),
      /Command failed \(3\): failed/,
    );
    assert.deepEqual(permissions, ["write", "shell", "shell"]);
  },
);

test(
  "remote failures are detected when the connection hides the exit status",
  { skip: !posix },
  async (t) => {
    const repository = await directory(t);
    const host: LocalToolHost = {
      repositoryPath: repository,
      remote: { name: "test-vm", command: lossyConnection },
      requestPermission: async () => true,
    };
    const signal = new AbortController().signal;
    await assert.rejects(
      executeLocalTool(
        { name: "read_file", arguments: { path: "missing.ts" } },
        host,
        signal,
      ),
      /Local tool path does not exist/,
    );
    await assert.rejects(
      executeLocalTool(
        {
          name: "run_command",
          arguments: { program: "sh", args: ["-c", "echo out; exit 4"] },
        },
        host,
        signal,
      ),
      /Command failed \(4\): out/,
    );
  },
);

test(
  "a remote edit is refused when the file changed while awaiting approval",
  { skip: !posix },
  async (t) => {
    const repository = await directory(t);
    const file = join(repository, "main.ts");
    await writeFile(file, "value = 1;\n");
    const host: LocalToolHost = {
      repositoryPath: repository,
      remote: { name: "test-vm", command: connection },
      requestPermission: async () => {
        await writeFile(file, "value = 1; // changed\n");
        return true;
      },
    };
    await assert.rejects(
      executeLocalTool(
        {
          name: "edit_file",
          arguments: { path: "main.ts", oldText: "1", newText: "2" },
        },
        host,
        new AbortController().signal,
      ),
      /File changed while awaiting approval/,
    );
    assert.equal(await readFile(file, "utf8"), "value = 1; // changed\n");
  },
);

test(
  "remote models are inspected and served through the connection command",
  { skip: !posix },
  async (t) => {
    const root = await directory(t);
    const model = join(root, "phi");
    await mkdir(model);
    await writeFile(
      join(model, "genai_config.json"),
      JSON.stringify({ model: { context_length: 4096 } }),
    );
    const remote = { command: connection, modelPath: model };
    const inspected = await inspectRemoteModel(remote);
    assert.equal(inspected.directory, model);
    assert.equal(inspected.info.name, "phi");
    assert.equal(inspected.info.contextLength, 4096);
    assert.ok(inspected.info.sizeBytes > 0);
    await assert.rejects(
      inspectRemoteModel({ ...remote, modelPath: join(root, "missing") }),
      /Remote model directory does not exist/,
    );

    const worker = join(root, "worker");
    await writeFile(
      worker,
      `#!/bin/sh\nexec "${process.execPath}" "${join(__dirname, "fixtures", "local-worker.js")}" "$@"\n`,
    );
    await chmod(worker, 0o755);
    const { executable, args } = remoteInvocation(remote, [worker]);
    const local = new LocalWorker(executable, args, 30_000, undefined, true);
    t.after(() => local.stop());
    assert.deepEqual(await local.discover(), [
      { provider: "cpu", deviceId: 0, name: "CPU" },
    ]);
  },
);

test(
  "remote workers are found, or built once from the shipped sources",
  { skip: !posix },
  async (t) => {
    const home = await directory(t);
    const native = join(await directory(t), "native");
    await mkdir(join(native, "src"), { recursive: true });
    await writeFile(join(native, "CMakeLists.txt"), "");
    await writeFile(join(native, "src", "main.cpp"), "");
    const setup = join(native, "setup-worker.sh");
    await writeFile(
      setup,
      'root=$(cd "$(dirname "$0")/.." && pwd); mkdir -p "$root/build/native"; printf "#!/bin/sh\\n" > "$root/build/native/devdash-genai-worker"; chmod +x "$root/build/native/devdash-genai-worker"\n',
    );
    const previous = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      process.env.HOME = previous;
    });
    const remote = { name: "vm", command: connection };

    await assert.rejects(
      ensureRemoteWorker(
        { ...remote, workerPath: "/opt/missing-worker" },
        { nativeDirectory: native },
      ),
      /Worker executable not found on this machine: \/opt\/missing-worker/,
    );

    let installs = 0;
    const options = {
      nativeDirectory: native,
      onInstall: () => installs++,
    };
    const worker = { ...remote, workerPath: "devdash-genai-worker" };
    const built = await ensureRemoteWorker(worker, options);
    assert.match(
      built,
      /\/\.cache\/devdash-agents\/engine\/[0-9a-f]{16}\/build\/native\/devdash-genai-worker$/,
    );
    assert.ok(built.startsWith(home));
    assert.equal(await ensureRemoteWorker(worker, options), built);
    assert.equal(installs, 1);

    await writeFile(setup, "echo 'cmake: not found' >&2; exit 1\n");
    await assert.rejects(
      ensureRemoteWorker(worker, options),
      /Building the worker failed \(log: .*setup\.log\): cmake: not found/,
    );
  },
);
