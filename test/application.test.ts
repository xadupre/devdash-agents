import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AgentApplication,
  parseApplicationMessage,
  type ApplicationState,
} from "../src/application";
import { CopilotConversation } from "../src/conversation";
import { LocalConversation } from "../src/local-conversation";
import { LocalWorker, type LocalChatMessage } from "../src/local-worker";
import { ApplicationStorage, type SavedApplication } from "../src/storage";
import { testImage, waitForRequest } from "./helpers";
import { describePermission } from "../src/presentation";
import { runCommand } from "../src/github";
import { collectSessionDiff } from "../src/session-export";
import {
  generatePostMortem,
  type PostMortemProgress,
  type PostMortemSource,
} from "../src/postmortem";

const analysePostMortem = (
  source: PostMortemSource,
  signal: AbortSignal,
  onProgress?: (progress: PostMortemProgress) => void,
) =>
  generatePostMortem(
    source,
    async (prompt) => {
      const entries: unknown[] = JSON.parse(prompt.split("\n").at(-1)!);
      return JSON.stringify({
        rows: [
          {
            first: 1,
            last: entries.length,
            phase: "Delivery",
            objective: "Complete the task",
            production: "Agent answers, commands and changes",
            filesAndCommits: "As recorded",
            validation: "Recorded validation",
            errors: "Recorded errors and corrections",
          },
        ],
      });
    },
    signal,
    onProgress,
  );

test("local session messages preserve explicit targets and reject malformed identities", () => {
  for (const message of [
    { type: "new-local-session", id: "alpha" },
    { type: "add-session", id: "alpha" },
    { type: "select-session", id: "alpha", view: "copilot:slot-2" },
    { type: "new-session", id: "alpha", view: "copilot:slot-2" },
    { type: "close-session", id: "alpha", view: "copilot:slot-2" },
    { type: "send", id: "alpha", question: "hello", view: "copilot:slot-2" },
    { type: "select-local-session", id: "alpha", localSessionId: "slot-2" },
    { type: "send", id: "alpha", question: "hello", view: "local:slot-2" },
    { type: "draft", id: "alpha", text: "draft", view: "local:slot-2" },
    { type: "cancel", id: "alpha", view: "local:slot-2" },
    {
      type: "reduce-context",
      id: "alpha",
      mode: "sliding",
      view: "local:slot-2",
    },
  ]) {
    const parsed = parseApplicationMessage(message);
    for (const [key, value] of Object.entries(message))
      assert.equal(Reflect.get(parsed, key), value);
  }
  for (const view of [
    "local:",
    "local:bad id",
    "local:../../other",
    `local:${"x".repeat(101)}`,
  ])
    assert.throws(() =>
      parseApplicationMessage({
        type: "send",
        id: "alpha",
        question: "hello",
        view,
      }),
    );
  assert.throws(() =>
    parseApplicationMessage({
      type: "select-local-session",
      id: "alpha",
      localSessionId: "",
    }),
  );
});

test("Add keeps Copilot sessions independent and New replaces only the selected session", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "First Copilot conversation");
  application.setDraft(alpha, "First draft", "copilot");
  const firstId = application.getSnapshot().sessions[0]!.sessionId;
  await application.addCopilotSession(alpha);
  const secondView = application.getState().repositories[0]!.view!;
  assert.match(secondView, /^copilot:/);
  await application.send(
    alpha,
    "Second Copilot conversation",
    false,
    undefined,
    secondView,
  );
  application.setDraft(alpha, "Second draft", secondView);
  const snapshot = application.getSnapshot();
  const secondId = snapshot.sessions[0]!.copilotSessions![0]!.sessionId;
  assert.notEqual(firstId, secondId);
  assert.equal(
    application
      .getState()
      .repositories[0]!.sessions!.filter((slot) => slot.open).length,
    2,
  );
  application.selectSession(alpha, "copilot");
  assert.equal(application.getState().draft, "First draft");
  assert.ok(
    application
      .getState()
      .messages.every(
        (message) => message.content !== "Second Copilot conversation",
      ),
  );
  await application.resumeSession(alpha, secondId!);
  assert.equal(application.getState().repositories[0]!.view, secondView);
  assert.equal(application.getState().draft, "Second draft");

  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(restored.getState().repositories[0]!.view, secondView);
  assert.equal(restored.getState().draft, "Second draft");
  assert.ok(
    restored.getState().repositories[0]!.sessions!.every((slot) => !slot.open),
  );
  assert.equal(
    restored.getDatasetSessions().length,
    application.getDatasetSessions().length,
  );
  await restored.resumeSession(alpha, secondId!);
  await restored.send(alpha, "Continue the restored second session");
  assert.equal(restored.getSnapshot().sessions[0]!.sessionId, firstId);
  await restored.closeSession(alpha);

  await application.newSession(alpha);
  const replaced = application.getSnapshot().sessions[0]!;
  assert.equal(replaced.sessionId, firstId);
  assert.notEqual(replaced.copilotSessions![0]!.sessionId, secondId);
  assert.equal(replaced.copilotSessions![0]!.history![0]!.sessionId, secondId);
  application.selectSession(alpha, "copilot");
  assert.equal(application.getState().draft, "First draft");
  await application.closeSession(alpha, secondView);
  const state = application.getState().repositories[0]!;
  assert.equal(state.view, "copilot");
  assert.equal(state.status, "ready");
  assert.equal(
    state.sessions!.find((slot) => slot.view === secondView)!.open,
    false,
  );
  assert.equal(
    state.sessions!.find((slot) => slot.view === "copilot")!.open,
    true,
  );
  await application.resumeSession(alpha, secondId!);
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) => message.content === "Second Copilot conversation",
      ),
  );
  assert.equal(
    application
      .getSnapshot()
      .sessions[0]!.copilotSessions![0]!.history!.some(
        (entry) => entry.sessionId === secondId,
      ),
    false,
  );
  await application.send(alpha, "First session is still available");
  await application.deleteSessions(alpha, true);
  assert.ok(
    application
      .getState()
      .repositories[0]!.sessions!.every((slot) => !slot.open),
  );
  assert.equal(
    application
      .getDatasetSessions()
      .filter((entry) => entry.repository.id === alpha).length,
    0,
  );
});

test("Copilot permissions and cancellation stay with their session after switching views", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const first = application.send(
    alpha,
    "First independent request",
    false,
    undefined,
    "copilot",
  );
  const cancelled = assert.rejects(first, /cancel|abort/i);
  const firstPermission = await waitForPermission(alpha);
  await application.addCopilotSession(alpha);
  const secondView = application.getState().repositories[0]!.view!;
  const second = application.send(
    alpha,
    "Second independent request",
    false,
    undefined,
    secondView,
  );
  const secondPermission = await waitForPermission(alpha, firstPermission.id);
  application.selectSession(alpha, "copilot");
  application.cancel(alpha, "copilot");
  await cancelled;
  assert.deepEqual(
    application.getState().permissions.map((entry) => entry.id),
    [secondPermission.id],
  );
  application.respondToPermission(secondPermission.id, true);
  await second;
  application.selectSession(alpha, secondView);
  assert.equal(application.getState().repositories[0]!.status, "ready");
});

test("multiple local sessions isolate work, drafts and history and promote the oldest remaining editor", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const chats: LocalChatMessage[][][] = [[], []];
  const stopped: number[] = [];
  let entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve));
  const create = (index: number) => () =>
    new LocalConversation(
      {
        load: async () => ({
          provider: "cuda",
          deviceId: index,
          name: `GPU ${index}`,
        }),
        generateChat: async (messages, onToken, signal) => {
          chats[index]!.push(structuredClone(messages));
          if (messages.at(-1)!.content === "hold") {
            entered();
            await new Promise<void>((_resolve, reject) =>
              signal!.addEventListener("abort", () => reject(signal!.reason), {
                once: true,
              }),
            );
          }
          onToken(`answer ${index}`);
        },
        stop: async () => {
          stopped.push(index);
        },
      },
      `/model-${index}`,
    );
  await application.openLocalSession(alpha, create(0));
  const first = application.getState().repositories[0]!.localSession!.id!;
  await application.send(alpha, "first");
  const pending = application.send(
    alpha,
    "hold",
    false,
    undefined,
    `local:${first}`,
  );
  const cancelled = assert.rejects(pending, /abort/i);
  await running;
  const opening = application.openLocalSession(
    alpha,
    create(1),
    undefined,
    true,
  );
  const second = application.getState().repositories[0]!.localSession!.id!;
  application.selectLocalSession(alpha, first);
  assert.equal(application.getState().repositories[0]!.status, "busy");
  await opening;
  application.selectLocalSession(alpha, second);
  assert.notEqual(first, second);
  assert.equal(application.canEditLocalSession(alpha, first), true);
  assert.equal(application.canEditLocalSession(alpha, second), false);
  await application.send(alpha, "second", false, undefined, `local:${second}`);
  application.setDraft(alpha, "first draft", `local:${first}`);
  application.setDraft(alpha, "second draft", `local:${second}`);
  application.cancel(alpha, `local:${first}`);
  await cancelled;
  assert.equal(application.getState().draft, "second draft");
  assert.ok(
    application
      .getState()
      .messages.some((message) => message.content === "answer 1"),
  );
  assert.ok(
    !application
      .getState()
      .messages.some((message) => message.content === "answer 0"),
  );
  assert.deepEqual(chats[1]![0], [{ role: "user", content: "second" }]);
  application.selectLocalSession(alpha, first);
  assert.equal(application.getState().draft, "hold");
  await application.closeSession(alpha);
  assert.deepEqual(stopped, [0]);
  assert.equal(application.canEditLocalSession(alpha, second), true);
  application.selectLocalSession(alpha, second);
  assert.equal(
    application.getState().repositories[0]!.localSession!.readOnly,
    false,
  );
  await application.send(alpha, "next", false, undefined, `local:${second}`);
  assert.deepEqual(chats[1]![1], [
    { role: "user", content: "second" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "next" },
  ]);
  const snapshot = application.getSnapshot();
  assert.equal(snapshot.sessions[0]!.localSessions!.length, 2);
  assert.equal(snapshot.sessions[0]!.view, "local");
  const restored = createApplication(snapshot);
  await restored.refresh();
  assert.deepEqual(
    restored
      .getState()
      .repositories[0]!.localSessions!.map((local) => local.id),
    [first, second],
  );
  assert.equal(restored.getState().repositories[0]!.localSession!.id, second);
  restored.selectLocalSession(alpha, first);
  assert.ok(
    restored
      .getState()
      .messages.some((message) => message.content === "answer 0"),
  );
  assert.equal(
    new Set(restored.getDatasetSessions().map((entry) => entry.recordId)).size,
    restored.getDatasetSessions().length,
  );
  await application.openSession(alpha);
  const copilotSnapshot = application.getSnapshot();
  assert.equal(copilotSnapshot.sessions[0]!.selectedLocalSessionId, second);
  assert.equal(copilotSnapshot.sessions[0]!.view, "copilot");
  const restoredCopilot = createApplication(copilotSnapshot);
  await restoredCopilot.refresh();
  assert.equal(restoredCopilot.getState().repositories[0]!.view, "copilot");
  assert.equal(
    restoredCopilot.getState().repositories[0]!.localSession!.id,
    second,
  );
  restoredCopilot.transferSession(alpha, "copilot");
  assert.equal(
    restoredCopilot.getState().repositories[0]!.view,
    `local:${second}`,
  );
});

test("context actions target the local session even while Copilot is displayed", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const calls: string[] = [];
  let finish: (() => void) | undefined;
  await application.openSession(alpha);
  const copilotId = application.getSnapshot().sessions[0]!.sessionId;
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) => onToken("local answer"),
          reduceContext: async (_messages, mode) => {
            calls.push(mode);
            await new Promise<void>((resolve) => (finish = resolve));
            return {
              messages: [{ role: "user", content: "summary" }],
              cacheTokens: 5,
            };
          },
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "keep this transcript");
  await application.openSession(alpha);
  const displayed = structuredClone(application.getState().messages);
  for (const mode of ["sliding", "compress"] as const) {
    const reducing = application.reduceContext(alpha, mode);
    assert.equal(
      application.getState().repositories[0]!.localSession?.status,
      "busy",
    );
    assert.equal(application.getState().repositories[0]!.managementBusy, true);
    assert.throws(
      () => application.reduceContext(alpha, mode),
      /management operation/,
    );
    await Promise.resolve();
    finish!();
    await reducing;
    assert.equal(
      application.getState().repositories[0]!.localSession?.contextTokens,
      5,
    );
    assert.equal(
      application.getState().repositories[0]!.localSession?.status,
      "ready",
    );
    assert.equal(application.getState().repositories[0]!.managementBusy, false);
    assert.deepEqual(application.getState().messages, displayed);
    assert.equal(application.getSnapshot().sessions[0]!.sessionId, copilotId);
  }
  assert.deepEqual(calls, ["sliding", "compress"]);
});

test("Copilot follow-ups resume after an overlapping local context reduction", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  let finish: (() => void) | undefined;
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) => onToken("local answer"),
          reduceContext: async () => {
            await new Promise<void>((resolve) => (finish = resolve));
            return {
              messages: [{ role: "user", content: "summary" }],
              cacheTokens: 5,
            };
          },
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "local context");
  await application.openSession(alpha);
  const main = application.send(alpha, "Copilot task");
  const permission = await waitForPermission(alpha);
  const queued = application.send(alpha, "Follow up", false);
  const reducing = application.reduceContext(alpha, "compress");
  assert.equal(application.getState().repositories[0]!.status, "busy");
  assert.equal(
    application.getState().repositories[0]!.localSession?.reducingContext,
    true,
  );
  application.respondToPermission(permission.id, true);
  await main;
  assert.equal(application.getState().repositories[0]!.queuedCount, 1);
  finish!();
  await reducing;
  const nextPermission = await waitForPermission(alpha);
  application.respondToPermission(nextPermission.id, true);
  await queued;
  assert.equal(application.getState().repositories[0]!.queuedCount, 0);
});

test("context action errors leave the local session ready and its transcript intact", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  assert.throws(
    () => application.reduceContext(alpha, "sliding"),
    /idle, open local session/,
  );
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) => onToken("answer"),
          reduceContext: async (_messages, mode, signal) => {
            if (mode === "sliding")
              await new Promise<void>((_resolve, reject) =>
                signal!.addEventListener(
                  "abort",
                  () => reject(signal!.reason),
                  { once: true },
                ),
              );
            throw new Error("Not enough context to halve");
          },
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "original");
  const transcript = structuredClone(application.getState().messages);
  await assert.rejects(
    application.reduceContext(alpha, "compress"),
    /Not enough context/,
  );
  assert.equal(application.getState().repositories[0]!.status, "ready");
  assert.deepEqual(application.getState().messages, transcript);
  const reducing = application.reduceContext(alpha, "sliding");
  assert.equal(application.getState().repositories[0]!.status, "busy");
  await Promise.resolve();
  application.cancel(alpha, "local");
  await assert.rejects(reducing, /abort/i);
  assert.equal(application.getState().repositories[0]!.status, "ready");
  assert.deepEqual(application.getState().messages, transcript);
  await application.send(alpha, "still usable");
});

