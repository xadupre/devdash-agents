import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  askCopilot,
  listCopilotModels,
  listCopilotSessions,
  requestTimeoutMs,
  type CopilotOptions,
} from "../src/copilot";
import { CopilotConversation } from "../src/conversation";
import { permissionHandler } from "../src/permissions";
import { waitForRequest } from "./helpers";
import {
  generatePostMortem,
  postMortemResponseSchema,
} from "../src/postmortem";

const fixture = join(__dirname, "fixtures", "copilot.js");

async function setup(
  t: TestContext,
  scenario = "success",
): Promise<CopilotOptions> {
  const directory = await mkdtemp(join(tmpdir(), "devdash-agents-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "scenario"), scenario);
  return { cliPath: fixture, workingDirectory: directory, timeoutMs: 5_000 };
}

async function assertStopped(options: CopilotOptions): Promise<void> {
  const pid = Number(
    await readFile(join(options.workingDirectory, "pid"), "utf8"),
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("request timeout settings default to one hour and reject invalid or overflowing timers", () => {
  assert.equal(requestTimeoutMs(), 3_600_000);
  assert.equal(requestTimeoutMs(1), 60_000);
  assert.equal(requestTimeoutMs(90), 5_400_000);
  assert.equal(requestTimeoutMs(35791), 2_147_460_000);
  for (const value of [0, -1, 1.5, 35792, NaN, Infinity, "60", null, true]) {
    assert.throws(() => requestTimeoutMs(value), /requestTimeoutMinutes/);
  }
});

test("model listing uses a temporary CLI, hides disabled models and stops it", async (t) => {
  const options = await setup(t);
  assert.deepEqual(await listCopilotModels(options), [
    { id: "fixture", name: "Fixture model" },
    { id: "other", name: "other" },
  ]);
  await assertStopped(options);
});

test("session listing filters by repository root, hides remote sessions and sorts newest first", async (t) => {
  const options = await setup(t);
  assert.deepEqual(await listCopilotSessions(options), [
    {
      sessionId: "newer",
      summary: "Fix the build",
      modifiedTime: new Date("2026-01-04T00:00:00.000Z"),
    },
    {
      sessionId: "older",
      modifiedTime: new Date("2026-01-02T00:00:00.000Z"),
      branch: "main",
    },
  ]);
  const requests = (
    await readFile(join(options.workingDirectory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    requests.find((request) => request.method === "session.list")?.params,
    { filter: { gitRoot: options.workingDirectory } },
  );
  await assertStopped(options);
});

test("an open conversation reads the updated timeout once for each operation", async (t) => {
  const options = await setup(t, "hang:session.sendAndWait");
  let timeoutMs = 10_000;
  let reads = 0;
  const conversation = new CopilotConversation({
    ...options,
    get timeoutMs() {
      reads++;
      return timeoutMs;
    },
  });
  t.after(() => conversation.dispose());
  const signal = new AbortController().signal;
  await conversation.start(signal);
  timeoutMs = 75;
  await assert.rejects(
    conversation.send("Use the new deadline", signal),
    /timed out after 75ms/,
  );
  assert.equal(reads, 2);
  await assertStopped(options);
});

test("concurrent repository instances keep separate CLI processes, prompts and lifetimes", async (t) => {
  const firstOptions = await setup(t, "hang:session.sendAndWait");
  const secondOptions = await setup(t, "persist");
  const first = new CopilotConversation(firstOptions);
  const second = new CopilotConversation(secondOptions);
  t.after(() => Promise.all([first.dispose(), second.dispose()]));
  const controller = new AbortController();
  const signal = new AbortController().signal;
  await Promise.all([first.start(controller.signal), second.start(signal)]);
  assert.notEqual(first.sessionId, second.sessionId);
  const pids = await Promise.all(
    [firstOptions, secondOptions].map((options) =>
      readFile(join(options.workingDirectory, "pid"), "utf8"),
    ),
  );
  assert.notEqual(pids[0], pids[1]);
  const pending = assert.rejects(
    first.send("Only the first repository", controller.signal),
    { name: "AbortError" },
  );
  await waitForRequest(firstOptions.workingDirectory, "session.sendAndWait");
  await second.send("Only the second repository", signal);
  controller.abort();
  await pending;
  await first.dispose();
  await assertStopped(firstOptions);
  await second.send("Continue after closing the first instance", signal);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          secondOptions.workingDirectory,
          `history-${second.sessionId}.json`,
        ),
        "utf8",
      ),
    ),
    ["Only the second repository", "Continue after closing the first instance"],
  );
  await second.dispose();
  await assertStopped(secondOptions);
});

test("PostMortem analysis uses a real isolated SDK client without tools or discovery and deletes its completed session", async (t) => {
  const options = await setup(t, "postmortem");
  const report = await generatePostMortem(
    {
      repository: {
        id: options.workingDirectory,
        name: "Example",
        path: options.workingDirectory,
      },
      messages: [
        { role: "user", content: "Build a feature" },
        { role: "assistant", content: "Committed abcdef0123456789" },
      ],
    },
    (prompt, signal) =>
      askCopilot(prompt, {
        ...options,
        signal,
        analysisOnly: true,
        responseSchema: postMortemResponseSchema,
      }),
    new AbortController().signal,
  );
  assert.equal(report.sourceCount, 2);
  assert.equal(report.rows.length, 1);
  const requests: { method: string; params: Record<string, unknown> }[] = (
    await readFile(join(options.workingDirectory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  const create = requests.find(
    (request) => request.method === "session.create",
  );
  assert.ok(create);
  assert.deepEqual(create.params.availableTools, []);
  for (const flag of [
    "enableConfigDiscovery",
    "enableSkills",
    "enableOnDemandInstructionDiscovery",
    "enableHostGitOperations",
    "interactiveUser",
  ])
    assert.equal(create.params[flag], false);
  assert.deepEqual(
    requests.find((request) => request.method === "session.sendAndWait")?.params
      .responseFormat,
    {
      type: "json_schema",
      jsonSchema: {
        name: "response",
        strict: true,
        schema: postMortemResponseSchema,
      },
    },
  );
  assert.equal(
    requests.find((request) => request.method === "session.delete")?.params
      .sessionId,
    create.params.sessionId,
  );
  assert.ok(
    (await readdir(options.workingDirectory)).every(
      (name) => !name.startsWith("history-"),
    ),
  );
  await assertStopped(options);
});

test("resolves the CLI through PATH and preserves repository tools, Git context and native instructions", async (t) => {
  const options = await setup(t);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dirname(fixture)}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  });
  assert.equal(
    await askCopilot("Question only", {
      ...options,
      cliPath: basename(fixture),
    }),
    "## Fixture answer",
  );
  const requests: { method: string; params: Record<string, unknown> }[] = (
    await readFile(join(options.workingDirectory, "requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  const create = requests.find(
    (request) => request.method === "session.create",
  );
  assert.ok(create);
  assert.equal(create.params.workingDirectory, options.workingDirectory);
  assert.equal(create.params.availableTools, undefined);
  assert.equal(create.params.interactiveUser, true);
  for (const flag of [
    "enableConfigDiscovery",
    "enableHostGitOperations",
    "enableSkills",
    "enableOnDemandInstructionDiscovery",
  ]) {
    assert.equal(create.params[flag], true, flag);
  }
  for (const flag of ["enableFileHooks", "enableSessionStore"]) {
    assert.equal(create.params[flag], false, flag);
  }
  assert.equal(
    (create.params.systemMessage as { mode: string }).mode,
    "append",
  );
  const send = requests.find(
    (request) => request.method === "session.sendAndWait",
  );
  assert.ok(send);
  assert.equal(send.params.prompt, "Question only");
  assert.equal(send.params.attachments, undefined);
  await assertStopped(options);
});

test("the permission policy automatically answers file reads through the real SDK", async (t) => {
  const options = await setup(t, "permission");
  const answer = await askCopilot("Read the repository", {
    ...options,
    onPermissionRequest: permissionHandler({
      isActive: () => true,
      approvedOrigins: () => [],
      rememberOrigin: async () =>
        assert.fail("File reads must not save URL consent"),
      ask: async () => assert.fail("File reads must not prompt the user"),
    }),
  });
  assert.equal(answer, "Repository access approved");
  await assertStopped(options);
});

for (const approve of [false, true]) {
  test(`repository tool permission is ${approve ? "approved by the host" : "denied without a host confirmation"}`, async (t) => {
    const options = await setup(t, "permission");
    let confirmations = 0;
    const answer = await askCopilot("Read the repository", {
      ...options,
      onPermissionRequest: approve
        ? (request) => {
            assert.equal(request.kind, "read");
            confirmations++;
            return { kind: "approve-once" };
          }
        : undefined,
    });
    assert.equal(
      answer,
      approve ? "Repository access approved" : "Repository access denied",
    );
    assert.equal(confirmations, approve ? 1 : 0);
    await assertStopped(options);
  });
}

for (const stage of [
  "connect",
  "session.create",
  "session.sendAndWait",
  "session.detach",
  "runtime.shutdown",
]) {
  test(`cancels a CLI stuck in ${stage} and reaps its child process`, async (t) => {
    const options = await setup(t, `hang:${stage}`);
    const controller = new AbortController();
    const result = askCopilot("Question", {
      ...options,
      signal: controller.signal,
    });
    const rejected = assert.rejects(result, { name: "AbortError" });
    try {
      await waitForRequest(options.workingDirectory, stage);
    } finally {
      controller.abort();
      await rejected;
    }
    await assertStopped(options);
  });

  test(`times out a CLI stuck in ${stage} and reaps its child process`, async (t) => {
    const options = await setup(t, `hang:${stage}`);
    await assert.rejects(
      askCopilot("Question", { ...options, timeoutMs: 2_000 }),
      /timed out|Timeout/,
    );
    await assertStopped(options);
  });
}

for (const [scenario, model, expected] of [
  ["unauthenticated", undefined, /Not authenticated/],
  ["success", "invalid-model", /Invalid model/],
  ["empty", undefined, /returned no answer/],
] as const) {
  test(`reports ${scenario === "success" ? model : scenario} errors and reaps the CLI`, async (t) => {
    const options = await setup(t, scenario);
    await assert.rejects(
      askCopilot("Question", { ...options, model }),
      expected,
    );
    await assertStopped(options);
  });
}

test("rejects a missing CLI and a pre-cancelled request without spawning", async (t) => {
  const options = await setup(t);
  await assert.rejects(
    askCopilot("Question", {
      ...options,
      cliPath: join(options.workingDirectory, "missing-cli"),
    }),
    /executable not found/,
  );
  await assert.rejects(
    askCopilot("Question", {
      ...options,
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
  await assert.rejects(readFile(join(options.workingDirectory, "pid")), {
    code: "ENOENT",
  });
});
