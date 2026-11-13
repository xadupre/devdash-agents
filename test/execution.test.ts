import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assignSession,
  machineModelSource,
  machineRepositoryPath,
  parseExecutionConfiguration,
  parseSessionAssignment,
  type ExecutionConfiguration,
  type MachineConfiguration,
  type WorkerConfiguration,
} from "../src/execution";
import { parseApplicationMessage, AgentApplication } from "../src/application";
import { ApplicationStorage } from "../src/storage";
import { CopilotConversation } from "../src/conversation";
import {
  prepareRemoteModel,
  uploadRemoteModel,
} from "../src/remote-model-source";
import { inspectRemoteModel } from "../src/remote";
import { LocalConversation } from "../src/local-conversation";
import { LocalWorker } from "../src/local-worker";
import { runCommand } from "../src/github";
import { exportSessionJson } from "../src/session-export";

const connection = `"${process.execPath}" "${join(__dirname, "fixtures", "remote-shell.js")}"`;
const local: MachineConfiguration = {
  id: "local",
  name: "This computer",
  command: "",
  repositoriesPath: "/projects",
  modelsPath: "/models",
  workerPath: "devdash-genai-worker",
  cliPath: "copilot",
};
const remote: MachineConfiguration = {
  ...local,
  id: "gpu",
  name: "GPU host",
  command: connection,
};
const worker: WorkerConfiguration = {
  id: "inference",
  name: "Qwen CUDA",
  backend: "local",
  machineId: "gpu",
  model: { kind: "model-id", source: "Qwen/Qwen3-0.6B" },
  provider: "cuda",
  deviceId: 1,
};
const config: ExecutionConfiguration = {
  machines: [
    local,
    remote,
    { ...remote, id: "same-host", name: "Same physical host" },
  ],
  workers: [
    worker,
    {
      ...worker,
      id: "copilot",
      backend: "copilot",
      machineId: "local",
      model: { kind: "copilot", source: "fixture" },
    },
  ],
};

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devdash-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("machines allow repeated connections and workers bind one model and device", () => {
  assert.deepEqual(parseExecutionConfiguration(config), config);
  assert.deepEqual(
    parseApplicationMessage({
      type: "execution-configuration",
      requestId: "save-1",
      configuration: config,
    }),
    {
      type: "execution-configuration",
      requestId: "save-1",
      configuration: config,
    },
  );
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "execution-configuration",
        configuration: config,
      }),
    /configuration request/,
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "worker-foundry-models",
      requestId: "r-1",
      device: "gpu",
    }),
    { type: "worker-foundry-models", requestId: "r-1", device: "gpu" },
  );
  for (const invalid of [
    { requestId: "r-1", device: "npu" },
    { device: "cpu" },
  ])
    assert.throws(
      () =>
        parseApplicationMessage({ type: "worker-foundry-models", ...invalid }),
      /Foundry catalogue request/,
    );
  const choice = {
    workerId: "inference",
    workerMachineId: "gpu",
    executionMachineId: "local",
  };
  assert.deepEqual(
    parseApplicationMessage({
      type: "assignment-choice",
      requestId: "r-1",
      choice,
    }),
    { type: "assignment-choice", requestId: "r-1", choice },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "assignment-choice", requestId: "r-1" }),
    { type: "assignment-choice", requestId: "r-1" },
  );
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "assignment-choice",
        requestId: "r-1",
        choice: { ...choice, workerMachineId: "" },
      }),
    /session assignment choice/,
  );
  const assigned = assignSession(config, "inference", "local");
  assert.equal(assigned.workerMachine.id, "gpu");
  assert.equal(assigned.executionMachine.id, "local");
  assert.equal(assigned.worker.deviceId, 1);
  assigned.worker.model.source = "another/model";
  assert.equal(config.workers[0]!.model.source, "Qwen/Qwen3-0.6B");
  const moved = assignSession(config, "inference", "local", "local");
  assert.equal(moved.workerMachine.id, "local");
  assert.equal(moved.worker.machineId, "local");
  assert.equal(config.workers[0]!.machineId, "gpu");
  assert.deepEqual(parseSessionAssignment(moved), moved);
  // Copilot follows the harness machine whatever worker machine is requested.
  const copilot = assignSession(config, "copilot", "gpu", "local");
  assert.equal(copilot.workerMachine.id, "gpu");
  assert.equal(copilot.worker.machineId, "gpu");
  assert.throws(
    () => assignSession(config, "inference", "local", "missing"),
    /worker machine/,
  );
  assert.throws(
    () => assignSession(config, "missing", "local"),
    /configured worker/,
  );
  assert.equal(
    machineRepositoryPath(remote, "/elsewhere/repository"),
    "/projects/repository",
  );
  assert.equal(
    machineModelSource(remote, "qwen/model.onnx"),
    "/models/qwen/model.onnx",
  );
  assert.equal(machineModelSource(remote, "/other/model"), "/other/model");
  assert.throws(() => machineModelSource(remote, "../outside"), /inside/);
});