test("both context reductions recover an over-capacity send without restarting the local conversation", async (t) => {
  for (const mode of ["sliding", "compress"] as const) {
    const { application, root } = await setup(t, "persist");
    const alpha = join(root, "alpha");
    const chats: LocalChatMessage[][] = [];
    let loads = 0;
    await application.openLocalSession(
      alpha,
      () =>
        new LocalConversation(
          {
            load: async () => {
              loads++;
              return { provider: "cpu", deviceId: 0, name: "CPU" };
            },
            generateChat: async (messages, onToken) => {
              chats.push(structuredClone(messages));
              if (messages.at(-1)!.content === "too long")
                throw new Error("Prompt exceeds maxLength");
              onToken("answer");
              return { cachedTokens: 0, generatedTokens: 1, cacheTokens: 20 };
            },
            reduceContext: async (messages, requestedMode) => {
              assert.equal(requestedMode, mode);
              assert.deepEqual(messages, [
                { role: "user", content: "original" },
                { role: "assistant", content: "answer" },
              ]);
              return {
                messages: [
                  { role: "user", content: "retained" },
                  { role: "assistant", content: "answer" },
                ],
                cacheTokens: 10,
              };
            },
            stop: async () => {},
          },
          "/model",
        ),
    );
    await application.send(alpha, "original");
    await assert.rejects(application.send(alpha, "too long"), /maxLength/);
    assert.equal(application.getState().repositories[0]!.status, "error");
    assert.equal(
      application.getState().repositories[0]!.localSession?.canReduceContext,
      true,
    );
    await application.reduceContext(alpha, mode);
    assert.equal(application.getState().repositories[0]!.status, "ready");
    await application.send(alpha, "next");
    assert.equal(loads, 1);
    assert.deepEqual(chats[2], [
      { role: "user", content: "retained" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ]);
  }
});

test("context reduction remains blocked after a local model load fails", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await assert.rejects(
    application.openLocalSession(
      alpha,
      () =>
        new LocalConversation(
          {
            load: async () => {
              throw new Error("load failed");
            },
            generateChat: async () => {},
            reduceContext: async () => {
              assert.fail("A failed load cannot reduce context");
            },
            stop: async () => {},
          },
          "/model",
        ),
    ),
    /load failed/,
  );
  assert.equal(
    application.getState().repositories[0]!.localSession?.canReduceContext,
    false,
  );
  assert.throws(
    () => application.reduceContext(alpha, "sliding"),
    /idle, open local session/,
  );
});

test("context reduction messages validate the repository and mode", () => {
  for (const mode of ["sliding", "compress"]) {
    const message = { type: "reduce-context", id: "alpha", mode };
    assert.deepEqual(parseApplicationMessage(message), message);
  }
  for (const invalid of [
    { id: "alpha" },
    { id: "", mode: "sliding" },
    { id: 12, mode: "compress" },
    { id: "alpha", mode: "unknown" },
    { mode: "sliding" },
  ])
    assert.throws(
      () => parseApplicationMessage({ type: "reduce-context", ...invalid }),
      /Invalid context reduction/,
    );
});

test("local and Copilot sessions remain open side by side", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  let stopped = 0;
  const chats: LocalChatMessage[][] = [];
  const worker = {
    load: async () => ({ provider: "cpu" as const, deviceId: 0, name: "CPU" }),
    generateChat: async (
      messages: LocalChatMessage[],
      onToken: (text: string) => void,
    ) => {
      chats.push(messages);
      onToken("local ");
      assert.equal(application.getState().messages.at(-1)?.content, "local ");
      onToken("answer");
      return {
        cachedTokens: 7,
        generatedTokens: 3,
        cacheTokens: 12,
      };
    },
    stop: async () => {
      stopped++;
    },
  };
  await application.openSession(alpha);
  const copilotId = application
    .getSnapshot()
    .sessions.find((s) => s.id === alpha)!.sessionId;
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(worker, "/model", "cpu", 0, undefined, {
        name: "tiny-model",
        sizeBytes: 1572864,
        contextLength: 4096,
      }),
  );
  assert.equal(application.getState().repositories[0]!.backend, "local");
  assert.equal(
    application.getState().repositories[0]!.model,
    "tiny-model (local, CPU 0)",
  );
  assert.ok(
    application
      .getState()
      .logs?.some((entry) =>
        entry.message.includes("Local chat model: /model (cpu"),
      ),
  );
  assert.ok(
    application
      .getState()
      .logs?.some((entry) =>
        entry.message.includes("1.50 MiB (1572864 logical bytes"),
      ),
  );
  await application.send(alpha, "<raw prompt>\n");
  assert.deepEqual(chats, [[{ role: "user", content: "<raw prompt>\n" }]]);
  assert.equal(
    application.getState().messages.filter((m) => m.role === "assistant")
      .length,
    1,
  );
  assert.equal(application.getState().messages.at(-1)?.content, "local answer");
  assert.equal(application.getState().repositories[0]!.generatedTokens, 3);
  const localTimings = application
    .getState()
    .messages.find((message) => message.role === "user")!.timings!;
  assert.ok(localTimings.length > 0);
  assert.equal(localTimings[0]!.outputTokens, 3);
  assert.ok(
    localTimings.every(
      (step) => step.kind === "generation" && step.end !== undefined,
    ),
  );
  assert.equal(application.getState().repositories[0]!.contextTokens, 12);
  assert.equal(application.getState().repositories[0]!.contextLimit, 4096);
  assert.throws(
    () =>
      application.createPostMortem(alpha, async () => {
        throw new Error("Local chat must never be sent to Copilot.");
      }),
    /PostMortem uses Copilot and is disabled/,
  );
  await assert.rejects(
    application.changeModel(alpha, "copilot-model"),
    /new local session/,
  );
  await assert.rejects(
    application.send(alpha, "image", true, [testImage]),
    /does not support images/,
  );
  await application.send(alpha, "follow up");
  assert.deepEqual(chats[1], [
    { role: "user", content: "<raw prompt>\n" },
    { role: "assistant", content: "local answer" },
    { role: "user", content: "follow up" },
  ]);
  await application.restart(alpha);
  assert.equal(application.getState().repositories[0]!.backend, "local");
  await application.send(alpha, "second raw prompt");
  assert.deepEqual(chats[2], [{ role: "user", content: "second raw prompt" }]);
  await application.newSession(alpha);
  assert.equal(application.getState().repositories[0]!.backend, "local");
  await application.send(alpha, "fresh local message");
  assert.deepEqual(chats[3], [
    { role: "user", content: "fresh local message" },
  ]);
  await application.select(beta);
  assert.notEqual(application.getState().repositories[1]!.backend, "local");
  await application.select(alpha);
  await application.openSession(alpha);
  assert.equal(stopped, 2);
  assert.equal(application.getState().repositories[0]!.backend, "copilot");
  assert.equal(
    application.getState().repositories[0]!.localSession?.status,
    "ready",
  );
  const lifecycle = application.getState().logs!.map((entry) => entry.message);
  assert.equal(
    lifecycle.filter(
      (entry) => entry === "Local session ready; shared model available.",
    ).length,
    3,
  );
  assert.ok(
    application
      .getState()
      .logs!.every(
        (entry) =>
          entry.repository === "alpha" &&
          Number.isFinite(Date.parse(entry.timestamp)),
      ),
  );
  assert.equal(
    application.getSnapshot().sessions.find((s) => s.id === alpha)!.sessionId,
    copilotId,
  );
  await application.resumeSession(alpha, copilotId!);
  assert.equal(
    application.getSnapshot().sessions.find((s) => s.id === alpha)!.sessionId,
    copilotId,
  );
});

test("reopening and creating a fresh local session use the newly selected factory", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const makeConversation = (name: string) =>
    new LocalConversation(
      {
        load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
        generateChat: async () => {},
        stop: async () => {},
      },
      `/models/${name}`,
      "cpu",
      0,
      undefined,
      { name, sizeBytes: 0, contextLength: 4096 },
    );
  await application.openLocalSession(alpha, () =>
    makeConversation("first-model"),
  );
  await application.closeSession(alpha);
  await application.openLocalSession(alpha, () =>
    makeConversation("second-model"),
  );
  assert.match(
    application.getState().repositories[0]!.model ?? "",
    /second-model/,
  );
  let prepared = false;
  await application.newSession(alpha, {
    create: () => makeConversation("third-model"),
    prepare: async () => {
      prepared = true;
    },
  });
  assert.equal(prepared, true);
  assert.match(
    application.getState().repositories[0]!.model ?? "",
    /third-model/,
  );
});

test("transferring between local and Copilot preserves both live sessions and targets the other draft", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Copilot question");
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) => onToken("Local answer"),
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "Local question");
  assert.equal(
    application.getState().repositories[0]!.view,
    `local:${application.getState().repositories[0]!.localSession!.id}`,
  );
  application.transferSession(alpha);
  assert.equal(application.getState().repositories[0]!.view, "copilot");
  assert.match(application.getState().draft, /Local question/);
  application.transferSession(alpha);
  assert.equal(
    application.getState().repositories[0]!.view,
    `local:${application.getState().repositories[0]!.localSession!.id}`,
  );
  assert.match(application.getState().draft, /Copilot question/);
  const saved = application.getSnapshot();
  await application.dispose();
  const restored = createApplication(saved);
  await restored.refresh();
  assert.equal(
    restored.getState().repositories[0]!.view,
    `local:${restored.getState().repositories[0]!.localSession!.id}`,
  );
  assert.match(restored.getState().draft, /Copilot question/);
  await restored.openSession(alpha);
  assert.equal(restored.getState().repositories[0]!.view, "copilot");
  assert.ok(
    restored
      .getSnapshot()
      .sessions[0]!.history?.some(
        (entry) =>
          entry.backend === "local" &&
          entry.messages.some(
            (message) => message.content === "Local question",
          ),
      ),
  );
});

test("switching from a saved local conversation resumes its own Copilot identity, draft and transcript", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Cloud-only question");
  application.setDraft(alpha, "Unsent Copilot draft");
  const copilot = application
    .getSnapshot()
    .sessions.find((s) => s.id === alpha)!;
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) =>
            onToken("Private local answer"),
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "Private local question");
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  await application.dispose();
  const restored = createApplication(await storage.load());
  await restored.refresh();
  await restored.openSession(alpha);
  const resumed = restored.getSnapshot().sessions.find((s) => s.id === alpha)!;
  assert.equal(resumed.sessionId, copilot.sessionId);
  assert.equal(resumed.draft, "Unsent Copilot draft");
  assert.equal(resumed.generatedTokens, copilot.generatedTokens);
  assert.ok(
    resumed.messages.some(
      (message) => message.content === "Cloud-only question",
    ),
  );
  assert.ok(
    resumed.messages.every(
      (message) => !message.content.includes("Private local"),
    ),
  );
  assert.equal(
    resumed.history?.filter((entry) => entry.sessionId === copilot.sessionId)
      .length,
    0,
  );
  assert.ok(
    resumed.history?.some(
      (entry) =>
        entry.backend === "local" &&
        entry.messages.some(
          (message) => message.content === "Private local question",
        ),
    ),
  );
  await restored.send(alpha, "Continue the cloud conversation");
  assert.equal(
    restored.getSnapshot().sessions.find((s) => s.id === alpha)!.sessionId,
    copilot.sessionId,
  );
});

test("a failed Copilot resume after local mode preserves both histories without creating a replacement", async (t) => {
  const { root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const application = createApplication({
    version: 1,
    root,
    sessions: [
      {
        id: alpha,
        backend: "local",
        draft: "Private local draft",
        messages: [{ role: "user", content: "Private local question" }],
        history: [
          {
            backend: "copilot",
            sessionId: "missing",
            draft: "Copilot draft",
            messages: [{ role: "user", content: "Copilot question" }],
          },
        ],
      },
    ],
  });
  await application.refresh();
  await assert.rejects(
    application.openSession(alpha),
    /Saved session not found/,
  );
  const saved = application.getSnapshot().sessions.find((s) => s.id === alpha)!;
  assert.equal(saved.sessionId, "missing");
  assert.equal(saved.backend, "copilot");
  assert.equal(saved.draft, "Copilot draft");
  assert.deepEqual(saved.messages, [
    { role: "user", content: "Copilot question" },
  ]);
  assert.equal(saved.history?.at(-1)?.backend, "local");
  assert.equal(saved.history?.at(-1)?.draft, "Private local draft");
  assert.equal(application.getState().repositories[0]!.status, "error");
});

test("restoring and deleting Copilot archives leaves local archives in their own slot", async (t) => {
  const { root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const application = createApplication({
    version: 1,
    root,
    sessions: [
      {
        id: alpha,
        backend: "copilot",
        draft: "",
        messages: [{ role: "user", content: "Current Copilot" }],
        history: [
          {
            backend: "local",
            draft: "older local draft",
            messages: [{ role: "user", content: "Older local archive" }],
          },
          {
            backend: "copilot",
            draft: "",
            messages: [{ role: "user", content: "Older Copilot archive" }],
          },
          {
            backend: "local",
            draft: "local draft",
            messages: [{ role: "user", content: "Current local archive" }],
          },
        ],
      },
    ],
  });
  await application.refresh();
  await application.deleteSessions(alpha, true);
  assert.equal(application.getState().repositories[0]!.backend, "copilot");
  assert.deepEqual(application.getState().messages, []);
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async () => {},
          stop: async () => {},
        },
        "/model",
      ),
  );
  const snapshot = application.getSnapshot().sessions[0]!;
  assert.equal(snapshot.backend, "local");
  assert.ok(
    snapshot.messages.some(
      (message) => message.content === "Current local archive",
    ),
  );
  assert.ok(
    snapshot.history?.some(
      (entry) =>
        entry.backend === "local" &&
        entry.messages.some(
          (message) => message.content === "Older local archive",
        ),
    ),
  );
  assert.ok(
    snapshot.history?.every(
      (entry) =>
        entry.backend === "local" ||
        !entry.messages.some((message) =>
          /Copilot archive/.test(message.content),
        ),
    ),
  );
});

