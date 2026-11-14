import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ApplicationStorage, type SavedApplication } from "../src/storage";
import { testImage } from "./helpers";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "devdash-agents-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshot: SavedApplication = {
    version: 1,
    root: "/projects",
    activeId: "/projects/alpha",
    sessions: [
      {
        id: "/projects/alpha",
        sessionId: "saved-session",
        draft: "Unfinished",
        messages: [{ role: "user", content: "Remember this" }],
      },
    ],
  };
  return { directory, snapshot };
}

test("history saves are atomic, serialized, private and isolated by launch root", async (t) => {
  const { directory, snapshot } = await setup(t);
  snapshot.sessions[0]!.messages.push({
    role: "output",
    content: "Command failed",
    error: true,
    images: [testImage],
  });

  snapshot.sessions[0]!.history = [
    {
      sessionId: "older-session",
      draft: "Older draft",
      messages: [
        { role: "user", content: "Earlier conversation", images: [testImage] },
      ],
    },
  ];
  const storage = new ApplicationStorage(directory, snapshot.root);
  assert.equal(
    dirname(storage.filename),
    join(directory, ".cache", "devdash-agents", "conversations"),
  );
  assert.equal(await storage.load(), undefined);
  const later = {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      draft: "Latest draft",
    })),
  };
  await Promise.all([storage.save(snapshot), storage.save(later)]);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.load())), later);
  assert.equal(
    await new ApplicationStorage(directory, "/other-root").load(),
    undefined,
  );
  assert.equal(
    (await readdir(dirname(storage.filename))).filter((name) =>
      name.endsWith(".tmp"),
    ).length,
    0,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(storage.filename)).mode & 0o777, 0o600);
  }
});

test("tool call identifiers persist and are validated", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  Object.assign(snapshot.sessions[0]!.messages[0]!, { toolCallId: "call-1" });
  await storage.save(snapshot);
  assert.equal(
    (await storage.load())!.sessions[0]!.messages[0]!.toolCallId,
    "call-1",
  );
  Object.assign(snapshot.sessions[0]!.messages[0]!, { toolCallId: 1 });
  assert.throws(() => storage.save(snapshot), /Invalid conversation/);
});

test("record message boundaries persist and are validated", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  snapshot.sessions[0]!.recordMessageStart = 1;
  await storage.save(snapshot);
  assert.equal((await storage.load())!.sessions[0]!.recordMessageStart, 1);
  for (const invalid of [-1, 2, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(snapshot);
    bad.sessions[0]!.recordMessageStart = invalid;
    assert.throws(() => storage.save(bad), /Invalid conversation/);
  }
});

test("step timings persist, validate bounds and freeze interrupted steps on disk", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  const message = snapshot.sessions[0]!.messages[0]!;
  message.timings = [
    { kind: "generation", name: "Token generation", start: 1000, end: 3000 },
    { kind: "tool", name: "read_file", start: 3000, agentId: "child" },
  ];
  await storage.save(snapshot);
  assert.deepEqual((await storage.load())!.sessions[0]!.messages[0]!.timings, [
    message.timings[0],
    { ...message.timings[1], end: 3000 },
  ]);
  for (const invalid of [
    { ...message.timings[0], start: -1 },
    { ...message.timings[0], end: 500 },
    { ...message.timings[0], start: Infinity },
    { ...message.timings[0], kind: "unknown" },
    { ...message.timings[0], name: {} },
  ]) {
    const bad = structuredClone(snapshot);
    Object.assign(bad.sessions[0]!.messages[0]!, { timings: [invalid] });
    assert.throws(() => storage.save(bad), /Invalid conversation/);
  }
});