test("invalid machine, worker and persisted assignments fail explicitly", () => {
  for (const machines of [
    [remote],
    [local, local],
    [local, { ...remote, command: "" }],
    [local, { ...remote, modelsPath: "relative" }],
    [local, { ...remote, command: 'ssh "unterminated' }],
  ])
    assert.throws(() => parseExecutionConfiguration({ ...config, machines }));
  for (const [patch, message] of [
    [{ machineId: "unknown" }, /Unknown machine for worker Qwen CUDA/],
    [{ deviceId: -1 }, /"Qwen CUDA": device index .* not -1/],
    [{ deviceId: 0.5 }, /device index .* not 0\.5/],
    [{ provider: "other" }, /"Qwen CUDA": device must be CPU or CUDA/],
    [
      { model: { kind: "model-id", source: "--help" } },
      /"--help" is not a Hugging Face model ID/,
    ],
    [
      { model: { kind: "foundry", source: "Phi-4-mini" } },
      /"Phi-4-mini" is not a Foundry catalogue model ID; expected "azureml:/,
    ],
    [{ model: { kind: "copilot", source: "fixture" } }, /only Copilot workers/],
    [{ model: { kind: "file", source: "" } }, /enter a model path or ID/],
  ] as const)
    assert.throws(
      () =>
        parseExecutionConfiguration({
          ...config,
          workers: [{ ...worker, ...patch }],
        }),
      message,
    );
  const assignment = assignSession(config, "inference", "local");
  assert.throws(
    () => parseSessionAssignment({ ...assignment, workerMachine: local }),
    /Inconsistent/,
  );
});

test("session assignments reach factories and survive disk persistence, New and parallel requests", async (t) => {
  const root = await directory(t);
  const repository = join(root, "alpha");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeFile(join(repository, "scenario"), "persist");
  const assignment = assignSession(config, "copilot", "local");
  const received: unknown[] = [];
  const create = (
    saved?: Awaited<ReturnType<ApplicationStorage["load"]>>,
  ): AgentApplication =>
    new AgentApplication(
      root,
      (repo, _request, _view, binding) => {
        received.push(binding);
        return new CopilotConversation({
          cliPath: join(__dirname, "fixtures", "copilot.js"),
          workingDirectory: repo.path,
          timeoutMs: 5000,
        });
      },
      () => {},
      saved,
    );
  const application = create();
  t.after(() => application.dispose());
  await application.refresh();
  await application.openSession(repository, assignment);
  await application.send(repository, "First request");
  await assert.rejects(
    application.changeModel(repository, "other"),
    /bound to one worker model/,
  );
  assert.deepEqual(received[0], assignment);
  assert.deepEqual(
    application.getState().repositories[0]!.sessions![0]!.assignment,
    assignment,
  );
  await application.closeSession(repository);
  const storage = new ApplicationStorage(root, root);
  await storage.save(application.getSnapshot());
  const restored = create(await storage.load());
  t.after(() => restored.dispose());
  await restored.refresh();
  assert.deepEqual(restored.getAssignment(repository), assignment);
  await restored.openSession(repository);
  assert.deepEqual(received.at(-1), assignment);
  await restored.newSession(repository);
  assert.deepEqual(restored.getAssignment(repository), assignment);
  await Promise.all([
    restored.send(repository, "Main request"),
    restored.send(repository, "Parallel request", true),
  ]);
  assert.ok(received.length >= 4);
  assert.deepEqual(received.at(-1), assignment);
  const another = structuredClone(assignment);
  another.worker.id = "another";
  await restored.closeSession(repository);
  await restored.addCopilotSession(repository, another);
  assert.equal(restored.getState().repositories[0]!.sessions!.length, 2);
  assert.deepEqual(restored.getAssignment(repository), another);
  await writeFile(join(repository, "history-outside-session.json"), "[]");
  await restored.resumeSession(repository, "outside-session", another);
  assert.deepEqual(restored.getAssignment(repository), another);
  assert.deepEqual(received.at(-1), another);
  const nativeConfiguration = structuredClone(config);
  nativeConfiguration.workers[0]!.machineId = "local";
  nativeConfiguration.workers[0]!.provider = "cpu";
  nativeConfiguration.workers[0]!.deviceId = 0;
  const native = assignSession(nativeConfiguration, "inference", "local");
  const setup = {
    assignment: native,
    prepare: async () => {},
    create: () =>
      new LocalConversation(
        new LocalWorker(process.execPath, [
          join(__dirname, "fixtures", "local-worker.js"),
        ]),
        "/model",
        "cpu",
        0,
      ),
  };
  await restored.openLocalSession(
    repository,
    setup.create,
    setup.prepare,
    true,
    native,
  );
  await restored.newSession(repository, setup);
  assert.deepEqual(restored.getAssignment(repository), native);
  await storage.save(restored.getSnapshot());
  assert.deepEqual(
    (await storage.load())!.sessions[0]!.localSessions![0]!.assignment,
    native,
  );
});