test("local repository edits use the application permission controls", async (t) => {
  const { application, root, waitForPermission } = await setup(t);
  const alpha = join(root, "alpha");
  const file = join(alpha, "notes.txt");
  await writeFile(file, "before\n");
  const toolCall =
    '<devdash_tool_call>{"name":"edit_file","arguments":{"path":"notes.txt","oldText":"before","newText":"after"}}</devdash_tool_call>';
  const worker = {
    load: async () => ({ provider: "cpu" as const, deviceId: 0, name: "CPU" }),
    generateChat: async (
      messages: LocalChatMessage[],
      onToken: (text: string) => void,
    ) => {
      onToken(
        messages.at(-1)?.content.includes("Result for edit_file:")
          ? "I will respect the permission decision."
          : toolCall,
      );
    },
    stop: async () => {},
  };
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(worker, "/model", "cpu", 0, {
        repositoryPath: alpha,
        requestPermission: (description) =>
          application.requestPermission(alpha, description),
      }),
  );

  const deniedSend = application.send(alpha, "Edit the notes");
  const denied = await waitForPermission(alpha);
  assert.equal(denied.source, "Local model");
  assert.equal(denied.kind, "write");
  assert.match(denied.content, /before/);
  assert.equal(await readFile(file, "utf8"), "before\n");
  application.respondToPermission(denied.id, false);
  await deniedSend;
  assert.equal(await readFile(file, "utf8"), "before\n");
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) =>
          message.role === "output" &&
          message.error &&
          message.content.includes("Permission denied"),
      ),
  );

  const approvedSend = application.send(alpha, "Try the edit again");
  const approved = await waitForPermission(alpha);
  application.respondToPermission(approved.id, true);
  await approvedSend;
  assert.equal(await readFile(file, "utf8"), "after\n");
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) =>
          message.role === "output" &&
          !message.error &&
          message.content.includes("Updated"),
      ),
  );
});

test("saved and archived local transcripts retain privacy provenance without auto-loading", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async (_messages, onToken) => onToken("private answer"),
          stop: async () => {},
        },
        "/model",
      ),
  );
  await application.send(alpha, "private archived local message");
  await application.newSession(alpha);
  await application.send(alpha, "private current local message");
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  await application.dispose();
  const saved = await storage.load();
  assert.equal(saved?.sessions[0]!.backend, "local");
  assert.equal(saved?.sessions[0]!.history?.[0]!.backend, "local");
  const restored = createApplication(saved);
  await restored.refresh();
  assert.equal(restored.getState().repositories[0]!.backend, "local");
  assert.equal(restored.getState().repositories[0]!.status, "idle");
  const noCloud = async (): Promise<never> => {
    throw new Error("Local chat must never be sent to Copilot.");
  };
  assert.throws(
    () => restored.createPostMortem(alpha, noCloud),
    /PostMortem uses Copilot and is disabled/,
  );
  await assert.rejects(restored.newSession(alpha), /choose its model again/);
  await assert.rejects(restored.restart(alpha), /choose its model again/);
  assert.equal(restored.getState().repositories[0]!.backend, "local");
  await restored.openSession(alpha);
  assert.equal(restored.getState().repositories[0]!.backend, "copilot");
  await restored.send(alpha, "public Copilot conversation");
  await restored.createPostMortem(alpha, (source, signal, progress) => {
    assert.ok(
      source.messages.every((message) => !message.content.includes("private")),
    );
    return analysePostMortem(source, signal, progress);
  });
  assert.ok(
    restored
      .getSnapshot()
      .sessions[0]!.history?.every(
        (conversation) => conversation.backend === "local",
      ),
  );
  await restored.deleteSessions(alpha, false);
  assert.equal(restored.getState().repositories[0]!.backend, "copilot");
  await restored.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async () => {},
          stop: async () => {},
        },
        "/model",
      ),
  );
  assert.equal(restored.getState().repositories[0]!.backend, "local");
  assert.throws(
    () => restored.createPostMortem(alpha, noCloud),
    /PostMortem uses Copilot and is disabled/,
  );
});

test("local adapter load errors, generation cancellation, and disposal are explicit", async () => {
  let preAbortedStopped = 0;
  const preAborted = new LocalConversation(
    {
      load: async () => {
        throw new Error("load should not run");
      },
      generateChat: async () => {},
      stop: async () => {
        preAbortedStopped++;
      },
    },
    "/model",
  );
  const aborted = new AbortController();
  aborted.abort(new Error("cancelled before startup"));
  await assert.rejects(
    preAborted.start(aborted.signal),
    /cancelled before startup/,
  );
  assert.equal(preAbortedStopped, 1);

  let stopped = 0;
  const failed = new LocalConversation(
    {
      load: async () => {
        throw new Error("Incompatible model/provider");
      },
      generateChat: async () => {},
      stop: async () => {
        stopped++;
      },
    },
    "/bad-model",
    "cuda",
    1,
  );
  await assert.rejects(
    failed.start(new AbortController().signal),
    /Incompatible model/,
  );
  await failed.dispose();
  assert.equal(stopped, 1);
  let started!: () => void;
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  let generationSignal: AbortSignal | undefined;
  const chats: LocalChatMessage[][] = [];
  const conversation = new LocalConversation(
    {
      load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
      generateChat: async (messages, onToken, signal) => {
        chats.push(messages);
        const prompt = messages.at(-1)!.content;
        if (prompt === "template-error")
          throw new Error("Model tokenizer has no chat template");
        if (prompt !== "cancel") {
          onToken("answer");
          return;
        }
        generationSignal = signal;
        onToken("partial");
        started();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
      },
      stop: async () => {
        stopped++;
      },
    },
    "/model",
  );
  const controller = new AbortController();
  await conversation.start(controller.signal);
  await conversation.send("first", controller.signal);
  const sending = conversation.send("cancel", controller.signal);
  await generating;
  controller.abort();
  await assert.rejects(sending, { name: "AbortError" });
  assert.ok(generationSignal?.aborted);
  const signal = new AbortController().signal;
  await assert.rejects(
    conversation.send("template-error", signal),
    /no chat template/,
  );
  await conversation.send("after cancellation and failure", signal);
  assert.deepEqual(chats.at(-1), [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "after cancellation and failure" },
  ]);
  await conversation.dispose();
  await conversation.dispose();
  assert.equal(stopped, 2);
});

test("local model loading is cancellable and retries keep the local backend", async (t) => {
  const { application, root, snapshots } = await setup(t);
  const alpha = join(root, "alpha");
  let loading!: () => void;
  const started = new Promise<void>((resolve) => {
    loading = resolve;
  });
  let first = true;
  const opening = application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async (_path, _provider, _deviceId, signal) => {
            if (first) {
              first = false;
              loading();
              await new Promise<void>((_resolve, reject) => {
                signal!.addEventListener(
                  "abort",
                  () => reject(signal!.reason),
                  {
                    once: true,
                  },
                );
              });
            }
            return { provider: "cpu", deviceId: 0, name: "CPU" };
          },
          generateChat: async () => {},
          stop: async () => {},
        },
        "/model",
      ),
  );
  await started;
  assert.ok(
    application
      .getState()
      .logs?.some((entry) => entry.message === "Preparing local session..."),
  );
  assert.ok(
    snapshots.some((state) => state.repositories[0]!.status === "starting"),
  );
  assert.equal(application.getState().repositories[0]!.managementBusy, true);
  assert.throws(() => application.closeSession(alpha), /already running/);
  await assert.rejects(application.openSession(alpha), /already running/);
  await application.select(join(root, "beta"));
  await application.select(alpha);
  assert.equal(application.getState().activeId, alpha);
  application.cancel(alpha);
  await assert.rejects(opening, { name: "AbortError" });
  assert.ok(
    application
      .getState()
      .logs?.some(
        (entry) => entry.message === "Local session could not be started.",
      ),
  );
  assert.ok(
    application
      .getState()
      .logs?.some(
        (entry) =>
          entry.level === "error" &&
          entry.message.startsWith("Session start failed:"),
      ),
  );
  assert.equal(application.getState().repositories[0]!.backend, "local");
  assert.equal(application.getState().repositories[0]!.managementBusy, false);
  assert.match(application.getState().error!, /Request cancelled/);
  await application.restart(alpha);
  assert.equal(application.getState().repositories[0]!.backend, "local");
  assert.equal(application.getState().repositories[0]!.status, "ready");
});

test("cancelling a real worker during local startup is reported as cancellation", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  const worker = new LocalWorker(process.execPath, [
    join(__dirname, "fixtures", "local-worker.js"),
    "hang",
  ]);
  t.after(() => worker.stop());
  let loading!: () => void;
  const started = new Promise<void>((resolve) => {
    loading = resolve;
  });
  const opening = application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: (...args) => {
            const result = worker.load(...args);
            loading();
            return result;
          },
          generateChat: (...args) => worker.generateChat(...args),
          stop: () => worker.stop(),
        },
        "/model",
      ),
  );
  const cancelled = assert.rejects(opening, { name: "AbortError" });
  await started;
  application.cancel(alpha);
  await cancelled;
  assert.match(application.getState().error!, /Request cancelled/);
  await worker.stop();
});

async function setup(
  t: TestContext,
  scenario = "conversation",
  timeoutMs = 5_000,
  collectDiff?: typeof collectSessionDiff,
) {
  const root = await mkdtemp(join(tmpdir(), "devdash-agents-application-"));
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(root, name, ".git"), { recursive: true });
    await writeFile(join(root, name, "scenario"), scenario);
  }
  let changes = 0;
  const snapshots: ApplicationState[] = [];
  const streamingChanges: boolean[] = [];
  const updates = new EventEmitter();
  const applications: AgentApplication[] = [];
  const createApplication = (saved?: SavedApplication): AgentApplication => {
    const application: AgentApplication = new AgentApplication(
      root,
      (repository, requestId, view) =>
        new CopilotConversation({
          cliPath: join(__dirname, "fixtures", "copilot.js"),
          workingDirectory: repository.path,
          timeoutMs,
          onPermissionRequest: async (request, invocation) => ({
            kind: (await application.requestPermission(
              repository.id,
              describePermission(request, invocation.promptRequest),
              requestId,
              view,
            ))
              ? "approve-once"
              : "reject",
          }),
          onUserInputRequest: (request) =>
            application.askQuestion(repository.id, request, requestId, view),
        }),
      (streaming = false) => {
        changes++;
        streamingChanges.push(streaming);
        snapshots.push(application.getState());
        updates.emit("change");
      },
      saved,
      collectDiff,
    );
    applications.push(application);
    return application;
  };
  const application = createApplication();
  t.after(async () => {
    await Promise.all(applications.map((application) => application.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  await application.refresh();
  return {
    application,
    root,
    changes: () => changes,
    snapshots,
    streamingChanges,
    createApplication,
    waitForRecovery: async () => {
      const signal = AbortSignal.timeout(10_000);
      for (;;) {
        if (
          application
            .getState()
            .messages.some((message) => message.title === "Copilot recovery")
        )
          return;
        await once(updates, "change", { signal });
      }
    },
    waitForPermission: async (repositoryId: string, except?: string) => {
      for (;;) {
        const request = application
          .getState()
          .permissions.find(
            (entry) =>
              entry.repositoryId === repositoryId && entry.id !== except,
          );
        if (request) {
          return request;
        }
        await once(updates, "change");
      }
    },
    waitForQuestion: async (repositoryId: string, except?: string) => {
      for (;;) {
        const request = application
          .getState()
          .questions.find(
            (entry) =>
              entry.repositoryId === repositoryId && entry.id !== except,
          );
        if (request) {
          return request;
        }
        await once(updates, "change");
      }
    },
  };
}

async function requests(directory: string): Promise<
  {
    method: string;
    params?: {
      sessionId?: string;
      prompt?: string;
      attachments?: {
        type: string;
        data: string;
        mimeType: string;
        displayName: string;
      }[];
    };
  }[]
> {
  return (await readFile(join(directory, "requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

async function pid(directory: string): Promise<number> {
  return Number(await readFile(join(directory, "pid"), "utf8"));
}

test("generated tokens accumulate across calls, subagents and parallel work, persist and follow the selected session", async (t) => {
  const { application, root, createApplication } = await setup(
    t,
    "persist-usage",
  );
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  const tokens = (app: AgentApplication, id = alpha) =>
    app.getState().repositories.find((repository) => repository.id === id)!
      .generatedTokens;
  await application.openSession(alpha);
  assert.equal(tokens(application), 0);
  await application.send(alpha, "First request");
  assert.equal(tokens(application), 37);
  const main = application.send(alpha, "Second request");
  const parallel = application.send(alpha, "Parallel request");
  await Promise.all([main, parallel]);
  assert.equal(tokens(application), 111);
  assert.equal(
    application.getSnapshot().sessions.find((session) => session.id === alpha)
      ?.history?.[0]?.generatedTokens,
    37,
  );
  await application.openSession(beta);
  assert.equal(tokens(application, beta), 0);
  await application.send(beta, "Independent request");
  assert.equal(tokens(application, beta), 37);
  assert.equal(tokens(application), 111);
  await application.dispose();

  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(tokens(restored), 111);
  await restored.openSession(alpha);
  assert.equal(tokens(restored), 111);
  await restored.send(alpha, "Resumed request");
  assert.equal(tokens(restored), 148);
  await restored.restart(alpha);
  assert.equal(tokens(restored), 0);
  await restored.send(alpha, "Fresh request");
  assert.equal(tokens(restored), 37);
  assert.equal(
    restored
      .getDatasetSessions()
      .find((session) => session.location === "current")?.promptCount,
    1,
  );
  assert.ok(restored.getSnapshot().sessions[0]!.recordMessageStart! > 0);
  await restored.newSession(alpha);
  assert.equal(tokens(restored), 0);
  await restored.deleteSessions(alpha, false);
  assert.equal(tokens(restored), 37);
});

test("late parallel usage belongs to its archived conversation after a failed main session is replaced", async (t) => {
  const { application, root, waitForPermission, waitForQuestion } = await setup(
    t,
    "permission-error",
  );
  const alpha = join(root, "alpha");
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => runCommand("git", args, alpha, signal);
  await git(["init", "--quiet"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  await application.openSession(alpha);
  const original = application.getSnapshot().sessions[0]!;
  const originalId = original.sessionId;
  const originalRecordId = original.recordId;
  const mainRejected = assert.rejects(
    application.send(alpha, "Fail after approval"),
    /Main request failed/,
  );
  const permission = await waitForPermission(alpha);
  await writeFile(join(alpha, "scenario"), "question-usage");
  const parallel = application.send(alpha, "Continue in parallel");
  const question = await waitForQuestion(alpha);
  assert.equal(application.getState().repositories[0]?.generatedTokens, 20);
  application.respondToPermission(permission.id, true);
  await mainRejected;
  const archivedDiffSize = application
    .getDatasetSessions()
    .find((session) => session.location === "current")?.finalDiffSize;
  assert.ok(archivedDiffSize !== undefined && archivedDiffSize > 0);
  await writeFile(join(alpha, "scenario"), "persist-usage");
  await application.openSession(alpha);
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.location === "current")?.finalDiffSize,
    undefined,
  );
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.recordId === originalRecordId)?.finalDiffSize,
    archivedDiffSize,
  );
  assert.equal(application.getState().repositories[0]?.generatedTokens, 0);
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.location === "current")?.promptCount,
    0,
  );
  assert.ok(
    application
      .getState()
      .messages.some((message) => message.content === "Fail after approval"),
  );
  application.answerQuestion(question.id, "Targeted");
  assert.equal(
    application
      .getState()
      .messages.find((message) => message.content === "Targeted")?.recordId,
    originalRecordId,
  );
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.location === "current")?.promptCount,
    0,
  );
  await parallel;
  assert.equal(application.getState().repositories[0]?.generatedTokens, 0);
  assert.equal(
    application
      .getSnapshot()
      .sessions[0]?.history?.find((entry) => entry.sessionId === originalId)
      ?.generatedTokens,
    27,
  );
  assert.equal(
    application
      .getState()
      .messages.find((message) => message.toolCallId === "late-parallel-tool")
      ?.recordId,
    originalRecordId,
  );
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.location === "current")?.toolCallCount,
    0,
  );
  assert.equal(
    application
      .getDatasetSessions()
      .find(
        (session) =>
          session.location === "archived" && session.toolCallCount === 1,
      )?.toolCallCount,
    1,
  );
});

