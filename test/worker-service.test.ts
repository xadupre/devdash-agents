import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { copilotSessionConfig } from "../src/copilot";
import { LocalWorker, type LocalChatMessage } from "../src/local-worker";
import { startWorkerService } from "../src/worker-service";

type Worker = Parameters<typeof startWorkerService>[0]["worker"];

async function setup(t: TestContext, worker?: Worker) {
  const native =
    worker ??
    new LocalWorker(process.execPath, [
      join(__dirname, "fixtures", "local-worker.js"),
    ]);
  if (native instanceof LocalWorker) await native.load("fixture");
  const apiKey = randomUUID();
  const service = await startWorkerService({
    worker: native,
    model: "fixture",
    apiKey,
    maxLength: 1024,
  });
  t.after(async () => {
    await service.close();
    if (native instanceof LocalWorker) await native.stop();
  });
  const headers = {
    authorization: ["Bearer", apiKey].join(" "),
    "content-type": "application/json",
  };
  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(`${service.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  return { ...service, headers, post };
}

const request = {
  model: "fixture",
  messages: [{ role: "user", content: "Hello" }],
};
const tools = [
  {
    type: "function",
    function: {
      name: "inspect_repository",
      description: "Inspect repository files.",
      parameters: { type: "object", properties: {} },
    },
  },
];

test("service authenticates requests and rejects browser origins", async (t) => {
  const service = await setup(t);
  assert.equal((await fetch(`${service.baseUrl}/models`)).status, 401);
  assert.equal(
    (
      await fetch(`${service.baseUrl}/models`, {
        headers: { authorization: "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${service.baseUrl}/models`, {
        headers: { ...service.headers, origin: "https://example.com" },
      })
    ).status,
    403,
  );
  const models = await fetch(`${service.baseUrl}/models`, {
    headers: service.headers,
  });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "fixture");
  assert.match(service.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});

test("service generates JSON and SSE through the real worker transport", async (t) => {
  const service = await setup(t);
  const response = await service.post(request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "Hello 世界");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.completion_tokens, 2);
  const streamed = await service.post({ ...request, stream: true });
  assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  const lines = (await streamed.text()).trim().split("\n\n");
  assert.equal(lines.pop(), "data: [DONE]");
  const chunks = lines.map((line) => JSON.parse(line.slice(6)));
  assert.equal(
    chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""),
    "Hello 世界",
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.ok(chunks.every((chunk) => chunk.id === chunks[0].id));
});

test("service hands functions back to Copilot and translates tool history without executing it", async (t) => {
  const histories: LocalChatMessage[][] = [];
  const sessions: string[] = [];
  const released: string[] = [];
  const service = await setup(t, {
    async generateChat(messages, onToken, _signal, maxLength, session) {
      histories.push(messages);
      sessions.push(session!);
      assert.equal(maxLength, 1024);
      onToken(
        histories.length === 1
          ? '<think>Decide</think><tool_call>{"name":"inspect_repository","arguments":{}}</tool_call>'
          : "Repository inspected.",
      );
      return { cachedTokens: 0, generatedTokens: 4, cacheTokens: 12 };
    },
    async release(session) {
      released.push(session);
    },
  });
  const first = await service.post({ ...request, tools, stream: true });
  const chunks = (await first.text())
    .split("\n\n")
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
  const call = chunks.find((chunk) => chunk.choices[0].delta.tool_calls)
    .choices[0].delta.tool_calls[0];
  assert.equal(call.function.name, "inspect_repository");
  assert.equal(call.function.arguments, "{}");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  const second = await service.post({
    ...request,
    tools,
    messages: [
      ...request.messages,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "README.md" },
    ],
  });
  assert.equal(
    (await second.json()).choices[0].message.content,
    "Repository inspected.",
  );
  assert.match(histories[0]![0]!.content, /inspect_repository/);
  assert.match(histories[1]!.at(-2)!.content, /<tool_call>/);
  assert.match(histories[1]!.at(-1)!.content, /README.md/);
  assert.match(histories[1]!.at(-1)!.content, new RegExp(call.id));
  assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(released, sessions);
});

