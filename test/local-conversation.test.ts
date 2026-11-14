import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalConversation } from "../src/local-conversation";
import type {
  ContextReductionMode,
  LocalChatMessage,
} from "../src/local-worker";

test("both context reductions replace inference history without generating a chat reply", async () => {
  for (const mode of ["sliding", "compress"] as const) {
    const chats: LocalChatMessage[][] = [];
    const reductions: ContextReductionMode[] = [];
    const events: string[] = [];
    const conversation = new LocalConversation(
      {
        load: async () => ({
          provider: "cpu",
          deviceId: 0,
          name: "CPU",
        }),
        generateChat: async (messages, onToken) => {
          chats.push(structuredClone(messages));
          onToken("answer");
        },
        reduceContext: async (messages, requestedMode, signal, maxLength) => {
          assert.equal(messages.length, 2);
          assert.equal(signal?.aborted, false);
          assert.equal(maxLength, 4096);
          reductions.push(requestedMode);
          return {
            messages: [
              { role: "user", content: "Earlier context" },
              { role: "assistant", content: "retained context" },
            ],
            cacheTokens: 10,
          };
        },
        stop: async () => {},
      },
      "/model",
      "cpu",
      0,
      undefined,
      { name: "tiny", sizeBytes: 1, contextLength: 4096 },
    );
    const signal = new AbortController().signal;
    await conversation.start(signal, (event) => {
      events.push(event.type);
      if (event.type === "session.usage_info")
        assert.equal(event.data.currentTokens, 10);
    });
    await assert.rejects(
      conversation.reduceContext(mode, signal),
      /no conversation/,
    );
    await conversation.send("old context", signal);
    events.length = 0;
    await conversation.reduceContext(mode, signal);
    assert.deepEqual(reductions, [mode]);
    assert.deepEqual(events, ["session.usage_info"]);
    assert.equal(chats.length, 1);
    await conversation.send("follow up", signal);
    assert.deepEqual(chats[1], [
      { role: "user", content: "Earlier context" },
      { role: "assistant", content: "retained context" },
      { role: "user", content: "follow up" },
    ]);
    await conversation.dispose();
    await assert.rejects(
      conversation.reduceContext(mode, signal),
      /not loaded/,
    );
  }
});

test("failed and cancelled reductions preserve history and release the busy guard", async () => {
  const chats: LocalChatMessage[][] = [];
  let finish: (() => void) | undefined;
  let slidingAttempts = 0;
  let compressionAttempts = 0;
  const conversation = new LocalConversation(
    {
      load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
      generateChat: async (messages, onToken) => {
        chats.push(structuredClone(messages));
        onToken("answer");
      },
      reduceContext: async (messages, mode) => {
        messages[0]!.content = "must not mutate stored history";
        if (mode === "sliding" && slidingAttempts++ === 0)
          throw new Error("prefill failed");
        if (mode === "compress" && compressionAttempts++ === 0)
          await new Promise<void>((resolve) => (finish = resolve));
        return {
          messages: [
            { role: "user", content: `${mode} retry context` },
            { role: "assistant", content: "retained" },
          ],
          cacheTokens: 2,
        };
      },
      stop: async () => {},
    },
    "/model",
  );
  const signal = new AbortController().signal;
  await conversation.start(signal);
  await conversation.send("original", signal);
  await assert.rejects(
    conversation.reduceContext("sliding", signal),
    /prefill failed/,
  );
  await conversation.reduceContext("sliding", signal);
  const controller = new AbortController();
  const pending = conversation.reduceContext("compress", controller.signal);
  await assert.rejects(
    conversation.send("concurrent", signal),
    /already running/,
  );
  await assert.rejects(
    conversation.reduceContext("sliding", signal),
    /already running/,
  );
  controller.abort();
  finish!();
  await assert.rejects(pending, /abort/i);
  await conversation.reduceContext("compress", signal);
  await conversation.send("next", signal);
  assert.deepEqual(chats[1], [
    { role: "user", content: "compress retry context" },
    { role: "assistant", content: "retained" },
    { role: "user", content: "next" },
  ]);
  await conversation.dispose();
});

test("Engine usage and reductions report logical context without a private KV cache", async () => {
  for (const mode of ["sliding", "compress"] as const) {
    const usage: number[] = [];
    const conversation = new LocalConversation(
      {
        load: async () => ({ provider: "cpu", deviceId: 0, name: "CPU" }),
        generateChat: async (messages, onToken) => {
          if (usage.length > 1)
            assert.equal(messages[0]!.content, "reduced history");
          onToken("answer");
          return {
            cachedTokens: 7,
            generatedTokens: 5,
            cacheTokens: 0,
            contextTokens: 40,
          };
        },
        reduceContext: async () => ({
          messages: [{ role: "user", content: "reduced history" }],
          cacheTokens: 0,
          contextTokens: 15,
        }),
        stop: async () => {},
      },
      "/model",
    );
    const signal = new AbortController().signal;
    await conversation.start(signal, (event) => {
      if (event.type === "session.usage_info") {
        usage.push(event.data.currentTokens);
        assert.equal(event.data.tokenLimit, event.data.currentTokens);
      }
    });
    assert.equal(conversation.canReduceContext, false);
    await conversation.send("original history", signal);
    assert.equal(conversation.canReduceContext, true);
    await conversation.reduceContext(mode, signal);
    assert.equal(conversation.canReduceContext, true);
    await conversation.send("follow up", signal);
    assert.deepEqual(usage, [40, 15, 40]);
    await conversation.dispose();
  }
});