test("a completed diff probe updates its archived record without changing a replacement request", async (t) => {
  let releaseProbe!: () => void;
  let reportProbe!: () => void;
  const probeReleased = new Promise<void>(
    (resolve) => (releaseProbe = resolve),
  );
  const probeCompleted = new Promise<void>(
    (resolve) => (reportProbe = resolve),
  );
  let first = true;
  const collectDiff: typeof collectSessionDiff = async (...args) => {
    const result = await collectSessionDiff(...args);
    if (first) {
      first = false;
      reportProbe();
      await probeReleased;
    }
    return result;
  };
  const { application, root, createApplication, waitForPermission } =
    await setup(t, "permission-error", 5_000, collectDiff);
  const alpha = join(root, "alpha");
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => runCommand("git", args, alpha, signal);
  await git(["init", "--quiet"]);
  await writeFile(join(alpha, "tracked.txt"), "before\n");
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  await application.openSession(alpha);
  const originalRecordId = application.getSnapshot().sessions[0]!.recordId;
  await writeFile(join(alpha, "tracked.txt"), "old diff é\n");
  const failed = assert.rejects(
    application.send(alpha, "Fail after approval"),
    /Main request failed/,
  );
  application.respondToPermission((await waitForPermission(alpha)).id, true);
  try {
    await probeCompleted;
    const expectedSize = Buffer.byteLength(
      await git([
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        "HEAD",
        "--",
      ]),
      "utf8",
    );
    await writeFile(join(alpha, "scenario"), "permission");
    await application.openSession(alpha);
    await writeFile(join(alpha, "tracked.txt"), "replacement diff\n");
    const replacement = application.send(alpha, "Replacement request");
    const permission = await waitForPermission(alpha);
    releaseProbe();
    await failed;
    assert.equal(
      application
        .getDatasetSessions()
        .find((entry) => entry.recordId === originalRecordId)?.finalDiffSize,
      expectedSize,
    );
    const current = application
      .getDatasetSessions()
      .find((entry) => entry.location === "current")!;
    assert.notEqual(current.recordId, originalRecordId);
    assert.equal(current.finalDiffSize, undefined);
    assert.equal(application.getState().repositories[0]?.status, "busy");
    assert.ok(
      application
        .getState()
        .permissions.some((entry) => entry.id === permission.id),
    );
    application.respondToPermission(permission.id, true);
    await replacement;
    const restored = createApplication(application.getSnapshot());
    await restored.refresh();
    assert.equal(
      restored
        .getDatasetSessions()
        .find((entry) => entry.recordId === originalRecordId)?.finalDiffSize,
      expectedSize,
    );
    assert.notEqual(
      restored
        .getDatasetSessions()
        .find((entry) => entry.location === "current")?.finalDiffSize,
      expectedSize,
    );
  } finally {
    releaseProbe();
  }
});

test("saving the local view retains an in-flight Copilot parallel session", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const mainRequest = application.send(alpha, "Main request");
  const mainQuestion = await waitForQuestion(alpha);
  const parallelRequest = application.send(alpha, "Parallel request", true);
  const parallelQuestion = await waitForQuestion(alpha, mainQuestion.id);
  const parallelSession = application
    .getSnapshot()
    .sessions[0]!.history?.find((entry) =>
      entry.messages.some((message) => message.title?.startsWith("Parallel ")),
    );
  assert.ok(parallelSession?.sessionId);
  await application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async () => {},
          stop: async () => {},
        },
        "/model",
      ),
  );
  const saved = application.getSnapshot().sessions[0]!;
  assert.ok(
    saved.history?.some(
      (entry) =>
        entry.sessionId === parallelSession.sessionId &&
        entry.messages.some((message) =>
          message.title?.startsWith("Parallel "),
        ),
    ),
  );
  application.answerQuestion(parallelQuestion.id, "Targeted");
  application.answerQuestion(mainQuestion.id, "Targeted");
  await Promise.all([mainRequest, parallelRequest]);
});

test("Copilot questions and parallel work stay with their owning session", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const firstView = application.getState().repositories[0]!.view!;
  await application.addCopilotSession(alpha);
  const secondView = application.getState().repositories[0]!.view!;
  application.selectSession(alpha, firstView);

  const main = application.send(alpha, "Main request");
  application.selectSession(alpha, secondView);
  const mainQuestion = await waitForQuestion(alpha);
  assert.equal(
    application
      .getState()
      .messages.some((message) => message.content === mainQuestion.question),
    false,
  );

  application.selectSession(alpha, firstView);
  const parallel = application.send(alpha, "Parallel request");
  application.selectSession(alpha, secondView);
  const parallelQuestion = await waitForQuestion(alpha, mainQuestion.id);
  assert.equal(
    application
      .getState()
      .messages.some(
        (message) => message.content === parallelQuestion.question,
      ),
    false,
  );

  application.answerQuestion(mainQuestion.id, "Targeted");
  await main;
  application.selectSession(alpha, firstView);
  const firstState = application.getState();
  assert.equal(
    firstState.repositories[0]?.sessions?.find(
      (session) => session.view === firstView,
    )?.status,
    "busy",
  );
  assert.equal(firstState.repositories[0]?.status, "busy");
  application.selectSession(alpha, secondView);
  application.answerQuestion(parallelQuestion.id, "All");
  await parallel;

  application.selectSession(alpha, firstView);
  const firstMessages = application.getState().messages;
  assert.ok(
    firstMessages.some((message) => message.content === mainQuestion.question),
  );
  assert.ok(firstMessages.some((message) => message.content === "Targeted"));
  assert.ok(
    firstMessages.some(
      (message) =>
        message.content === "Which test suite should run?" &&
        message.title?.startsWith("Parallel "),
    ),
  );
  assert.ok(firstMessages.some((message) => message.content === "All"));
  application.selectSession(alpha, secondView);
  assert.equal(
    application
      .getState()
      .messages.some((message) =>
        ["Which test suite should run?", "Targeted", "All"].includes(
          message.content,
        ),
      ),
    false,
  );
});

test("late parallel usage stays with its session after explicit recovery", async (t) => {
  const { application, root, waitForRecovery, waitForQuestion } = await setup(
    t,
    "late-parallel-recovery",
    15_000,
  );
  const alpha = join(root, "alpha");
  await writeFile(join(alpha, "crashes-left"), "4");
  await application.openSession(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  const mainRejected = assert.rejects(
    application.send(alpha, "Fail the main request"),
    /after 3 automatic restarts/,
  );
  await waitForRecovery();
  const parallel = application.send(alpha, "Keep the parallel request open");
  const question = await waitForQuestion(alpha);
  assert.equal(application.getState().repositories[0]?.generatedTokens, 20);
  await mainRejected;
  await application.openSession(alpha);
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  application.answerQuestion(question.id, "Targeted");
  await parallel;
  assert.equal(application.getState().repositories[0]?.generatedTokens, 27);
  assert.equal(
    application
      .getSnapshot()
      .sessions[0]?.history?.some((entry) => entry.sessionId === sessionId),
    false,
  );
});

test("session export snapshots one conversation, including hidden events and attachments", async (t) => {
  const { application, root } = await setup(t, "persist-usage");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  assert.throws(() => application.getSessionExport(alpha), /no session/i);
  await application.openSession(alpha);
  await application.send(alpha, "Remember FIRST", false, [testImage]);
  application.setDraft(alpha, "Draft for alpha");
  const source = application.getSessionExport(alpha);
  assert.equal(source.repository.id, alpha);
  assert.equal(source.conversation.draft, "Draft for alpha");
  assert.deepEqual(
    source.conversation.messages,
    application.getState().messages,
  );
  assert.ok(
    source.conversation.messages.every((message) => message.role !== "system"),
  );
  const saved = JSON.stringify(source);
  await application.openSession(beta);
  await application.send(beta, "Do not include BETA");
  await application.openSession(alpha);
  await application.send(alpha, "Later work");
  assert.equal(JSON.stringify(source), saved);
  assert.doesNotMatch(saved, /Do not include BETA|Later work/);
  const image = source.conversation.messages.find(
    (message) => message.images?.length,
  )?.images?.[0];
  assert.ok(image);
  image.name = "Changed in export";
  assert.notEqual(
    application.getState().messages.find((message) => message.images?.length)
      ?.images?.[0]?.name,
    image.name,
  );
  await application.closeSession(alpha);
  assert.ok(application.getSessionExport(alpha).conversation.sessionId);
  assert.throws(
    () => application.getSessionExport(join(root, "unknown")),
    /Unknown repository/,
  );
});

test("dataset annotations and used models follow sessions through archiving and restoration", async (t) => {
  const { application, root, createApplication } = await setup(
    t,
    "persist-usage",
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Implement #84", false);
  const first = application.getDatasetSessions()[0]!;
  assert.equal(first.promptCount, 1);
  assert.equal(
    first.toolCallCount,
    application.getState().messages.filter((message) => message.role === "tool")
      .length,
  );
  assert.ok(first.durationMs! >= 0);
  assert.ok(Number.isFinite(Date.parse(first.date!)));
  assert.equal(first.finalDiffSize, undefined);
  assert.deepEqual(first.references, ["#84"]);
  assert.ok(first.models.includes("fixture"));
  assert.throws(
    () =>
      application.annotateSession(alpha, first.recordId, {
        mark: "failure",
        reason: "  ",
      }),
    /reason/i,
  );
  application.annotateSession(alpha, first.recordId, {
    mark: "failure",
    reason: "Tests fail",
    comments: "Inspect output",
  });
  await application.newSession(alpha);
  const archived = application
    .getDatasetSessions()
    .find((session) => session.recordId === first.recordId)!;
  assert.equal(archived.location, "archived");
  assert.equal(archived.annotation?.reason, "Tests fail");
  const source = application.getDatasetSessionExport(alpha, first.recordId);
  assert.deepEqual(source.conversation.annotation, archived.annotation);
  assert.ok(source.conversation.models?.includes("fixture"));
  const restored = createApplication(application.getSnapshot());
  await restored.refresh();
  const after = restored
    .getDatasetSessions()
    .find((session) => session.recordId === first.recordId)!;
  assert.deepEqual(after.annotation, archived.annotation);
  assert.deepEqual(after.models, archived.models);
  assert.deepEqual(after.references, ["#84"]);
  assert.equal(after.promptCount, first.promptCount);
  assert.equal(after.toolCallCount, first.toolCallCount);
  assert.equal(after.durationMs, first.durationMs);
  assert.equal(after.date, first.date);
  restored.annotateSession(alpha, first.recordId, { mark: "success" });
  assert.equal(
    restored.getDatasetSessionExport(alpha, first.recordId).conversation
      .annotation?.mark,
    "success",
  );
  assert.equal(source.conversation.annotation?.mark, "failure");
  restored.annotateSession(alpha, first.recordId, null);
  assert.equal(
    restored.getDatasetSessionExport(alpha, first.recordId).conversation
      .annotation,
    undefined,
  );
  const withoutAnnotation = createApplication(restored.getSnapshot());
  await withoutAnnotation.refresh();
  assert.equal(
    withoutAnnotation.getDatasetSessionExport(alpha, first.recordId)
      .conversation.annotation,
    undefined,
  );
});

test("dataset final diff bytes survive cancellation, archiving and restoration", async (t) => {
  const { application, root, createApplication, waitForPermission } =
    await setup(t, "permission");
  const alpha = join(root, "alpha");
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => runCommand("git", args, alpha, signal);
  await git(["init", "--quiet"]);
  await writeFile(join(alpha, "tracked.txt"), "before\n");
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  await application.openSession(alpha);
  await writeFile(join(alpha, "tracked.txt"), "after é\n");
  const sending = application.send(alpha, "First request");
  application.respondToPermission((await waitForPermission(alpha)).id, true);
  await sending;
  const first = application.getDatasetSessions()[0]!;
  const diff = await git([
    "-c",
    "core.fsmonitor=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--binary",
    "HEAD",
    "--",
  ]);
  assert.equal(first.finalDiffSize, Buffer.byteLength(diff, "utf8"));
  assert.ok(first.finalDiffSize! > 0);
  await writeFile(join(alpha, "tracked.txt"), "before\n");
  const second = application.send(alpha, "Second request");
  application.respondToPermission((await waitForPermission(alpha)).id, true);
  await second;
  assert.equal(application.getDatasetSessions()[0]!.finalDiffSize, 0);
  await writeFile(join(alpha, "tracked.txt"), "after é\n");
  const cancelled = assert.rejects(
    application.send(alpha, "Cancelled request"),
    /cancel|abort/i,
  );
  await waitForPermission(alpha);
  const queued = assert.rejects(
    application.send(alpha, "Never sent", false),
    /cancel|abort/i,
  );
  application.cancel(alpha);
  await Promise.all([cancelled, queued]);
  assert.equal(
    application.getDatasetSessions()[0]!.finalDiffSize,
    first.finalDiffSize,
  );
  await application.newSession(alpha);
  const archived = application
    .getDatasetSessions()
    .find((row) => row.recordId === first.recordId)!;
  assert.equal(archived.finalDiffSize, first.finalDiffSize);
  assert.equal(archived.promptCount, 3);
  const restored = createApplication(application.getSnapshot());
  await restored.refresh();
  assert.equal(
    restored
      .getDatasetSessions()
      .find((row) => row.recordId === first.recordId)!.finalDiffSize,
    first.finalDiffSize,
  );
  assert.equal(
    restored.getDatasetSessionExport(alpha, first.recordId).conversation
      .finalDiffSize,
    first.finalDiffSize,
  );
  assert.equal(
    application.getDatasetSessions().find((row) => row.location === "current")
      ?.finalDiffSize,
    undefined,
  );
});

test("older sessions receive stable dataset identifiers without losing their backend", async (t) => {
  const { root, createApplication } = await setup(t);
  const alpha = join(root, "alpha");
  const restored = createApplication({
    version: 1,
    root,
    sessions: [
      {
        id: alpha,
        draft: "",
        messages: [{ role: "user", content: "Copilot prompt" }],
        history: [
          {
            backend: "local",
            draft: "",
            messages: [{ role: "user", content: "Local prompt" }],
          },
        ],
      },
    ],
  });
  await restored.refresh();
  const before = restored.getDatasetSessions();
  assert.deepEqual(before.map((session) => session.backend).sort(), [
    "copilot",
    "local",
  ]);
  assert.notEqual(before[0]!.recordId, before[1]!.recordId);
  const reopened = createApplication(restored.getSnapshot());
  await reopened.refresh();
  assert.deepEqual(
    reopened
      .getDatasetSessions()
      .map((entry) => entry.recordId)
      .sort(),
    before.map((entry) => entry.recordId).sort(),
  );
});

test("PostMortems survive saving and session archives, and export the exact analysed conversation rather than later work", async (t) => {
  const { application, root, createApplication, snapshots } = await setup(
    t,
    "persist",
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Produce a commit for this PR");
  const sources = application.getState().messages;
  const before = snapshots.length;
  await application.createPostMortem(alpha, analysePostMortem);
  assert.deepEqual(
    snapshots
      .slice(before)
      .map((snapshot) => snapshot.postMortemProgress)
      .filter(Boolean),
    [
      `Preparing ${sources.length} source records...`,
      `Analysing records 1-${sources.length} of ${sources.length} (model request 1)...`,
    ],
  );
  assert.equal(application.getState().postMortemProgress, undefined);
  const report = application.getState().postMortem;
  assert.ok(report);
  assert.deepEqual(application.getState().messages, sources);
  assert.equal(report.sourceCount, sources.length);
  application.setDraft(alpha, "Keep this draft");
  await application.send(alpha, "Later work must not enter the older export");
  const exported = JSON.parse(application.exportPostMortem(alpha));
  assert.deepEqual(
    exported.sources,
    sources.map((message, index) => ({ index: index + 1, ...message })),
  );
  assert.deepEqual(exported.rows, report.rows);
  await application.dispose();
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(
    restored.exportPostMortem(alpha),
    JSON.stringify(exported, null, 2) + "\n",
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.resume",
    ).length,
    0,
  );
  await restored.createPostMortem(alpha, analysePostMortem);
  assert.equal(restored.getState().postMortem?.sourceCount, sources.length + 2);
  await restored.newSession(alpha);
  assert.equal(restored.getState().postMortem, undefined);
  await restored.deleteSessions(alpha, false);
  assert.equal(restored.getState().postMortem?.sourceCount, sources.length + 2);
});

test("PostMortem failures and cancellation preserve the main conversation, draft and previous report", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const child = await pid(alpha);
  await application.send(alpha, "Finish the task");
  await application.createPostMortem(alpha, analysePostMortem);
  application.setDraft(alpha, "Unsent draft");
  const before = application.exportPostMortem(alpha);
  await assert.rejects(
    application.createPostMortem(alpha, async () => {
      throw new Error("Analysis failed");
    }),
    /Analysis failed/,
  );
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getState().postMortemError, "Analysis failed");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = application.createPostMortem(
    alpha,
    (_source, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  await started;
  assert.equal(application.getState().postMortemBusy, true);
  await assert.rejects(
    application.send(alpha, "Do not mutate a snapshot in progress"),
    /PostMortem/,
  );
  assert.throws(() => application.newSession(alpha), /PostMortem/);
  application.cancel(alpha);
  await cancelled;
  assert.equal(application.exportPostMortem(alpha), before);
  assert.equal(application.getState().draft, "Unsent draft");
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.doesNotThrow(() => process.kill(child, 0));
});

test("PostMortem waits for completed work and shutdown or removal cannot attach a late report", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const sending = application.send(alpha, "Finish this task first");
  const permission = await waitForPermission(alpha);
  assert.throws(
    () => application.createPostMortem(alpha, analysePostMortem),
    /work to finish/,
  );
  application.respondToPermission(permission.id, true);
  await sending;
  for (const action of ["remove", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root } = await setup(t, "persist");
      const alpha = join(root, "alpha");
      await application.openSession(alpha);
      await application.send(alpha, "Completed task");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = application.createPostMortem(
        alpha,
        (_source, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            entered();
          }),
      );
      const cancelled = assert.rejects(pending, { name: "AbortError" });
      await started;
      if (action === "remove") {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      } else await application.dispose();
      await cancelled;
      assert.equal(
        application
          .getSnapshot()
          .sessions.find((session) => session.id === alpha)?.postMortem,
        undefined,
      );
    });
  }
});

