import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKER,
  findWorkerOnPath,
  installEngine,
  LocalWorker,
  resolveWorkerExecutable,
  workerEnvironment,
} from "../src/local-worker";

function worker(mode = "", timeout = 5000): LocalWorker {
  return new LocalWorker(
    process.execPath,
    [join(__dirname, "fixtures", "local-worker.js"), mode],
    timeout,
  );
}

function reductionWorker(mode = "normal"): LocalWorker {
  return new LocalWorker(process.execPath, [
    "-e",
    `
      const readline = require("node:readline");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      let active;
      readline.createInterface({input: process.stdin}).on("line", (line) => {
        const r = JSON.parse(line);
        if (r.method === "stop") { send({id:r.id,type:"stopped"}); process.exit(); }
        else if (r.method === "cancel") {
          send({id:r.id,type:"cancelled"});
          send({id:active.id,type:"error",code:"cancelled",message:"reduction cancelled"});
        } else if (r.method === "reduceContext") {
          active = r;
          if (${JSON.stringify(mode)} === "wait") return;
          if (${JSON.stringify(mode)} === "error") {
            send({id:r.id,type:"error",code:"insufficient_context",message:"too small"});
            return;
          }
          const messages = ${JSON.stringify(mode)} === "invalid" ? [{role:"tool",content:"bad"}] :
            ${JSON.stringify(mode)} === "too-many" ? Array.from({length:256}, () => ({role:"user",content:"x"})) :
            [{role:"user",content:JSON.stringify(r)}];
          send({id:r.id,type:"reduced",messages,cacheTokens:17});
        }
      });
    `,
  ]);
}

test("reduces context with isolated session options and returns replacement history", async (t) => {
  const client = reductionWorker();
  t.after(() => client.stop());
  const messages = [{ role: "user" as const, content: "old history" }];
  for (const mode of ["sliding", "compress"] as const) {
    const result = await client.reduceContext(
      messages,
      mode,
      undefined,
      1024,
      "repo",
    );
    const request = JSON.parse(result.messages[0]!.content) as Record<
      string,
      unknown
    >;
    assert.deepEqual(request.messages, messages);
    assert.equal(request.mode, mode);
    assert.equal(request.session, "repo");
    assert.equal(request.maxLength, 1024);
    assert.equal(result.cacheTokens, 17);
  }
});

test("rejects malformed reduction output and reports insufficient context", async (t) => {
  const malformed = reductionWorker("invalid");
  const tooMany = reductionWorker("too-many");
  const small = reductionWorker("error");
  t.after(() => Promise.all([malformed.stop(), tooMany.stop(), small.stop()]));
  await assert.rejects(
    malformed.reduceContext([], "sliding"),
    /Invalid local worker context reduction/,
  );
  await assert.rejects(
    tooMany.reduceContext([], "sliding"),
    /Invalid local worker context reduction/,
  );
  await assert.rejects(
    small.reduceContext([], "compress"),
    /insufficient_context: too small/,
  );
});

test("aborts reduction through cancel without terminating the shared worker", async (t) => {
  const client = reductionWorker("wait");
  t.after(() => client.stop());
  const controller = new AbortController();
  const pending = client.reduceContext([], "compress", controller.signal);
  controller.abort(new Error("cancel reduction"));
  await assert.rejects(pending, /cancel reduction/);
  // stop must still receive its normal terminal event, not a closed-worker error.
  await client.stop();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("already aborted"));
  await assert.rejects(
    client.reduceContext([], "sliding", alreadyAborted.signal),
    /already aborted/,
  );
});

test("installs the engine and reports setup failures with their output", async () => {
  await installEngine(process.execPath, ["-e", "process.exit(0)"]);
  await assert.rejects(
    installEngine(process.execPath, [
      "-e",
      "console.error('no compiler'); process.exit(3)",
    ]),
    /Installing local models failed \(3\): no compiler/,
  );
});

test("cancelling engine setup terminates its subprocess group", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Installer setup is supported on Linux");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "devdash-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child.pid");
  const controller = new AbortController();
  const setup = installEngine(
    "/bin/sh",
    ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
    controller.signal,
  );
  let childPid = 0;
  for (let attempt = 0; attempt < 100 && !childPid; attempt++) {
    if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, "utf8"));
    if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    Number.isSafeInteger(childPid) && childPid > 0,
    "setup did not start its child process",
  );
  controller.abort(new Error("setup cancelled"));
  await assert.rejects(setup, /setup cancelled/);
  let state: string | undefined;
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
      state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") throw error;
      state = undefined;
      break;
    }
    if (state === "Z" || state === "X") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    state === undefined || state === "Z" || state === "X",
    `setup child is still running (${state})`,
  );
});