test("deleting many archived sessions reuses one CLI per worker assignment", async (t) => {
  const root = await directory(t);
  const repository = join(root, "alpha");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeFile(join(repository, "scenario"), "persist");
  const first = assignSession(config, "copilot", "local");
  const second = structuredClone(first);
  second.worker.id = "other";
  const history = Array.from({ length: 40 }, (_, index) => ({
    backend: "copilot" as const,
    sessionId: `saved-${index}`,
    assignment: index % 2 ? first : second,
    draft: "",
    messages: [],
  }));
  for (const entry of history)
    await writeFile(join(repository, `history-${entry.sessionId}.json`), "[]");
  let created = 0;
  const application = new AgentApplication(
    root,
    (repo) => {
      created++;
      return new CopilotConversation({
        cliPath: join(__dirname, "fixtures", "copilot.js"),
        workingDirectory: repo.path,
        timeoutMs: 5000,
      });
    },
    () => {},
    {
      version: 1,
      root,
      sessions: [{ id: repository, ...history[0]!, history: history.slice(1) }],
    },
  );
  t.after(() => application.dispose());
  await application.refresh();
  await application.deleteSessions(repository, true);
  assert.equal(created, 2);
  const requests = (await readFile(join(repository, "requests.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    requests.filter((entry) => entry.method === "session.delete").length,
    40,
  );
});

test(
  "remote Copilot SDK runs the CLI and its session in the execution repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const host = join(root, "extension-host");
    const target = join(root, "remote repository ' literal");
    await Promise.all([mkdir(host), mkdir(target)]);
    await writeFile(join(target, "scenario"), "persist");
    const cli = join(root, "copilot");
    await writeFile(
      cli,
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(__dirname, "fixtures", "copilot.js").replaceAll("'", "'\\''")}' "$@"\n`,
    );
    await chmod(cli, 0o755);
    const conversation = new CopilotConversation({
      cliPath: cli,
      workingDirectory: host,
      model: "fixture",
      timeoutMs: 5000,
      remote: { command: connection, workingDirectory: target },
    });
    t.after(() => conversation.dispose());
    await conversation.start(AbortSignal.timeout(10_000));
    await conversation.send("Remote request", AbortSignal.timeout(10_000));
    await conversation.dispose();
    assert.deepEqual(await readdir(host), []);
    const requests = (await readFile(join(target, "requests.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(
      requests.find((request) => request.method === "session.create").params
        .workingDirectory,
      target,
    );
    assert.match(JSON.stringify(requests), /Remote request/);
    const pid = Number(await readFile(join(target, "pid"), "utf8"));
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      await delay(10);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "remote models accept files and stream Foundry packages into machine storage",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "genai_config.json"),
      '{"model":{"context_length":4096}}',
    );
    await writeFile(join(source, "weights.onnx"), "weights");
    const machine = { ...remote, modelsPath: join(root, "remote models") };
    const signal = AbortSignal.timeout(15_000);
    const prepared = await prepareRemoteModel(
      machine,
      { ...worker, model: { kind: "file", source } },
      join(source, "weights.onnx"),
      signal,
    );
    assert.equal(prepared, await realpath(source));
    const uploaded = await uploadRemoteModel(
      machine,
      source,
      "catalogue-id",
      signal,
    );
    assert.equal(
      await readFile(join(uploaded, "weights.onnx"), "utf8"),
      "weights",
    );
    assert.equal(
      await uploadRemoteModel(machine, source, "catalogue-id", signal),
      uploaded,
    );
    const inspected = await inspectRemoteModel(
      { command: connection, modelPath: uploaded },
      signal,
    );
    assert.equal(inspected.info.contextLength, 4096);
    await assert.rejects(
      prepareRemoteModel(
        machine,
        { ...worker, model: { kind: "file", source: "missing" } },
        join(root, "missing"),
        signal,
      ),
      /Model source does not exist/,
    );
  },
);