test("timing throughput survives save and reload, including archived and local sessions", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  const timing = {
    kind: "generation" as const,
    name: "Token generation",
    start: 1000,
    end: 3000,
    outputTokens: 40,
  };
  const conversation = {
    draft: "",
    messages: [{ role: "user" as const, content: "Run", timings: [timing] }],
  };
  const repository = snapshot.sessions[0]!;
  repository.messages = conversation.messages;
  repository.history = [structuredClone(conversation)];
  repository.localSessions = [
    { id: "local", ...structuredClone(conversation) },
  ];
  repository.copilotSessions = [
    { id: "copilot", ...structuredClone(conversation) },
  ];
  await storage.save(snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.load())), snapshot);
  timing.outputTokens = 0;
  await storage.save(snapshot);
  assert.equal(
    (await storage.load())!.sessions[0]!.messages[0]!.timings![0]!.outputTokens,
    0,
  );
});

test("concurrent instances with distinct roots never overwrite each other's history", async (t) => {
  const { directory, snapshot } = await setup(t);
  const snapshots = ["/workspace-one/project", "/workspace-two/project"].map(
    (root, index): SavedApplication => ({
      ...snapshot,
      root,
      activeId: root,
      sessions: [
        {
          id: root,
          sessionId: `session-${index}`,
          draft: `Draft ${index}`,
          messages: [{ role: "user", content: `Repository ${index}` }],
        },
      ],
    }),
  );
  const stores = snapshots.map(
    (value) => new ApplicationStorage(directory, value.root),
  );
  assert.notEqual(stores[0]!.filename, stores[1]!.filename);
  await Promise.all(
    stores.map((storage, index) => storage.save(snapshots[index]!)),
  );
  snapshots[0]!.sessions[0]!.draft = "Updated first instance";
  await stores[0]!.save(snapshots[0]!);
  for (const value of snapshots)
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          await new ApplicationStorage(directory, value.root).load(),
        ),
      ),
      value,
    );
  assert.equal(
    (await readdir(dirname(stores[0]!.filename))).filter((name) =>
      name.endsWith(".tmp"),
    ).length,
    0,
  );
});

test("invalid timing token counts are rejected on save and load without changing history", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  const previous = await readFile(storage.filename, "utf8");
  for (const outputTokens of [-1, 0.5, "12", null, 2 ** 53]) {
    const invalid = structuredClone(snapshot);
    Object.assign(invalid.sessions[0]!.messages[0]!, {
      timings: [
        {
          kind: "generation",
          name: "Token generation",
          start: 1000,
          end: 3000,
          outputTokens,
        },
      ],
    });
    assert.throws(() => storage.save(invalid), /Invalid conversation/);
    assert.equal(await readFile(storage.filename, "utf8"), previous);
    const corrupt = JSON.stringify(invalid);
    await writeFile(storage.filename, corrupt);
    await assert.rejects(storage.load(), /Invalid conversation/);
    assert.equal(await readFile(storage.filename, "utf8"), corrupt);
    await writeFile(storage.filename, previous);
  }
});

test("local slots preserve independent current conversations, drafts and history without changing legacy snapshots", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  const legacy = JSON.parse(await readFile(storage.filename, "utf8"));
  assert.deepEqual(legacy, snapshot);
  assert.equal("localSessions" in legacy.sessions[0]!, false);
  assert.equal("selectedLocalSessionId" in legacy.sessions[0]!, false);

  const repository = snapshot.sessions[0]!;
  repository.history = [
    { draft: "Legacy draft", messages: [{ role: "user", content: "Legacy" }] },
  ];
  repository.localSessions = [
    {
      id: "first",
      backend: "local",
      sessionId: "first-current",
      draft: "First draft",
      messages: [{ role: "user", content: "First conversation" }],
      history: [
        {
          sessionId: "first-archived",
          draft: "First archived draft",
          messages: [{ role: "assistant", content: "First archive" }],
        },
      ],
    },
    {
      id: "s".repeat(100),
      backend: "local",
      draft: "Second draft",
      messages: [{ role: "assistant", content: "Second conversation" }],
      history: [
        {
          draft: "Second archived draft",
          messages: [{ role: "user", content: "Second archive" }],
        },
      ],
    },
  ];
  repository.selectedLocalSessionId = repository.localSessions[1]!.id;
  repository.copilotSessions = [
    {
      id: "second-copilot",
      backend: "copilot",
      sessionId: "copilot-current",
      draft: "Copilot draft",
      messages: [{ role: "user", content: "Copilot conversation" }],
      history: [
        {
          draft: "",
          messages: [{ role: "assistant", content: "Copilot archive" }],
        },
      ],
    },
  ];
  repository.selectedCopilotSessionId = "second-copilot";
  repository.view = "copilot";
  const expected = structuredClone(snapshot);
  const saving = storage.save(snapshot);
  repository.localSessions[0]!.draft = "Changed after save";
  repository.localSessions[1]!.history![0]!.messages[0]!.content =
    "Changed after save";
  await saving;
  const loaded = await storage.load();
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), expected);
  loaded!.sessions[0]!.localSessions![0]!.messages[0]!.content = "Changed load";
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.load())), expected);
});