test("image-only messages reach the SDK and structured tool images are retained safely", async (t) => {
  const { application, root } = await setup(t, "images");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const message = parseApplicationMessage({
    type: "send",
    id: alpha,
    question: "",
    images: [testImage],
  });
  assert.equal(message.type, "send");
  if (message.type !== "send") return;
  await application.send(
    message.id,
    message.question,
    message.parallel,
    message.images,
  );
  const sent = (await requests(alpha)).find(
    (request) => request.method === "session.sendAndWait",
  );
  assert.equal(sent?.params?.prompt, "Describe the attached images.");
  assert.deepEqual(sent?.params?.attachments, [
    {
      type: "blob",
      displayName: testImage.name,
      mimeType: "image/png",
      data: testImage.dataUrl.split(",")[1],
    },
  ]);
  const messages = application.getState().messages;
  assert.deepEqual(messages.find((entry) => entry.role === "user")?.images, [
    testImage,
  ]);
  const output = messages.find((entry) => entry.role === "output");
  assert.equal(output?.content, "Generated *image*, not Markdown");
  assert.deepEqual(output?.images, [
    { ...testImage, name: "Tool image" },
    {
      name: "Tool image",
      dataUrl: testImage.dataUrl.replace("image/png", "image/gif"),
    },
    {
      name: "Tool image",
      dataUrl: testImage.dataUrl.replace("image/png", "image/jpeg"),
    },
    {
      name: "Tool image",
      dataUrl: testImage.dataUrl.replace("image/png", "image/webp"),
    },
  ]);
  assert.deepEqual(application.getSnapshot().sessions[0]?.messages, messages);
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "send",
        id: alpha,
        question: "Bad image",
        images: [{}],
      }),
    /Attach up to five/,
  );
  await assert.rejects(
    application.send(alpha, "Bad image", true, [
      { ...testImage, dataUrl: "file:///private.png" },
    ]),
    /Attach up to five/,
  );
});

test("queued and parallel image requests preserve their own SDK attachments", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const main = application.send(alpha, "Main image", true, [testImage]);
  const mainPermission = await waitForPermission(alpha);
  const queuedImage = { ...testImage, name: "queued.png" };
  const queued = application.send(alpha, "Queued image", false, [queuedImage]);
  const parallelImage = { ...testImage, name: "parallel.png" };
  const parallel = application.send(alpha, "Parallel image", true, [
    parallelImage,
  ]);
  const parallelPermission = await waitForPermission(alpha, mainPermission.id);
  application.respondToPermission(parallelPermission.id, true);
  await parallel;
  application.respondToPermission(mainPermission.id, true);
  await main;
  const queuedPermission = await waitForPermission(alpha);
  application.respondToPermission(queuedPermission.id, true);
  await queued;
  const sends = (await requests(alpha)).filter(
    (request) => request.method === "session.sendAndWait",
  );
  assert.deepEqual(
    sends.map((request) => request.params?.attachments),
    [testImage, parallelImage, queuedImage].map((image) => [
      {
        type: "blob",
        displayName: image.name,
        mimeType: "image/png",
        data: image.dataUrl.split(",")[1],
      },
    ]),
  );
  assert.deepEqual(
    application
      .getState()
      .messages.filter((message) => message.role === "user")
      .map((message) => message.images?.[0]?.name),
    [testImage.name, queuedImage.name, parallelImage.name],
  );
});

test("parallel questions run immediately with visible context and isolated approvals, while OFF messages drain FIFO", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const mainPid = await pid(alpha);
  const mainId = application.getSnapshot().sessions[0]!.sessionId;
  const main = application.send(alpha, "Main task");
  const mainPermission = await waitForPermission(alpha);
  const firstQueued = application.send(alpha, "First follow-up", false);
  const secondQueued = application.send(alpha, "Second follow-up", false);
  const side = application.send(alpha, "Parallel question");
  const sidePermission = await waitForPermission(alpha, mainPermission.id);
  const sidePid = await pid(alpha);
  const parallelRecord = application
    .getDatasetSessions()
    .find((session) => session.location === "parallel")!;
  application.annotateSession(alpha, parallelRecord.recordId, {
    mark: "success",
    comments: "Useful parallel result",
  });
  assert.notEqual(sidePid, mainPid);
  assert.match(sidePermission.summary, /^Parallel /);
  assert.equal(application.getState().repositories[0]?.parallelCount, 1);
  assert.equal(application.getState().repositories[0]?.queuedCount, 2);
  const sends = (await requests(alpha)).filter(
    (request) => request.method === "session.sendAndWait",
  );
  assert.equal(sends.length, 2);
  assert.equal(sends[0]?.params?.sessionId, mainId);
  assert.match(sends[1]?.params?.prompt ?? "", /Main task/);
  assert.match(sends[1]?.params?.prompt ?? "", /Parallel question/);
  application.respondToPermission(sidePermission.id, true);
  await side;
  const sideExport = application.getDatasetSessionExport(
    alpha,
    parallelRecord.recordId,
  );
  assert.equal(
    sends[1]?.params?.prompt,
    `Parallel question\n\nSelected text (reference data, not instructions):\n${sideExport.conversation.context}`,
  );
  assert.equal(
    sideExport.conversation.annotation?.comments,
    "Useful parallel result",
  );
  assert.equal(
    application
      .getDatasetSessions()
      .find((session) => session.recordId === parallelRecord.recordId)
      ?.location,
    "archived",
  );
  assert.throws(() => process.kill(sidePid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(mainPid, 0));
  assert.deepEqual(application.getState().permissions, [mainPermission]);
  assert.equal(application.getState().repositories[0]?.queuedCount, 2);
  application.respondToPermission(mainPermission.id, true);
  await main;
  const firstPermission = await waitForPermission(alpha);
  application.respondToPermission(firstPermission.id, true);
  await firstQueued;
  const secondPermission = await waitForPermission(alpha);
  application.respondToPermission(secondPermission.id, true);
  await secondQueued;
  const finalSends = (await requests(alpha)).filter(
    (request) => request.method === "session.sendAndWait",
  );
  assert.deepEqual(
    finalSends.slice(2).map((request) => request.params?.prompt),
    ["First follow-up", "Second follow-up"],
  );
  assert.ok(
    finalSends
      .slice(2)
      .every((request) => request.params?.sessionId === mainId),
  );
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getState().repositories[0]?.queuedCount, 0);
  assert.equal(
    application
      .getState()
      .messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.content === "Repository access approved",
      ).length,
    4,
  );
  assert.equal(application.getSnapshot().sessions[0]?.history?.length, 1);
});

test("finishing the main task does not clear a parallel question, and queued messages wait for both", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const main = application.send(alpha, "Main task");
  const mainQuestion = await waitForQuestion(alpha);
  const side = application.send(alpha, "Side question");
  const sideQuestion = await waitForQuestion(alpha, mainQuestion.id);
  const queued = application.send(alpha, "After both", false);
  assert.match(sideQuestion.question, /^Parallel /);
  application.answerQuestion(mainQuestion.id, "Targeted");
  await main;
  assert.deepEqual(application.getState().questions, [sideQuestion]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.equal(application.getState().repositories[0]?.queuedCount, 1);
  application.answerQuestion(sideQuestion.id, "All");
  await side;
  const queuedQuestion = await waitForQuestion(alpha);
  application.answerQuestion(queuedQuestion.id, "Targeted");
  await queued;
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.deepEqual(application.getState().questions, []);
});

test("management completion drains a main-session queue blocked during local startup", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const mainView = application.getState().repositories[0]!.view!;
  const main = application.send(alpha, "Main request");
  const mainPermission = await waitForPermission(alpha);
  const queued = application.send(alpha, "Follow-up", false);

  let releasePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const opening = application.openLocalSession(
    alpha,
    () =>
      new LocalConversation(
        {
          load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
          generateChat: async () => {},
          stop: async () => {},
        },
        "/model",
      ),
    () => preparation,
    true,
  );
  application.respondToPermission(mainPermission.id, true);
  await main;
  application.selectSession(alpha, mainView);
  assert.equal(application.getState().repositories[0]?.queuedCount, 1);

  releasePreparation();
  await opening;
  const followUpPermission = await waitForPermission(alpha);
  application.respondToPermission(followUpPermission.id, true);
  await queued;
  assert.equal(application.getState().repositories[0]?.queuedCount, 0);
});

test("parallel stream IDs and failures stay isolated from the main conversation", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const main = application.send(alpha, "Main task");
  const permission = await waitForPermission(alpha);
  await writeFile(join(alpha, "scenario"), "empty");
  await assert.rejects(
    application.send(alpha, "Fail independently"),
    /no answer/,
  );
  assert.deepEqual(application.getState().permissions, [permission]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) => message.error && message.title?.startsWith("Parallel "),
      ),
  );
  await writeFile(join(alpha, "scenario"), "events");
  await application.send(alpha, "First stream");
  await application.send(alpha, "Second stream");
  const messages = application.getState().messages;
  assert.equal(
    messages.filter(
      (message) =>
        message.role === "tool" && message.title?.endsWith("bash - completed"),
    ).length,
    2,
  );
  assert.equal(
    messages.filter(
      (message) =>
        message.role === "assistant" &&
        !message.agentId &&
        message.content === "## Fixture answer",
    ).length,
    2,
  );
  assert.deepEqual(application.getState().permissions, [permission]);
  application.respondToPermission(permission.id, true);
  await main;
});

