import assert from "node:assert/strict";
import { test } from "node:test";
import { datasetMetrics } from "../src/dataset";
import type { SavedConversation } from "../src/storage";
import type { SessionAssignment } from "../src/execution";

test("dataset metrics count prompts and tools, merge overlapping timings, and exclude idle gaps", () => {
  const conversation: SavedConversation = {
    draft: "Unsent draft is not a prompt",
    messages: [
      {
        role: "user",
        content: "First",
        timestamp: "2026-11-14T09:00:00.000Z",
        timings: [
          { kind: "generation", name: "Model", start: 1000, end: 2000 },
          { kind: "tool", name: "Tool", start: 2000, end: 3000 },
          { kind: "generation", name: "Subagent", start: 1500, end: 2500 },
        ],
      },
      { role: "tool", content: "Tool started", toolCallId: "tool-1" },
      { role: "output", content: "Tool finished", toolCallId: "tool-1" },
      {
        role: "user",
        content: "Second",
        timings: [
          { kind: "generation", name: "Model", start: 10000, end: 10500 },
        ],
      },
      { role: "tool", content: "Another call" },
      { role: "system", content: "Metadata" },
    ],
    finalDiffSize: 42,
  };
  const metrics = datasetMetrics(conversation);
  assert.equal(metrics.promptCount, 2);
  assert.equal(metrics.toolCallCount, 2);
  assert.equal(metrics.durationMs, 2500);
  assert.equal(metrics.date, "1970-01-01T00:00:01.000Z");
  assert.equal(metrics.finalDiffSize, 42);
});

test("legacy dataset metrics use valid timestamp spans and leave missing information unknown", () => {
  const metrics = datasetMetrics({
    draft: "",
    messages: [
      { role: "user", content: "Prompt", timestamp: "2026-11-14T09:00:00Z" },
      { role: "system", content: "", timestamp: "invalid" },
      {
        role: "assistant",
        content: "Answer",
        timestamp: "2026-11-14T09:00:02Z",
      },
    ],
  });
  assert.equal(metrics.durationMs, 2000);
  assert.equal(metrics.date, "2026-11-14T09:00:00.000Z");
  const empty = datasetMetrics({ draft: "", messages: [] });
  assert.equal(empty.promptCount, 0);
  assert.equal(empty.toolCallCount, 0);
  assert.equal(empty.date, undefined);
  assert.equal(empty.durationMs, undefined);
  assert.equal(empty.finalDiffSize, undefined);
});

test("legacy request durations exclude idle gaps and combine with timed requests", () => {
  const separated = datasetMetrics({
    draft: "",
    messages: [
      { role: "user", content: "First", timestamp: "2026-11-14T09:00:00Z" },
      {
        role: "assistant",
        content: "Answer",
        timestamp: "2026-11-14T09:00:02Z",
      },
      { role: "user", content: "Second", timestamp: "2026-11-14T10:00:00Z" },
      {
        role: "assistant",
        content: "Answer",
        timestamp: "2026-11-14T10:00:03Z",
      },
    ],
  });
  assert.equal(separated.durationMs, 5000);

  const mixed = datasetMetrics({
    draft: "",
    messages: [
      { role: "user", content: "Legacy", timestamp: "2026-11-14T09:00:00Z" },
      {
        role: "assistant",
        content: "Answer",
        timestamp: "2026-11-14T09:00:02Z",
      },
      {
        role: "user",
        content: "Timed",
        timestamp: "2026-11-14T10:00:00Z",
        timings: [
          { kind: "generation", name: "Model", start: 10000, end: 13000 },
        ],
      },
    ],
  });
  assert.equal(mixed.durationMs, 5000);
});