test("service rejects invalid input before inference and remains usable", async (t) => {
  const service = await setup(t);
  for (const body of [
    null,
    {},
    { ...request, model: "missing" },
    { ...request, stream: "yes" },
    { ...request, messages: [] },
    { ...request, messages: [{ role: "invalid", content: "" }] },
    {
      ...request,
      messages: [{ role: "user", content: [{ type: "image_url" }] }],
    },
    { ...request, tools: [{}] },
    { ...request, n: 2 },
    { ...request, tool_choice: "required" },
    { ...request, response_format: { type: "json_object" } },
    {
      ...request,
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "x",
              type: "function",
              function: { name: "x", arguments: "{" },
            },
          ],
        },
      ],
    },
  ])
    assert.equal((await service.post(body)).status, 400, JSON.stringify(body));
  const malformed = await fetch(`${service.baseUrl}/chat/completions`, {
    method: "POST",
    headers: service.headers,
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const unsupported = await fetch(`${service.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...service.headers, "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(unsupported.status, 415);
  assert.equal(
    (await fetch(`${service.baseUrl}/missing`, { headers: service.headers }))
      .status,
    404,
  );
  assert.equal((await service.post(request)).status, 200);
});

test("service bounds request bodies without closing the socket before its error response", async (t) => {
  const service = await setup(t);
  const oversized = await service.post({
    ...request,
    messages: [{ role: "user", content: "x".repeat(512 * 1024) }],
  });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error.message, /512 KiB/);
  assert.equal((await service.post(request)).status, 200);
});

test("service stops active requests and waits for cache cleanup on shutdown", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let released = false;
  const service = await setup(t, {
    async generateChat(_messages, onToken, signal) {
      onToken("partial");
      started();
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal!.throwIfAborted();
      throw new Error("Unreachable");
    },
    async release() {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      released = true;
    },
  });
  const pending = service.post({ ...request, stream: true });
  await ready;
  const response = await pending;
  const body = response.text().catch(() => {});
  await service.close();
  await body;
  assert.equal(released, true);
  await service.close();
});

test("service request deadline cancels inference and releases its session", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apiKey = randomUUID();
  const service = await startWorkerService({
    model: "fixture",
    apiKey,
    timeoutMs: 100,
    worker: {
      async generateChat(_messages, onToken, signal) {
        onToken("partial");
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal!.throwIfAborted();
        throw new Error("Unreachable");
      },
      async release() {
        release();
      },
    },
  });
  try {
    const response = await fetch(`${service.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: ["Bearer", apiKey].join(" "),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...request, stream: true }),
    });
    await assert.rejects(response.text());
    await released;
  } finally {
    await service.close();
  }
});

test("service rejects concurrent work, cancels disconnects, and releases failed requests", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let released!: () => void;
  const done = new Promise<void>((resolve) => {
    released = resolve;
  });
  let cancelled = false;
  const service = await setup(t, {
    async generateChat(_messages, onToken, signal) {
      onToken("partial");
      started();
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      signal!.throwIfAborted();
      throw new Error("Unreachable");
    },
    async release() {
      released();
    },
  });
  const controller = new AbortController();
  const pending = service.post({ ...request, stream: true }, controller.signal);
  await ready;
  assert.equal((await service.post(request)).status, 429);
  const response = await pending;
  controller.abort();
  await response.text().catch(() => {});
  await done;
  assert.equal(cancelled, true);
});

test("service hides worker errors, frees caches, and does not return unknown tool calls", async (t) => {
  let releases = 0;
  const service = await setup(t, {
    async generateChat(_messages, onToken) {
      onToken('<tool_call>{"name":"unregistered","arguments":{}}</tool_call>');
      return { cachedTokens: 0, generatedTokens: 2, cacheTokens: 3 };
    },
    async release() {
      releases++;
    },
  });
  assert.equal((await service.post({ ...request, tools })).status, 500);
  assert.equal(releases, 1);
  // tool_choice=none does not advertise any tool definitions.
  const plain = await service.post({ ...request, tools, tool_choice: "none" });
  assert.equal(plain.status, 200);
});

test("Copilot custom provider preserves the normal harness and permission defaults", () => {
  const provider = {
    type: "openai" as const,
    wireApi: "completions" as const,
    baseUrl: "http://127.0.0.1:8000/v1",
  };
  const config = copilotSessionConfig({
    cliPath: "copilot",
    workingDirectory: "/repository",
    model: "devdash-local",
    provider,
  });
  assert.deepEqual(config.provider, provider);
  assert.equal(config.enableSkills, true);
  assert.equal(config.enableHostGitOperations, true);
  assert.equal(config.enableFileHooks, false);
  assert.ok(config.onPermissionRequest);
  assert.equal(
    copilotSessionConfig({
      cliPath: "copilot",
      workingDirectory: "/repository",
    }).provider,
    undefined,
  );
});