test("parallel SDK IDs persist for repository deletion, while a saved queue is never resumed", async (t) => {
  const { application, root, createApplication } = await setup(
    t,
    "persist-hang",
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const mainId = application.getSnapshot().sessions[0]!.sessionId;
  const main = application.send(alpha, "Long-running main task");
  const mainRejected = assert.rejects(main, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await writeFile(join(alpha, "scenario"), "persist");
  await application.send(alpha, "Independent request");
  const queued = application.send(alpha, "Never automatically replay", false);
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  const entry = restored
    .getSnapshot()
    .sessions.find((session) => session.id === alpha);
  const sideId = entry?.history?.[0]?.sessionId;
  assert.ok(sideId && sideId !== mainId);
  assert.ok(
    entry?.messages.some(
      (message) =>
        message.content === "Never automatically replay" &&
        message.title === "Not sent - previous application ended",
    ),
  );
  await application.closeSession(alpha);
  await Promise.all([mainRejected, queuedRejected]);
  await restored.deleteSessions(alpha, true);
  assert.deepEqual(
    new Set(
      (await requests(alpha))
        .filter((request) => request.method === "session.delete")
        .map((request) => request.params?.sessionId),
    ),
    new Set([mainId, sideId]),
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.sendAndWait",
    ).length,
    2,
  );
  assert.equal(restored.getState().repositories[0]?.sessionCount, 0);
});

test("a main-request failure cancels its queue without hiding or stopping active parallel work", async (t) => {
  const { application, root, waitForPermission, waitForQuestion } = await setup(
    t,
    "permission-error",
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const main = application.send(alpha, "Fail after approval");
  const mainRejected = assert.rejects(main, /Main request failed/);
  const permission = await waitForPermission(alpha);
  const queued = application.send(alpha, "Do not send after failure", false);
  const queuedRejected = assert.rejects(queued, { name: "AbortError" });
  await writeFile(join(alpha, "scenario"), "question");
  const side = application.send(alpha, "Keep working independently");
  const question = await waitForQuestion(alpha);
  application.respondToPermission(permission.id, true);
  await Promise.all([mainRejected, queuedRejected]);
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.deepEqual(application.getState().questions, [question]);
  await writeFile(join(alpha, "scenario"), "events");
  await application.send(alpha, "Another parallel request");
  application.answerQuestion(question.id, "Targeted");
  await side;
  assert.equal(application.getState().repositories[0]?.status, "error");
  assert.match(application.getState().error ?? "", /Main request failed/);
});

test("cancel, close and repository removal stop parallel work and never replay queued requests", async (t) => {
  for (const action of ["cancel", "close", "remove", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForPermission, createApplication } =
        await setup(t, "permission");
      const alpha = join(root, "alpha");
      await application.openSession(alpha);
      const mainPid = await pid(alpha);
      const main = application.send(alpha, "Main task");
      const mainRejected = assert.rejects(main, { name: "AbortError" });
      const mainPermission = await waitForPermission(alpha);
      const side = application.send(alpha, "Parallel task");
      const sideRejected = assert.rejects(side, { name: "AbortError" });
      await waitForPermission(alpha, mainPermission.id);
      const sidePid = await pid(alpha);
      const queued = application.send(alpha, "Must not run", false);
      const queuedRejected = assert.rejects(queued, { name: "AbortError" });
      if (action === "cancel") application.cancel(alpha);
      else if (action === "close") await application.closeSession(alpha);
      else if (action === "dispose") await application.dispose();
      else {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      }
      await Promise.all([mainRejected, sideRejected, queuedRejected]);
      assert.deepEqual(application.getState().permissions, []);
      assert.throws(() => process.kill(mainPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(sidePid, 0), { code: "ESRCH" });
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "session.sendAndWait",
        ).length,
        2,
      );
      const saved = application.getSnapshot();
      const entry = saved.sessions.find((session) => session.id === alpha);
      if (entry) {
        const timedPrompts = entry.messages.filter(
          (message) => message.timings,
        );
        assert.equal(timedPrompts.length, 2);
        assert.ok(
          timedPrompts.every((message) =>
            message.timings!.every((step) => step.end !== undefined),
          ),
        );
        assert.equal(
          entry.messages.find((message) => message.content === "Must not run")
            ?.timings,
          undefined,
        );
      }
      assert.ok(
        entry?.messages.some(
          (message) =>
            message.content === "Must not run" &&
            message.title === "Not sent - queue cancelled",
        ),
      );
      assert.equal(entry?.history?.length, 1);
      const restored = createApplication(saved);
      await restored.refresh();
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "session.sendAndWait",
        ).length,
        2,
      );
    });
  }
});

test("repository selection never starts or resumes Copilot and closing preserves history and drafts", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  for (const id of [alpha, beta, alpha]) {
    await application.select(id);
    assert.equal(application.getState().activeId, id);
    assert.ok(
      application
        .getState()
        .repositories.every((entry) => entry.status === "idle"),
    );
    await assert.rejects(readFile(join(id, "pid")), { code: "ENOENT" });
  }
  await application.openSession(alpha);
  await application.send(alpha, "Remember ALPHA");
  application.setDraft(alpha, "Unfinished draft");
  const messages = application.getState().messages;
  const sessionId = application.getSnapshot().sessions[0]!.sessionId;
  const processId = await pid(alpha);
  await application.select(beta);
  assert.equal(application.getState().repositories[0]!.status, "ready");
  process.kill(processId, 0);
  await application.closeSession(alpha);
  assert.throws(() => process.kill(processId, 0), { code: "ESRCH" });
  const before = await requests(alpha);
  await application.select(alpha);
  assert.equal(application.getState().repositories[0]!.status, "saved");
  assert.deepEqual(application.getState().messages, messages);
  assert.equal(application.getState().draft, "Unfinished draft");
  assert.equal(application.getSnapshot().sessions[0]!.sessionId, sessionId);
  assert.deepEqual(await requests(alpha), before);
  const restored = createApplication(application.getSnapshot());
  await restored.refresh();
  await restored.select(beta);
  await restored.select(alpha);
  assert.equal(restored.getState().repositories[0]!.status, "saved");
  assert.deepEqual(await requests(alpha), before);
  await restored.openSession(alpha);
  assert.equal(restored.getSnapshot().sessions[0]!.sessionId, sessionId);
  assert.ok(
    (await requests(alpha)).some(
      (request) => request.method === "session.resume",
    ),
  );
});

test("changing the model switches only an open session and resumes nothing", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  await application.select(alpha);
  assert.equal(await application.changeModel(alpha, "other"), false);
  await assert.rejects(readFile(join(alpha, "pid")), { code: "ENOENT" });
  await application.openSession(alpha);
  assert.equal(await application.changeModel(alpha, "other"), true);
  assert.deepEqual(
    (await requests(alpha))
      .filter((request) => request.method === "session.model.switchTo")
      .map((request) => (request.params as { modelId?: string }).modelId),
    ["other"],
  );
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Model changed to other/,
  );
  await application.send(alpha, "Still answering");
  assert.equal(application.getState().repositories[0]!.status, "ready");
});

test("explicitly opened repository sessions persist across switches and keep conversations isolated", async (t) => {
  const { application, root, changes } = await setup(t);
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  assert.ok(changes() > 0);
  assert.ok(
    application
      .getState()
      .repositories.every((repository) => repository.status === "idle"),
  );
  for (const directory of [alpha, beta]) {
    await assert.rejects(readFile(join(directory, "pid")), { code: "ENOENT" });
  }
  await Promise.all([
    application.openSession(alpha),
    application.openSession(alpha),
  ]);
  await application.send(alpha, "Remember ALPHA.");
  await application.openSession(beta);
  assert.deepEqual(application.getState().messages, []);
  await application.send(beta, "Remember BETA.");
  await application.openSession(alpha);
  await application.send(alpha, "What did I say?");
  const history = application.getState().messages;
  assert.equal(history.length, 4);
  assert.match(history[3]?.content ?? "", /ALPHA[\s\S]*What did I say/);
  assert.doesNotMatch(history[3]?.content ?? "", /BETA/);
  for (const directory of [alpha, beta]) {
    assert.equal(
      (await requests(directory)).filter(
        (request) => request.method === "session.create",
      ).length,
      1,
    );
  }
  const pids = await Promise.all([pid(alpha), pid(beta)]);
  await application.dispose();
  for (const child of pids) {
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  }
});

test("inline permissions wait for an explicit decision and stay isolated across background repositories", async (t) => {
  const { application, root, waitForPermission } = await setup(t, "permission");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.openSession(alpha);
  const alphaAnswer = application.send(alpha, "Read Alpha");
  const alphaPermission = await waitForPermission(alpha);
  assert.equal(alphaPermission.kind, "read");
  assert.match(alphaPermission.details, /README.md/);
  assert.equal(alphaPermission.content, "README.md");
  assert.match(alphaPermission.summary, /Read this file/);
  assert.equal(
    (await requests(alpha)).filter(
      (request) =>
        request.method === "session.permissions.handlePendingPermissionRequest",
    ).length,
    0,
  );
  await application.openSession(beta);
  const betaAnswer = application.send(beta, "Read Beta");
  const betaPermission = await waitForPermission(beta);
  assert.notEqual(alphaPermission.id, betaPermission.id);
  assert.equal(application.getState().permissions.length, 2);
  application.respondToPermission(alphaPermission.id, true);
  await alphaAnswer;
  assert.deepEqual(application.getState().permissions, [betaPermission]);
  assert.throws(
    () => application.respondToPermission(alphaPermission.id, true),
    /no longer pending/,
  );
  application.respondToPermission(betaPermission.id, false);
  await betaAnswer;
  assert.deepEqual(application.getState().permissions, []);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /access denied/,
  );
  await application.openSession(alpha);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /access approved/,
  );
});

test("cancellation, closure, failure and repository removal clear pending approvals without approving", async (t) => {
  for (const action of ["cancel", "close", "timeout", "remove"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForPermission } = await setup(
        t,
        "permission",
        action === "timeout" ? 1_500 : 5_000,
      );
      const alpha = join(root, "alpha");
      await application.openSession(alpha);
      const running = application.send(alpha, "Wait for approval");
      const rejected = assert.rejects(
        running,
        action === "timeout" ? /timed out/ : { name: "AbortError" },
      );
      const request = await waitForPermission(alpha);
      const extra = application.requestPermission(alpha, {
        kind: "shell",
        summary: "Run this command?",
        content: "echo test",
        details: "echo test",
      });
      const questionRejected = assert.rejects(
        application.askQuestion(alpha, { question: "Pending question" }),
        { name: "AbortError" },
      );
      if (action === "cancel") {
        application.cancel(alpha);
      } else if (action === "close") {
        await application.dispose();
      } else if (action === "remove") {
        await rm(join(alpha, ".git"), { recursive: true });
        await application.refresh();
      }
      await rejected;
      await questionRejected;
      assert.equal(await extra, false);
      assert.deepEqual(application.getState().permissions, []);
      assert.deepEqual(application.getState().questions, []);
      assert.throws(
        () => application.respondToPermission(request.id, true),
        /closed|no longer pending/,
      );
    });
  }
});

test("SDK questions accept selected and freeform replies for the correct repository", async (t) => {
  const { application, root, waitForQuestion } = await setup(t, "question");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.openSession(alpha);
  const first = application.send(alpha, "Choose tests");
  const question = await waitForQuestion(alpha);
  assert.equal(question.question, "Which test suite should run?");
  await application.openSession(beta);
  application.answerQuestion(question.id, "Targeted");
  await first;
  assert.deepEqual(application.getState().questions, []);
  await application.openSession(alpha);
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Targeted; freeform: false/,
  );
  assert.ok(
    application
      .getState()
      .messages.some(
        (message) => message.role === "user" && message.content === "Targeted",
      ),
  );
  const second = application.send(alpha, "Custom answer");
  const next = await waitForQuestion(alpha);
  const restricted = application.askQuestion(alpha, {
    question: "Choose only",
    choices: ["One"],
    allowFreeform: false,
  });
  const restrictedId = application.getState().questions.at(-1)!.id;
  assert.throws(
    () => application.answerQuestion(restrictedId, "Other"),
    /proposed answers/,
  );
  application.answerQuestion(restrictedId, "One");
  assert.deepEqual(await restricted, { answer: "One", wasFreeform: false });
  application.answerQuestion(next.id, "Only changed files");
  await second;
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Only changed files; freeform: true/,
  );
  assert.throws(
    () => application.answerQuestion(next.id, "Again"),
    /no longer pending/,
  );
  const third = application.send(alpha, "Cancel this question");
  const rejected = assert.rejects(third, { name: "AbortError" });
  await waitForQuestion(alpha);
  application.cancel(alpha);
  await rejected;
  assert.deepEqual(application.getState().questions, []);
});

test("repository actions close lazily, archive fresh sessions and delete only that repository through the SDK", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.openSession(alpha);
  await application.send(alpha, "Remember FIRST");
  application.setDraft(alpha, "First draft");
  const firstId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  const originalPid = await pid(alpha);
  await application.closeSession(alpha);
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().draft, "First draft");
  await application.closeSession(beta);
  await assert.rejects(readFile(join(beta, "pid")), { code: "ENOENT" });
  await application.openSession(alpha);
  await application.send(alpha, "Recall FIRST");
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Remember FIRST/,
  );
  await application.newSession(alpha);
  assert.deepEqual(application.getState().messages, []);
  assert.equal(application.getState().draft, "");
  await application.send(alpha, "Remember SECOND");
  application.setDraft(alpha, "Second draft");
  const secondId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  await application.newSession(alpha);
  await application.send(alpha, "Remember THIRD");
  const thirdId = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === alpha)!.sessionId;
  assert.ok(firstId && secondId && thirdId);
  assert.equal(new Set([firstId, secondId, thirdId]).size, 3);
  assert.equal(application.getState().repositories[0]?.sessionCount, 3);
  await application.openSession(beta);
  await application.send(beta, "Do not touch BETA");
  const betaPid = await pid(beta);
  const betaSnapshot = application
    .getSnapshot()
    .sessions.find((entry) => entry.id === beta);
  const resumesBefore = (await requests(alpha)).filter(
    (entry) => entry.method === "session.resume",
  ).length;
  await application.deleteSessions(alpha, false);
  assert.equal(application.getState().activeId, beta);
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().repositories[0]?.sessionCount, 2);
  assert.equal(
    (await requests(alpha)).filter((entry) => entry.method === "session.resume")
      .length,
    resumesBefore,
  );
  assert.deepEqual(
    application.getSnapshot().sessions.find((entry) => entry.id === beta),
    betaSnapshot,
  );
  assert.doesNotThrow(() => process.kill(betaPid, 0));
  await application.openSession(alpha);
  assert.equal(application.getState().draft, "Second draft");
  assert.match(application.getState().messages.at(-1)?.content ?? "", /SECOND/);
  assert.doesNotMatch(
    application.getState().messages.at(-1)?.content ?? "",
    /FIRST|THIRD/,
  );
  await application.deleteSessions(alpha, true);
  assert.deepEqual(application.getState().messages, []);
  assert.equal(application.getState().draft, "");
  assert.equal(application.getState().repositories[0]?.sessionCount, 0);
  assert.equal(application.getState().repositories[0]?.status, "idle");
  assert.deepEqual(
    (await requests(alpha))
      .filter((entry) => entry.method === "session.delete")
      .map((entry) => entry.params?.sessionId),
    [thirdId, secondId, firstId],
  );
  assert.equal(
    (await requests(beta)).filter((entry) => entry.method === "session.delete")
      .length,
    0,
  );
  assert.deepEqual(
    application.getSnapshot().sessions.find((entry) => entry.id === beta),
    betaSnapshot,
  );
});