test(
  "remote checkpoint and model-ID exports use the worker provider and machine storage",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const bin = join(root, "bin");
    await mkdir(bin);
    const builder = join(bin, "python3");
    await writeFile(
      builder,
      `#!/bin/sh
arguments=$(printf '%s\\n' "$@")
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; output=$1; fi
  shift
done
printf '%s\\n' "$arguments" > "$output/build-arguments"
printf '{}' > "$output/genai_config.json"
`,
    );
    await chmod(builder, 0o755);
    const machine = {
      ...remote,
      modelsPath: join(root, "exports"),
      command: `env "PATH=${bin}:${process.env.PATH}" ${connection}`,
    };
    const signal = AbortSignal.timeout(10_000);
    const exported = await prepareRemoteModel(
      machine,
      worker,
      worker.model.source,
      signal,
    );
    assert.equal(exported.startsWith(await realpath(machine.modelsPath)), true);
    const args = await readFile(join(exported, "build-arguments"), "utf8");
    assert.match(args, /-m\nQwen\/Qwen3-0.6B\n/);
    assert.match(args, /-e\ncuda\n/);
    assert.equal(
      await prepareRemoteModel(machine, worker, worker.model.source, signal),
      exported,
    );
    const checkpoint = join(root, "checkpoint");
    await mkdir(checkpoint);
    await writeFile(join(checkpoint, "config.json"), "{}");
    const converted = await prepareRemoteModel(
      machine,
      {
        ...worker,
        provider: "cpu",
        model: { kind: "checkpoint", source: checkpoint },
      },
      checkpoint,
      signal,
    );
    assert.match(
      await readFile(join(converted, "build-arguments"), "utf8"),
      /-i\n.*checkpoint\n/,
    );
    assert.deepEqual(await readdir(checkpoint), ["config.json"]);
  },
);

test(
  "local inference can use a separate remote execution machine for repository discovery",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const repository = join(root, "tools");
    const marker = join(root, "connection-used");
    await mkdir(repository);
    await writeFile(join(repository, "remote-only.txt"), "hello");
    const localWorker = new LocalWorker(process.execPath, [
      join(__dirname, "fixtures", "local-worker.js"),
    ]);
    const conversation = new LocalConversation(
      localWorker,
      "/model",
      "cpu",
      0,
      {
        repositoryPath: repository,
        remote: {
          name: "tools",
          command: `${connection} --record "${marker}"`,
        },
        requestPermission: async () => true,
      },
    );

    t.after(() => conversation.dispose());
    await conversation.start(AbortSignal.timeout(10_000));
    assert.equal(await readFile(marker, "utf8"), "connected");
    await conversation.send("Hello", AbortSignal.timeout(10_000));
  },
);

test(
  "session exports inspect the assigned execution clone rather than the extension-host clone",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await directory(t);
    const repositories = join(root, "remote");
    const repository = join(repositories, "alpha");
    await mkdir(repository, { recursive: true });
    const signal = AbortSignal.timeout(15_000);
    await runCommand("git", ["init"], repository, signal);
    await writeFile(join(repository, "tracked.txt"), "before\n");
    await runCommand("git", ["add", "tracked.txt"], repository, signal);
    await runCommand(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Initial",
      ],
      repository,
      signal,
    );
    await writeFile(join(repository, "tracked.txt"), "after on remote\n");
    const configuration = structuredClone(config);
    configuration.machines[1]!.repositoriesPath = repositories;
    const assignment = assignSession(configuration, "inference", "gpu");
    const output = JSON.parse(
      await exportSessionJson(
        {
          repository: {
            id: "alpha",
            name: "Alpha",
            path: join(root, "missing-local", "alpha"),
          },
          conversation: {
            backend: "local",
            assignment,
            draft: "",
            messages: [],
          },
        },
        signal,
      ),
    );
    assert.match(output.diff, /\+after on remote/);
    assert.deepEqual(output.assignment, assignment);
    assert.equal(output.diffSource.type, "working-tree");
  },
);

test("stop-local-worker messages name one host", () => {
  assert.deepEqual(
    parseApplicationMessage({ type: "stop-local-worker", hostId: "h-1" }),
    { type: "stop-local-worker", hostId: "h-1" },
  );
  assert.throws(
    () =>
      parseApplicationMessage({ type: "stop-local-worker", hostId: "../x" }),
    /local model host/,
  );
  for (const workerId of ["copilot-gpu", ""])
    assert.deepEqual(
      parseApplicationMessage({ type: "stop-copilot-worker", workerId }),
      { type: "stop-copilot-worker", workerId },
    );
  assert.throws(
    () =>
      parseApplicationMessage({ type: "stop-copilot-worker", workerId: "a/b" }),
    /Copilot worker/,
  );
});