test("large legacy histories calculate duration without argument limits", () => {
  const prompt = {
    role: "user" as const,
    content: "Prompt",
    timestamp: "2026-11-14T09:00:00Z",
  };
  const answer = {
    role: "assistant" as const,
    content: "Answer",
    timestamp: "2026-11-14T09:00:02Z",
  };
  const oneRequest = datasetMetrics({
    draft: "",
    messages: [prompt, ...Array.from({ length: 150_000 }, () => answer)],
  });
  assert.equal(oneRequest.durationMs, 2000);
  const manyRequests = datasetMetrics({
    draft: "",
    messages: Array.from({ length: 150_000 }, () => [prompt, answer]).flat(),
  });
  assert.equal(manyRequests.durationMs, 2000);
  assert.equal(manyRequests.promptCount, 150_000);
});

test("unsent placeholders do not split legacy request durations", () => {
  const { durationMs } = datasetMetrics({
    draft: "",
    messages: [
      { role: "user", content: "Sent", timestamp: "2026-11-14T09:00:00Z" },
      {
        role: "assistant",
        content: "Working",
        timestamp: "2026-11-14T09:00:02Z",
      },
      {
        role: "user",
        content: "Queued",
        title: "Queued - after current work",
        timestamp: "2026-11-14T09:00:05Z",
      },
      { role: "tool", content: "Tool", timestamp: "2026-11-14T09:00:06Z" },
      {
        role: "assistant",
        content: "Finished",
        timestamp: "2026-11-14T09:00:07Z",
      },
      {
        role: "user",
        content: "Cancelled",
        title: "Not sent - queue cancelled",
        timestamp: "2026-11-14T09:00:08Z",
      },
      {
        role: "assistant",
        content: "Final",
        timestamp: "2026-11-14T09:00:09Z",
      },
    ],
  });
  assert.equal(durationMs, 9000);
});

test("dataset metrics only include messages belonging to the current record", () => {
  const metrics = datasetMetrics({
    draft: "",
    recordId: "current",
    recordMessageStart: 2,
    messages: [
      { role: "user", content: "Reference prompt" },
      { role: "tool", content: "Reference tool" },
      { role: "user", content: "Current prompt" },
      { role: "tool", content: "Current tool" },
      { role: "tool", content: "Late archived tool", recordId: "archived" },
    ],
  });
  assert.equal(metrics.promptCount, 1);
  assert.equal(metrics.toolCallCount, 1);
});

test("dataset prompt counts exclude queued, cancelled and abandoned requests", () => {
  const { promptCount } = datasetMetrics({
    draft: "",
    messages: [
      { role: "user", content: "Sent" },
      { role: "user", content: "Sent later", title: "Sent after current work" },
      { role: "user", content: "Queued", title: "Queued - after current work" },
      {
        role: "user",
        content: "Cancelled",
        title: "Not sent - queue cancelled",
      },
      {
        role: "user",
        content: "Abandoned",
        title: "Not sent - previous application ended",
      },
    ],
  });
  assert.equal(promptCount, 2);
});

test("dataset models include immutable assignment IDs and paths alongside the worker", () => {
  const machine = {
    id: "local",
    name: "Local",
    command: "",
    repositoriesPath: "/projects",
    modelsPath: "/models",
    workerPath: "worker",
    cliPath: "copilot",
  };
  for (const model of [
    { kind: "copilot", source: "model-id" },
    { kind: "file", source: "/models/export" },
    { kind: "model-id", source: "owner/model" },
  ] as const) {
    const assignment: SessionAssignment = {
      worker: {
        id: "worker-1",
        name: "Worker",
        machineId: "local",
        backend: model.kind === "copilot" ? "copilot" : "local",
        model,
        provider: "cpu",
        deviceId: 0,
      },
      workerMachine: machine,
      executionMachine: machine,
    };
    const conversation = {
      assignment,
      draft: "",
      messages: [],
      models: ["Reported model"],
    };
    const metrics = datasetMetrics(conversation);
    assert.deepEqual(metrics.models, ["Reported model", model.source]);
    assert.equal(metrics.worker, "Worker");
    metrics.models.push("Must not mutate history");
    assert.deepEqual(conversation.models, ["Reported model"]);
    conversation.models = [model.source];
    assert.deepEqual(datasetMetrics(conversation).models, [model.source]);
  }
});