test("resuming an existing session restores archived transcripts or adopts sessions started elsewhere", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const sessionId = () =>
    application.getSnapshot().sessions.find((entry) => entry.id === alpha)!
      .sessionId!;
  await application.openSession(alpha);
  await application.send(alpha, "Remember FIRST");
  const firstId = sessionId();
  await application.newSession(alpha);
  await application.send(alpha, "Remember SECOND");
  const secondId = sessionId();
  await application.resumeSession(alpha, firstId);
  assert.equal(sessionId(), firstId);
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getState().repositories[0]?.sessionCount, 2);
  assert.match(application.getState().messages[0]?.content ?? "", /FIRST/);
  await application.send(alpha, "Recall");
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Remember FIRST/,
  );
  await application.resumeSession(alpha, firstId);
  assert.equal(application.getState().repositories[0]?.sessionCount, 2);
  await writeFile(
    join(alpha, "history-external.json"),
    JSON.stringify(["Remember EXTERNAL"]),
  );
  await application.resumeSession(alpha, "external");
  assert.equal(sessionId(), "external");
  assert.equal(application.getState().repositories[0]?.sessionCount, 3);
  assert.deepEqual(
    application.getState().messages.map((message) => message.role),
    ["system"],
  );
  assert.match(
    application.getState().messages[0]?.content ?? "",
    /Resumed existing Copilot session external/,
  );
  await application.send(alpha, "Recall");
  assert.match(
    application.getState().messages.at(-1)?.content ?? "",
    /Remember EXTERNAL/,
  );
  await application.resumeSession(alpha, secondId);
  assert.match(application.getState().messages[0]?.content ?? "", /SECOND/);
  await assert.rejects(
    application.resumeSession(alpha, "missing"),
    /Saved session not found/,
  );
});

test("archived histories persist and deletion failures retain remaining sessions for retry", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Keep older");
  const firstId = application.getSnapshot().sessions[0]!.sessionId;
  assert.ok(firstId);
  await application.newSession(alpha);
  await application.send(alpha, "Delete newer");
  await application.dispose();
  const storage = new ApplicationStorage(join(root, "storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(restored.getState().repositories[0]?.sessionCount, 2);
  await writeFile(join(alpha, "fail-delete-id"), firstId);
  await assert.rejects(restored.deleteSessions(alpha, true), /Deletion denied/);
  assert.equal(restored.getState().repositories[0]?.sessionCount, 1);
  assert.equal(restored.getSnapshot().sessions[0]?.sessionId, firstId);
  assert.match(
    restored.getState().messages.at(-1)?.content ?? "",
    /Keep older/,
  );
  assert.match(restored.getState().error ?? "", /Deletion denied/);
  await rm(join(alpha, "fail-delete-id"));
  await restored.deleteSessions(alpha, true);
  assert.equal(restored.getState().repositories[0]?.sessionCount, 0);
  await storage.save(restored.getSnapshot());
  const reopened = createApplication(await storage.load());
  await reopened.refresh();
  assert.equal(reopened.getState().repositories[0]?.sessionCount, 0);
  assert.deepEqual(reopened.getState().messages, []);
});

test("deletion clears local history if the recorded SDK session is already absent", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  assert.ok(sessionId);
  await application.closeSession(alpha);
  await rm(join(alpha, `history-${sessionId}.json`));
  await application.deleteSessions(alpha, false);
  assert.equal(application.getState().repositories[0]?.sessionCount, 0);
  assert.equal(
    (await requests(alpha)).filter((entry) => entry.method === "session.delete")
      .length,
    0,
  );
});

test("shutdown while deletion closes the old client prevents a replacement CLI from starting", async (t) => {
  const { application, root } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const child = await pid(alpha);
  const before = await requests(alpha);
  const deleting = application.deleteSessions(alpha, true);
  const rejected = assert.rejects(deleting, /closed/i);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await application.dispose();
  await rejected;
  assert.deepEqual(await requests(alpha), before);
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  assert.ok(application.getSnapshot().sessions[0]?.sessionId);
});

test("closing a busy repository keeps its resumable ID and deleting during shutdown is bounded", async (t) => {
  const { application, root } = await setup(t, "persist-hang");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  const sending = application.send(alpha, "Interrupted request");
  const interrupted = assert.rejects(sending, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await application.closeSession(alpha);
  await interrupted;
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  assert.equal(application.getState().repositories[0]?.status, "saved");
  assert.equal(application.getState().draft, "Interrupted request");
  assert.equal(application.getState().repositories[0]?.generation, 1);
  await writeFile(join(alpha, "scenario"), "hang:session.delete");
  const deleting = application.deleteSessions(alpha, true);
  const cancelled = assert.rejects(deleting, { name: "AbortError" });
  await waitForRequest(alpha, "session.delete");
  assert.throws(() => application.newSession(alpha), /already running/);
  await assert.rejects(application.openSession(alpha), /already running/);
  await application.dispose();
  await cancelled;
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  const child = await pid(alpha);
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
});

test("closing and reopening restores histories, drafts and SDK context lazily for each repository", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.openSession(alpha);
  await application.send(alpha, "Remember ALPHA.");
  application.setDraft(alpha, "Alpha unfinished draft");
  await application.openSession(beta);
  await application.send(beta, "Remember BETA.");
  application.setDraft(beta, "Beta unfinished draft");
  const pids = await Promise.all([pid(alpha), pid(beta)]);
  await application.dispose();
  for (const child of pids) {
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  }
  const storage = new ApplicationStorage(join(root, "extension storage"), root);
  await storage.save(application.getSnapshot());
  const restored = createApplication(await storage.load());
  await restored.refresh();
  assert.equal(restored.getState().activeId, beta);
  assert.equal(restored.getState().draft, "Beta unfinished draft");
  assert.ok(
    restored
      .getState()
      .messages.some((message) => message.content.includes("BETA")),
  );
  assert.ok(
    restored
      .getState()
      .repositories.every((repository) => repository.status === "saved"),
  );
  for (const directory of [alpha, beta]) {
    assert.equal(
      (await requests(directory)).filter(
        (request) => request.method === "session.resume",
      ).length,
      0,
    );
  }
  await restored.openSession(alpha);
  assert.equal(restored.getState().draft, "Alpha unfinished draft");
  await restored.send(alpha, "What did I say?");
  const answer = restored.getState().messages.at(-1)?.content ?? "";
  assert.match(answer, /ALPHA[\s\S]*What did I say/);
  assert.doesNotMatch(answer, /BETA/);
  assert.equal(restored.getState().draft, "");
  const log = (await readFile(join(alpha, "requests.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  const resume = log.find((request) => request.method === "session.resume");
  assert.equal(resume.params.continuePendingWork, false);
  assert.equal(resume.params.allowTranscriptRecovery, false);
  assert.equal(
    resume.params.sessionId,
    log.find((request) => request.method === "session.create").params.sessionId,
  );
});

test("closing during a request saves an interruption notice and never restarts pending work automatically", async (t) => {
  const { application, root, createApplication, snapshots } = await setup(
    t,
    "persist-hang",
  );
  const alpha = join(root, "alpha");
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => runCommand("git", args, alpha, signal);
  await git(["init", "--quiet"]);
  await writeFile(join(alpha, "tracked.txt"), "before\n");
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  await application.openSession(alpha);
  await writeFile(join(alpha, "tracked.txt"), "after shutdown\n");
  const running = application.send(alpha, "An interrupted question");
  const rejected = assert.rejects(running, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await application.dispose();
  await rejected;
  const saved = application.getSnapshot();
  const savedSession = saved.sessions.find((session) => session.id === alpha);
  assert.ok(savedSession?.sessionId);
  assert.equal(
    savedSession?.finalDiffSize,
    Buffer.byteLength(
      await git([
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        "HEAD",
        "--",
      ]),
      "utf8",
    ),
  );
  assert.ok(
    saved.sessions
      .find((session) => session.id === alpha)
      ?.messages.some((message) =>
        /interrupted when the application closed/.test(message.content),
      ),
  );
  const count = snapshots.length;
  await writeFile(join(alpha, "scenario"), "persist");
  const restored = createApplication(saved);
  await restored.refresh();
  await restored.openSession(alpha);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.sendAndWait",
    ).length,
    1,
  );
  assert.ok(snapshots.length > count);
  assert.equal(
    restored.getState().messages.filter((message) => message.role === "user")
      .length,
    1,
  );
});

test("a missing saved SDK session is reported and only an explicit restart starts fresh", async (t) => {
  const { application, root, createApplication } = await setup(t, "persist");
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Keep my displayed history.");
  await application.dispose();
  const saved = application.getSnapshot();
  await writeFile(join(alpha, "scenario"), "missing-resume");
  const restored = createApplication(saved);
  await restored.refresh();
  await assert.rejects(restored.openSession(alpha), /Saved session not found/);
  assert.match(
    restored.getState().error ?? "",
    /Could not resume.*New session/,
  );
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    1,
  );
  await restored.restart(alpha);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    2,
  );
  assert.ok(
    restored
      .getState()
      .messages.some((message) =>
        /Keep my displayed history/.test(message.content),
      ),
  );
  assert.notEqual(
    restored.getSnapshot().sessions.find((session) => session.id === alpha)
      ?.sessionId,
    saved.sessions.find((session) => session.id === alpha)?.sessionId,
  );
});

test("SDK events stream commands, separate output channels, reasoning and messages without duplicate final answers", async (t) => {
  const { application, root, snapshots, streamingChanges } = await setup(
    t,
    "events",
  );
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await application.openSession(alpha);
  assert.equal(application.getState().messages[0]?.title, "session.start");
  await application.send(alpha, "Show everything");
  assert.ok(streamingChanges.includes(true));
  const firstBusy = snapshots.findIndex((snapshot) =>
    snapshot.repositories.some(
      (repository) => repository.id === alpha && repository.status === "busy",
    ),
  );
  assert.notEqual(firstBusy, -1);
  assert.equal(streamingChanges[firstBusy], false);
  assert.equal(streamingChanges.at(-1), false);
  const transcript = application.getState().messages;
  const timings = transcript.find(
    (message) => message.role === "user",
  )!.timings!;
  assert.ok(timings.some((step) => step.kind === "generation"));
  assert.ok(
    timings.some((step) => step.kind === "tool" && step.name === "bash"),
  );
  assert.ok(
    timings.every((step) => step.end !== undefined && step.end >= step.start),
  );
  assert.ok(
    snapshots.some((snapshot) =>
      snapshot.messages.some((message) =>
        message.timings?.some((step) => step.end === undefined),
      ),
    ),
  );
  const fragments = transcript.filter(
    (message) => message.title === `Tool input: bash`,
  );
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0]?.role, "system");
  assert.equal(fragments[0]?.content, '{"command":"gh pr list\\nprintf done"}');
  assert.ok(
    transcript.some(
      (message) =>
        message.title === "tool.execution_progress" &&
        message.role === "system",
    ),
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "tool" && message.title === "bash - completed",
    ),
  );
  assert.ok(
    transcript.some(
      (message) => message.error && message.content === "Command failed",
    ),
  );
  assert.equal(
    transcript.filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(
    transcript.filter((message) => message.role === "reasoning").length,
    1,
  );
  assert.equal(
    transcript.find((message) => message.role === "reasoning")?.content,
    "Inspect the repository.",
  );
  assert.equal(
    transcript.find((message) => message.role === "tool")?.content,
    "gh pr list\nprintf done",
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "output" && message.content === "first\nsecond\n",
    ),
  );
  assert.ok(
    transcript.some(
      (message) => message.role === "output" && message.content === "warning\n",
    ),
  );
  const toolCallId = transcript.find(
    (message) => message.role === "tool",
  )?.toolCallId;
  assert.ok(toolCallId);
  assert.equal(
    transcript.filter(
      (message) =>
        message.role === "output" && message.toolCallId === toolCallId,
    ).length,
    3,
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.role === "output" && message.content === "Command failed",
    ),
  );
  assert.equal(
    transcript.filter(
      (message) => message.role === "assistant" && !message.agentId,
    ).length,
    1,
  );
  assert.ok(
    transcript.some(
      (message) =>
        message.agentId === "child-agent" &&
        message.content === "Subagent answer",
    ),
  );
  assert.ok(
    snapshots.some(
      (snapshot) =>
        snapshot.repositories.find((repository) => repository.id === alpha)
          ?.status === "busy" &&
        snapshot.messages.some((message) => message.role === "output") &&
        !snapshot.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === "## Fixture answer",
        ),
    ),
  );
  await application.openSession(beta);
  assert.equal(
    application.getState().messages.some((message) => message.role === "tool"),
    false,
  );
  await application.openSession(alpha);
  await application.send(alpha, "Again");
  assert.equal(
    application
      .getState()
      .messages.filter(
        (message) => message.role === "assistant" && !message.agentId,
      ).length,
    2,
  );
});

test("switching repositories during a request does not misroute messages or cancellation", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await writeFile(join(alpha, "scenario"), "hang:session.sendAndWait");
  await application.openSession(alpha);
  const running = application.send(alpha, "Stay in alpha");
  const rejected = assert.rejects(running, { name: "AbortError" });
  await application.openSession(beta);
  await assert.rejects(
    application.send(alpha, "Wrong selected repository"),
    /ready repository/,
  );
  assert.equal(application.getState().activeId, beta);
  assert.deepEqual(application.getState().messages, []);
  application.cancel(alpha);
  await rejected;
  assert.deepEqual(application.getState().messages, []);
  assert.equal(
    application
      .getState()
      .repositories.find((repository) => repository.id === alpha)?.status,
    "error",
  );
  const cancelled = await pid(alpha);
  assert.throws(() => process.kill(cancelled, 0), { code: "ESRCH" });
  await application.send(beta, "Beta still works");
  assert.match(
    application.getState().messages[1]?.content ?? "",
    /Beta still works/,
  );
});

test("a startup timeout is visible, reaps the CLI and allows an explicit restart", async (t) => {
  const { application, root } = await setup(t, "hang:connect", 1_000);
  const alpha = join(root, "alpha");
  await assert.rejects(application.openSession(alpha), /timed out/);
  assert.match(application.getState().error ?? "", /timed out/);
  const stopped = await pid(alpha);
  assert.throws(() => process.kill(stopped, 0), { code: "ESRCH" });
  await writeFile(join(alpha, "scenario"), "conversation");
  await Promise.all([
    application.openSession(alpha),
    application.openSession(alpha),
  ]);
  assert.equal(
    application
      .getState()
      .repositories.find((repository) => repository.id === alpha)?.status,
    "ready",
  );
  assert.equal(application.getState().messages[0]?.role, "system");
});