test("finds an executable worker on PATH", (t) => {
  if (process.platform === "win32") {
    t.skip("Uses POSIX executable permissions");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "devdash-worker-path-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, DEFAULT_WORKER);
  symlinkSync(process.execPath, executable);
  assert.equal(findWorkerOnPath(directory, "linux"), executable);
  assert.equal(findWorkerOnPath("", "linux"), undefined);
});

test("explains how to configure a missing worker executable", async (t) => {
  const client = new LocalWorker("/__devdash_missing_worker__");
  t.after(() => client.stop());
  await assert.rejects(
    client.discover(),
    /Local models are not installed on this computer \(missing: \/__devdash_missing_worker__\)\. Automatic installation is available/,
  );
});

test("uses the worker built in the extension tree unless a path is configured", () => {
  const built = join("/ext", "build", "native", "devdash-genai-worker");
  const present = (path: string) => path === built;
  if (process.platform !== "win32") {
    assert.equal(resolveWorkerExecutable("", "/ext", present), built);
    assert.equal(
      resolveWorkerExecutable("devdash-genai-worker", "/ext", present),
      built,
    );
  }
  assert.equal(
    resolveWorkerExecutable("/custom/worker", "/ext", present),
    "/custom/worker",
  );
  assert.equal(
    resolveWorkerExecutable("", "/ext", () => false),
    "devdash-genai-worker",
  );
});

test("uses a bundled runtime without requiring a source checkout or a worker on PATH", () => {
  const bundled = join(
    "/installed-extension",
    "runtime",
    "bin",
    process.platform === "win32" ? `${DEFAULT_WORKER}.exe` : DEFAULT_WORKER,
  );
  assert.equal(
    resolveWorkerExecutable(
      "",
      "/installed-extension",
      (path) => path === bundled,
    ),
    bundled,
  );
  assert.equal(
    resolveWorkerExecutable(
      "/external/npu-worker",
      "/installed-extension",
      () => true,
    ),
    "/external/npu-worker",
  );
});

test("puts the WSL GPU driver first only under WSL", () => {
  const wsl = (path: string) => path === "/usr/lib/wsl/lib";
  assert.equal(
    workerEnvironment({}, "linux", wsl).LD_LIBRARY_PATH,
    "/usr/lib/wsl/lib",
  );
  assert.equal(
    workerEnvironment({ LD_LIBRARY_PATH: "" }, "linux", wsl).LD_LIBRARY_PATH,
    "/usr/lib/wsl/lib",
  );
  assert.equal(
    workerEnvironment({ LD_LIBRARY_PATH: "/a" }, "linux", wsl).LD_LIBRARY_PATH,
    "/usr/lib/wsl/lib:/a",
  );
  const already = { LD_LIBRARY_PATH: "/a:/usr/lib/wsl/lib" };
  assert.equal(
    workerEnvironment(already, "linux", wsl).LD_LIBRARY_PATH,
    "/usr/lib/wsl/lib:/a",
  );
  const first = { LD_LIBRARY_PATH: "/usr/lib/wsl/lib:/a" };
  assert.equal(workerEnvironment(first, "linux", wsl), first);
  const native = { LD_LIBRARY_PATH: "/a" };
  assert.equal(
    workerEnvironment(native, "linux", () => false),
    native,
  );
  assert.equal(workerEnvironment(native, "win32", wsl), native);
});

test("discovers, loads, streams UTF-8 across chunks, and stops a child worker", async (t) => {
  const client = worker();
  t.after(() => client.stop());
  const devices = await client.discover();
  assert.deepEqual(devices, [{ provider: "cpu", deviceId: 0, name: "CPU" }]);
  assert.deepEqual(await client.load("/models/chat", "cpu", 0), devices[0]);
  let text = "";
  await client.generate("Hello", (token) => (text += token));
  assert.equal(text, "Hello 世界");
  let chat = "";
  const first = await client.generateChat(
    [{ role: "user", content: "Hello" }],
    (token) => (chat += token),
    undefined,
    undefined,
    "conversation-a",
  );
  assert.equal(chat, text);
  assert.deepEqual(first, {
    cachedTokens: 0,
    generatedTokens: 2,
    cacheTokens: 3,
  });
  const second = await client.generateChat(
    [{ role: "user", content: "Hello again" }],
    () => {},
    undefined,
    undefined,
    "conversation-a",
  );
  assert.deepEqual(second, {
    cachedTokens: 3,
    generatedTokens: 2,
    cacheTokens: 6,
  });
  const isolated = await client.generateChat(
    [{ role: "user", content: "Hello" }],
    () => {},
    undefined,
    undefined,
    "conversation-b",
  );
  assert.equal(isolated.cachedTokens, 0);
  await client.release("conversation-a");
  await client.release("conversation-a");
  assert.equal(
    (
      await client.generateChat(
        [{ role: "user", content: "Hello" }],
        () => {},
        undefined,
        undefined,
        "conversation-a",
      )
    ).cachedTokens,
    0,
  );
  await client.stop();
  await client.stop();
  await assert.rejects(client.discover(), /stopped/);
});

test("reports a model failure without replacing the requested model", async (t) => {
  const client = worker();
  t.after(() => client.stop());
  await assert.rejects(client.load("broken"), /load_failed: Invalid model/);
  assert.equal((await client.load("requested-model")).provider, "cpu");
});

test("cancels the active generation and permits a subsequent request", async (t) => {
  const client = worker("cancel");
  t.after(() => client.stop());
  const controller = new AbortController();
  const result = client.generate(
    "prompt",
    () => controller.abort(),
    controller.signal,
  );
  await assert.rejects(result, { name: "AbortError" });
  assert.equal((await client.discover()).length, 1);
});

test("separate worker instances isolate identical session IDs and cancellation", async (t) => {
  const first = worker("cancel");
  const second = worker();
  t.after(() => Promise.all([first.stop(), second.stop()]));
  await Promise.all([
    first.load("/first-model", "cpu", 0),
    second.load("/second-model", "cpu", 0),
  ]);
  const controller = new AbortController();
  let entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve));
  const messages = [{ role: "user" as const, content: "Hello" }];
  const pending = assert.rejects(
    first.generateChat(
      messages,
      () => entered(),
      controller.signal,
      undefined,
      "same-session-id",
    ),
    { name: "AbortError" },
  );
  await running;
  const generate = () =>
    second.generateChat(
      messages,
      () => {},
      undefined,
      undefined,
      "same-session-id",
    );
  assert.equal((await generate()).cachedTokens, 0);
  controller.abort();
  await pending;
  await first.stop();
  assert.deepEqual(await generate(), {
    cachedTokens: 3,
    generatedTokens: 2,
    cacheTokens: 6,
  });
});