test("invalid local slots and selected IDs are rejected on save and load", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  const local = { id: "first", draft: "", messages: [] };
  for (const fields of [
    { localSessions: {} },
    { localSessions: [null] },
    ...[
      "",
      " ",
      "first slot",
      "local:first",
      "first.slot",
      "s".repeat(101),
      null,
      1,
    ].map((id) => ({
      localSessions: [{ ...local, id }],
    })),
    { localSessions: [local, local] },
    { localSessions: [{ ...local, draft: null }] },
    { localSessions: [{ ...local, history: {} }] },
    { localSessions: [{ ...local, history: [{}] }] },
    ...["", "missing", null, 1].map((selectedLocalSessionId) => ({
      localSessions: [local],
      selectedLocalSessionId,
    })),
    { selectedLocalSessionId: "first" },
    { localSessions: [], selectedLocalSessionId: "first" },
    ...["", null, 1, "local:first"].map((view) => ({ view })),
    { copilotSessions: {} },
    { copilotSessions: [null] },
    { copilotSessions: [local, local] },
    { copilotSessions: [{ ...local, id: "bad id" }] },
    { copilotSessions: [{ ...local, history: [{}] }] },
    { copilotSessions: [local], selectedCopilotSessionId: "missing" },
    { selectedCopilotSessionId: "first" },
  ]) {
    const bad = structuredClone(snapshot);
    Object.assign(bad.sessions[0]!, fields);
    const previous = await readFile(storage.filename, "utf8");
    assert.throws(() => storage.save(bad), /Invalid/);
    assert.equal(await readFile(storage.filename, "utf8"), previous);
    const corrupt = JSON.stringify(bad);
    await writeFile(storage.filename, corrupt);
    await assert.rejects(storage.load(), /Invalid/);
    assert.equal(await readFile(storage.filename, "utf8"), corrupt);
  }
});

test("corrupt or mismatched history fails explicitly without overwriting the saved data", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  for (const corrupt of [
    "{broken",
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, root: "/different-root" }),
    JSON.stringify({
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], history: [{}] }],
    }),
    JSON.stringify({
      ...snapshot,
      sessions: [{ ...snapshot.sessions[0], postMortem: {} }],
    }),
    JSON.stringify({
      ...snapshot,
      sessions: [
        {
          ...snapshot.sessions[0],
          messages: [
            {
              role: "user",
              content: "bad",
              images: [{ ...testImage, dataUrl: "file:///private.png" }],
            },
          ],
        },
      ],
    }),
    JSON.stringify({
      ...snapshot,
      sessions: [
        {
          id: "alpha",
          draft: "",
          messages: [{ role: "script", content: "bad" }],
        },
      ],
    }),
  ]) {
    await writeFile(storage.filename, corrupt);
    await assert.rejects(storage.load());
    assert.equal(await readFile(storage.filename, "utf8"), corrupt);
  }
});