test("a crashed process resumes its session without replaying the original prompt, then drains queued work", async (t) => {
  const { application, root, waitForRecovery } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await writeFile(join(alpha, "crashes-left"), "1");
  await application.openSession(alpha);
  const originalPid = await pid(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  const sending = application.send(alpha, "Finish the original task");
  await waitForRecovery();
  const queued = application.send(alpha, "Run this only after recovery", false);
  await Promise.all([sending, queued]);
  const log = await requests(alpha);
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  assert.deepEqual(
    log
      .filter((request) => request.method === "session.resume")
      .map((request) => request.params?.sessionId),
    [sessionId],
  );
  const prompts = log
    .filter((request) => request.method === "session.sendAndWait")
    .map((request) => request.params?.prompt);
  assert.equal(prompts.length, 3);
  assert.notEqual(prompts[1], prompts[0]);
  assert.match(prompts[1] ?? "", /Do not blindly repeat commands/);
  assert.ok(prompts[1]?.includes(prompts[0]!));
  assert.match(prompts[2] ?? "", /Run this only after recovery/);
  const state = application.getState();
  assert.equal(state.repositories[0]?.status, "ready");
  assert.equal(state.error, undefined);
  assert.equal(
    state.messages.filter((message) => message.role === "user").length,
    2,
  );
  assert.ok(
    state.messages.some(
      (message) =>
        message.error && /Automatic recovery 1\/3/.test(message.content),
    ),
  );
  assert.ok(
    state.messages.some(
      (message) => message.title === "bash - interrupted" && message.error,
    ),
  );
  assert.ok(
    state.messages.some(
      (message) => message.content === "Partial answer before the crash",
    ),
  );
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
});

test("repeated process crashes stop after three restarts and preserve context for explicit recovery", async (t) => {
  const { application, root } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await writeFile(join(alpha, "crashes-left"), "4");
  await application.openSession(alpha);
  const sessionId = application.getSnapshot().sessions[0]?.sessionId;
  await assert.rejects(
    application.send(alpha, "Keep the failed task"),
    /after 3 automatic restarts/,
  );
  const log = await requests(alpha);
  assert.equal(log.filter((request) => request.method === "connect").length, 4);
  assert.equal(
    log.filter((request) => request.method === "session.resume").length,
    3,
  );
  assert.equal(
    log.filter((request) => request.method === "session.create").length,
    1,
  );
  assert.equal(application.getState().repositories[0]?.status, "error");
  assert.equal(application.getState().draft, "Keep the failed task");
  assert.ok(
    application
      .getState()
      .messages.filter((message) => message.role === "tool")
      .every((message) => message.title?.endsWith(" - interrupted")),
  );
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
  const pids = (await readFile(join(alpha, "pids"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  for (const child of pids)
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  await application.openSession(alpha);
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.equal(application.getSnapshot().sessions[0]?.sessionId, sessionId);
});

test("cancelling or closing during crash recovery prevents another process or prompt from starting", async (t) => {
  for (const action of ["cancel", "dispose"]) {
    await t.test(action, async (t) => {
      const { application, root, waitForRecovery } = await setup(
        t,
        "crash:session.sendAndWait",
        15_000,
      );
      const alpha = join(root, "alpha");
      await writeFile(join(alpha, "crashes-left"), "4");
      await application.openSession(alpha);
      const sending = application.send(alpha, "Cancel this recovery");
      const cancelled = assert.rejects(sending, { name: "AbortError" });
      await waitForRecovery();
      if (action === "cancel") application.cancel(alpha);
      else await application.dispose();
      await cancelled;
      const log = await requests(alpha);
      assert.equal(
        log.filter((request) => request.method === "connect").length,
        1,
      );
      assert.equal(
        log.filter((request) => request.method === "session.sendAndWait")
          .length,
        1,
      );
      const child = Number(
        (await readFile(join(alpha, "pids"), "utf8")).trim(),
      );
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    });
  }
});

test("an idle process crash reconnects on the next message without losing the previous context", async (t) => {
  const { application, root } = await setup(
    t,
    "crash:session.sendAndWait",
    15_000,
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  await application.send(alpha, "Remember the first request");
  process.kill(await pid(alpha), "SIGKILL");
  await application.send(alpha, "Now complete the second request");
  assert.equal(application.getState().repositories[0]?.status, "ready");
  const answer = application.getState().messages.at(-1)?.content ?? "";
  assert.match(answer, /Remember the first request/);
  assert.match(answer, /Now complete the second request/);
  assert.equal(
    (await requests(alpha)).filter(
      (request) => request.method === "session.create",
    ).length,
    1,
  );
});

test("a parallel process recovers independently without stopping the main request", async (t) => {
  const { application, root } = await setup(t, "persist-hang", 15_000);
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const mainPid = await pid(alpha);
  const main = application.send(alpha, "Keep working in the main session");
  const cancelled = assert.rejects(main, { name: "AbortError" });
  await waitForRequest(alpha, "session.sendAndWait");
  await writeFile(join(alpha, "scenario"), "crash:session.sendAndWait");
  await writeFile(join(alpha, "crashes-left"), "1");
  await application.send(alpha, "Recover only this side request");
  assert.equal(application.getState().repositories[0]?.status, "busy");
  assert.ok(
    application
      .getState()
      .messages.some((message) =>
        message.title?.includes(": Copilot recovery"),
      ),
  );
  assert.doesNotThrow(() => process.kill(mainPid, 0));
  application.cancel(alpha);
  await cancelled;
});

test("a crash while awaiting approval discards the obsolete permission and requires a fresh decision after recovery", async (t) => {
  const { application, root, waitForPermission } = await setup(
    t,
    "crash:permission",
    15_000,
  );
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const child = await pid(alpha);
  const sending = application.send(alpha, "Continue after explicit approval");
  const original = await waitForPermission(alpha);
  process.kill(child, "SIGKILL");
  const recovered = await waitForPermission(alpha, original.id);
  assert.notEqual(recovered.id, original.id);
  assert.equal(application.getState().permissions.length, 1);
  assert.throws(
    () => application.respondToPermission(original.id, true),
    /no longer pending/,
  );
  application.respondToPermission(recovered.id, true);
  await sending;
  assert.equal(application.getState().repositories[0]?.status, "ready");
  assert.deepEqual(application.getState().permissions, []);
});

test("startup process crashes are retried but authentication errors are not", async (t) => {
  for (const scenario of ["crash:connect", "unauthenticated"]) {
    await t.test(scenario, async (t) => {
      const { application, root } = await setup(t, scenario, 15_000);
      const alpha = join(root, "alpha");
      await writeFile(join(alpha, "crashes-left"), "1");
      if (scenario === "unauthenticated")
        await assert.rejects(
          application.openSession(alpha),
          /Not authenticated/,
        );
      else {
        await application.openSession(alpha);
        assert.equal(application.getState().repositories[0]?.status, "ready");
      }
      assert.equal(
        (await requests(alpha)).filter(
          (request) => request.method === "connect",
        ).length,
        scenario === "unauthenticated" ? 1 : 2,
      );
    });
  }
});

test("unknown paths and malformed UI messages cannot start sessions", async (t) => {
  const { application, root } = await setup(t);
  assert.deepEqual(parseApplicationMessage({ type: "settings" }), {
    type: "settings",
  });
  for (const type of [
    "local-devices",
    "local-model",
    "copilot-models",
    "foundry-cancel",
  ])
    assert.deepEqual(parseApplicationMessage({ type }), { type });
  assert.deepEqual(
    parseApplicationMessage({ type: "foundry-models", device: "gpu" }),
    { type: "foundry-models", device: "gpu" },
  );
  assert.throws(
    () => parseApplicationMessage({ type: "foundry-models", device: "cuda" }),
    /Invalid Foundry Local device/,
  );
  const foundryId = "azureml://registries/azureml/models/phi-cpu/versions/2";
  assert.deepEqual(
    parseApplicationMessage({ type: "foundry-download", id: foundryId }),
    { type: "foundry-download", id: foundryId },
  );
  for (const id of ["https://example.com/model", `${foundryId}/../x`, 3])
    assert.throws(
      () => parseApplicationMessage({ type: "foundry-download", id }),
      /Invalid Foundry Local model ID/,
    );
  assert.deepEqual(
    parseApplicationMessage({ type: "copilot-model", model: "gpt-5" }),
    { type: "copilot-model", model: "gpt-5" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "copilot-model", model: "" }),
    { type: "copilot-model", model: "" },
  );
  for (const model of [" gpt", "a b", "x".repeat(201), 3])
    assert.throws(
      () => parseApplicationMessage({ type: "copilot-model", model }),
      /Invalid Copilot model/,
    );
  assert.throws(() =>
    parseApplicationMessage({ type: "change-model", id: "alpha" }),
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "local-device",
      provider: "cuda",
      deviceId: 1,
    }),
    { type: "local-device", provider: "cuda", deviceId: 1 },
  );
  for (const invalid of [
    { provider: "gpu", deviceId: 0 },
    { provider: "cuda", deviceId: -2 },
    { provider: "cuda", deviceId: 0.5 },
    { provider: "cuda", deviceId: "0" },
    { provider: "auto", deviceId: 0 },
  ])
    assert.throws(
      () => parseApplicationMessage({ type: "local-device", ...invalid }),
      /Invalid local inference device/,
    );
  assert.deepEqual(
    parseApplicationMessage({
      type: "local-placement",
      modelPath: "/models/tiny",
      placement: { provider: "disk" },
    }),
    {
      type: "local-placement",
      modelPath: "/models/tiny",
      placement: { provider: "disk" },
    },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "local-placement",
      modelPath: "/models/tiny",
      placement: { provider: "cuda", deviceId: 0 },
    }),
    {
      type: "local-placement",
      modelPath: "/models/tiny",
      placement: { provider: "cuda", deviceId: 0 },
    },
  );
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "local-placement",
        modelPath: "/models/tiny",
        placement: { provider: "gpu", deviceId: 0 },
      }),
    /Invalid local inference placement/,
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "transfer-session",
      id: "alpha",
      view: "local",
    }),
    { type: "transfer-session", id: "alpha", view: "local" },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "cancel",
      id: "alpha",
      view: "local",
    }),
    { type: "cancel", id: "alpha", view: "local" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "open-session", id: "alpha" }),
    {
      type: "open-session",
      id: "alpha",
    },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "open-local-session", id: "alpha" }),
    {
      type: "open-local-session",
      id: "alpha",
    },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "export-session", id: "alpha" }),
    { type: "export-session", id: "alpha" },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "annotate-session",
      id: "alpha",
      recordId: "record",
      annotation: null,
    }),
    {
      type: "annotate-session",
      id: "alpha",
      recordId: "record",
      annotation: null,
    },
  );
  assert.throws(
    () =>
      parseApplicationMessage({
        type: "annotate-session",
        id: "alpha",
        recordId: "record",
        annotation: { mark: "failure", reason: " " },
      }),
    /reason/,
  );
  await assert.rejects(
    application.select(join(root, "alpha", "..")),
    /Unknown repository/,
  );
  await assert.rejects(
    application.openSession(join(root, "alpha", "..")),
    /Unknown repository/,
  );
  await assert.rejects(
    application.send(join(root, "alpha"), "Too early"),
    /ready repository/,
  );
  for (const value of [
    null,
    {},
    { type: "select", id: 1 },
    { type: "open-session", id: 1 },
    { type: "export-session", id: 1 },
    { type: "send", id: "alpha", question: {} },
    { type: "send", id: "alpha", question: "Hello", parallel: "false" },
    { type: "openExternal", url: "command:workbench.action.terminal.new" },
    { type: "openExternal", url: "javascript:alert(1)" },
    { type: "openExternal", url: "file:///etc/passwd" },
    { type: "openExternal", url: "not a URL" },
    { type: "openExternal", url: 1 },
    { type: "draft", id: "alpha", text: 1 },
    { type: "draft", id: "alpha", text: "x".repeat(20_001) },
    { type: "draft", id: "alpha", text: "text", view: "other" },
    {
      type: "local-placement",
      modelPath: "/models/tiny",
      placement: { provider: "cuda", deviceId: -2 },
    },
    { type: "permission", id: "request", approve: "true" },
    { type: "permission", id: "request" },
    { type: "permission", id: 1, approve: true },
    { type: "answer", id: "request", answer: "" },
    { type: "answer", id: "request", answer: true },
    { type: "answer", id: "request", answer: "x".repeat(20_001) },
    { type: "delete-all-sessions", id: 1 },
    { type: "delete-session", id: "alpha" },
  ]) {
    assert.throws(() => parseApplicationMessage(value));
  }
  assert.deepEqual(
    parseApplicationMessage({
      type: "answer",
      id: "question",
      answer: "Targeted",
    }),
    { type: "answer", id: "question", answer: "Targeted" },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "permission",
      id: "request",
      approve: false,
    }),
    { type: "permission", id: "request", approve: false },
  );
  assert.deepEqual(
    parseApplicationMessage({
      type: "openExternal",
      url: "https://example.com",
    }),
    { type: "openExternal", url: "https://example.com" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "draft", id: "alpha", text: "" }),
    { type: "draft", id: "alpha", text: "" },
  );
  assert.deepEqual(
    parseApplicationMessage({ type: "send", id: "alpha", question: "Hello" }),
    {
      type: "send",
      id: "alpha",
      question: "Hello",
    },
  );
  await assert.rejects(readFile(join(root, "alpha", "pid")), {
    code: "ENOENT",
  });
});

test("closing the application before startup completes prevents late CLI spawning", async (t) => {
  const { application, root } = await setup(t);
  const starting = application.openSession(join(root, "alpha"));
  const rejected = assert.rejects(starting, /closed/);
  await application.dispose();
  await rejected;
  await assert.rejects(readFile(join(root, "alpha", "pid")), {
    code: "ENOENT",
  });
});

test("refresh preserves existing sessions and stops repositories no longer listed", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  await application.openSession(alpha);
  const child = await pid(alpha);
  await application.refresh();
  assert.equal(await pid(alpha), child);
  await rm(join(alpha, ".git"), { recursive: true });
  await application.refresh();
  assert.equal(application.getState().activeId, undefined);
  assert.deepEqual(
    application.getState().repositories.map((repository) => repository.name),
    ["beta"],
  );
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
});

test("opening a local session shows startup immediately while the model is prepared", async (t) => {
  const { application, root } = await setup(t);
  const alpha = join(root, "alpha");
  let finishPreparing!: () => void;
  const preparing = new Promise<void>((resolve) => {
    finishPreparing = resolve;
  });
  const create = () =>
    new LocalConversation(
      {
        load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
        generateChat: async () => {},
        stop: async () => {},
      },
      "/model",
    );
  const opening = application.openLocalSession(alpha, create, () => preparing);
  const local = () => application.getState().repositories[0]!.localSession;
  assert.equal(local()?.status, "starting");
  await application.openLocalSession(alpha, () => {
    throw new Error("The existing local session is already open.");
  });
  finishPreparing();
  await opening;
  assert.equal(local()?.status, "ready");
});