test("does not submit an already aborted request", async (t) => {
  const client = worker();
  t.after(() => client.stop());
  await assert.rejects(client.discover(AbortSignal.abort()), {
    name: "AbortError",
  });
  assert.equal((await client.discover()).length, 1);
});

for (const method of ["discover", "load"] as const) {
  test(`preserves the abort reason and terminates an in-flight ${method}`, async (t) => {
    for (const reason of [undefined, new Error("custom abort"), "cancelled"]) {
      const client = worker("hang");
      t.after(() => client.stop());
      const controller = new AbortController();
      const result =
        method === "discover"
          ? client.discover(controller.signal)
          : client.load("/model", "cpu", 0, controller.signal);
      const rejected = assert.rejects(result, (error: unknown) => {
        assert.strictEqual(error, controller.signal.reason);
        return true;
      });
      controller.abort(reason);
      await rejected;
      await client.stop();
      await assert.rejects(client.discover(), /stopped/);
    }
  });
}

test("aborting one operation reports worker termination to other pending requests", async (t) => {
  const client = worker("hang");
  t.after(() => client.stop());
  const other = assert.rejects(client.discover(), /operation aborted/);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    client.load("/model", "cpu", 0, controller.signal),
    { name: "AbortError" },
  );
  controller.abort();
  await Promise.all([other, cancelled]);
  await client.stop();
});

for (const [mode, pattern] of [
  ["crash", /runtime unavailable/],
  ["malformed", /JSON|Unexpected token/],
  ["oversized", /exceeds 1 MiB/],
  ["invalid-device", /Invalid .*discovery/],
  ["hang", /timed out/],
] as const) {
  test(`rejects ${mode} worker responses without hanging`, async (t) => {
    const client = worker(mode, mode === "hang" ? 300 : 5000);
    t.after(() => client.stop());
    await assert.rejects(client.discover(), pattern);
  });
}

test("rejects oversized requests before writing them", async (t) => {
  const client = worker();
  t.after(() => client.stop());
  await assert.rejects(
    client.generate("x".repeat(1024 * 1024), () => {}),
    /exceeds/,
  );
  assert.equal((await client.discover()).length, 1);
});