test("generated token counts are optional, round-trip in current and archived sessions, and reject invalid values", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  assert.equal((await storage.load())?.sessions[0]?.generatedTokens, undefined);
  snapshot.sessions[0]!.generatedTokens = 1234;
  snapshot.sessions[0]!.history = [
    { draft: "", messages: [], generatedTokens: 0 },
  ];
  await storage.save(snapshot);
  const loaded = await storage.load();
  assert.equal(loaded?.sessions[0]?.generatedTokens, 1234);
  assert.equal(loaded?.sessions[0]?.history?.[0]?.generatedTokens, 0);
  for (const generatedTokens of [-1, 0.5, "12", null, 2 ** 53]) {
    await writeFile(
      storage.filename,
      JSON.stringify({
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], generatedTokens }],
      }),
    );
    await assert.rejects(storage.load(), /Invalid conversation/);
  }
});

test("backend provenance is optional, round-trips current and archived chats, and rejects invalid values", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  await storage.save(snapshot);
  assert.equal((await storage.load())?.sessions[0]?.backend, undefined);
  snapshot.sessions[0]!.backend = "local";
  snapshot.sessions[0]!.history = [
    { backend: "copilot", draft: "", messages: [] },
    { backend: "local", draft: "", messages: [] },
  ];
  await storage.save(snapshot);
  const loaded = await storage.load();
  assert.equal(loaded?.sessions[0]?.backend, "local");
  assert.deepEqual(
    loaded?.sessions[0]?.history?.map((conversation) => conversation.backend),
    ["copilot", "local"],
  );
  for (const backend of ["", "external", null, 0, {}]) {
    for (const session of [
      { ...snapshot.sessions[0], backend },
      {
        ...snapshot.sessions[0],
        history: [{ draft: "", messages: [], backend }],
      },
    ]) {
      await writeFile(
        storage.filename,
        JSON.stringify({ ...snapshot, sessions: [session] }),
      );
      await assert.rejects(storage.load(), /Invalid conversation/);
    }
  }
});

test("dataset metadata survives storage and rejects invalid annotations", async (t) => {
  const { directory, snapshot } = await setup(t);
  const storage = new ApplicationStorage(directory, snapshot.root);
  snapshot.sessions[0]!.recordId = "record";
  snapshot.sessions[0]!.models = ["model-a", "model-b"];
  snapshot.sessions[0]!.finalDiffSize = 0;
  snapshot.sessions[0]!.annotation = {
    mark: "abandon",
    reason: "Requirements changed",
    comments: "Not finished",
  };
  await storage.save(snapshot);
  const loaded = await storage.load();
  assert.equal(loaded?.sessions[0]?.recordId, "record");
  assert.deepEqual(loaded?.sessions[0]?.models, ["model-a", "model-b"]);
  assert.equal(loaded?.sessions[0]?.finalDiffSize, 0);
  assert.deepEqual(
    loaded?.sessions[0]?.annotation,
    snapshot.sessions[0]!.annotation,
  );
  for (const annotation of [
    { mark: "failure" },
    { mark: "abandon", reason: "  " },
    { mark: "other", reason: "wrong mark" },
    { mark: "success", comments: "x".repeat(20_001) },
  ]) {
    await writeFile(
      storage.filename,
      JSON.stringify({
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], annotation }],
      }),
    );
    await assert.rejects(storage.load(), /mark|reason/i);
  }
  for (const finalDiffSize of [-1, 0.5, "12", Number.MAX_SAFE_INTEGER + 1]) {
    await writeFile(
      storage.filename,
      JSON.stringify({
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], finalDiffSize }],
      }),
    );
    await assert.rejects(storage.load(), /Invalid conversation/);
  }
});

test("save failures propagate and a later save can retry after the storage directory is repaired", async (t) => {
  const { directory, snapshot } = await setup(t);
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "not a directory");
  const storage = new ApplicationStorage(blocked, snapshot.root);
  await assert.rejects(storage.save(snapshot));
  await rm(blocked);
  await mkdir(blocked);
  await storage.save(snapshot);
  assert.equal((await storage.load())?.sessions[0]?.draft, "Unfinished");
});
