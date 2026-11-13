import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import { ExecutionTiming, type StepTiming } from "../src/timing";

function event<T extends SessionEvent["type"]>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
  time: number,
  agentId?: string,
): SessionEvent {
  return {
    id: `${type}:${time}`,
    parentId: null,
    timestamp: new Date(time).toISOString(),
    type,
    data,
    ...(agentId ? { agentId } : {}),
  } as SessionEvent;
}

test("generation and tool steps use event timestamps, not token counts", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  timing.record(
    event(
      "assistant.message_delta",
      { messageId: "m", deltaContent: "Hi" },
      2000,
    ),
  );
  timing.record(
    event(
      "tool.execution_start",
      { toolCallId: "t", toolName: "read_file" },
      3000,
    ),
  );
  timing.record(
    event("tool.execution_complete", { toolCallId: "t", success: true }, 7000),
  );
  timing.record(
    event("assistant.message", { messageId: "m", content: "Done" }, 10000),
  );
  timing.finish(11000);
  assert.deepEqual(steps, [
    { kind: "generation", name: "Token generation", start: 1000, end: 3000 },
    { kind: "tool", name: "read_file", start: 3000, end: 7000 },
    { kind: "generation", name: "Token generation", start: 7000, end: 10000 },
  ]);
});

test("concurrent tools resume generation only when all tools for that agent finish", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  for (const [id, name, time] of [
    ["a", "read_file", 2000],
    ["b", "search", 3000],
    ["b", "search", 4000],
  ] as const)
    timing.record(
      event("tool.execution_start", { toolCallId: id, toolName: name }, time),
    );
  timing.record(
    event(
      "tool.execution_complete",
      { toolCallId: "unknown", success: true },
      5000,
    ),
  );
  timing.record(
    event("tool.execution_complete", { toolCallId: "a", success: false }, 6000),
  );
  assert.equal(steps.length, 3);
  timing.record(
    event("tool.execution_complete", { toolCallId: "b", success: true }, 8000),
  );
  timing.finish(9000);
  assert.deepEqual(
    steps.map(({ start, end }) => [start, end]),
    [
      [1000, 2000],
      [2000, 6000],
      [3000, 8000],
      [8000, 9000],
    ],
  );
});

test("usage attaches tokens to the latest generation for its agent, even after completion", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  timing.record(
    event(
      "tool.execution_start",
      { toolCallId: "t", toolName: "read_file" },
      2000,
    ),
  );
  timing.record(
    event("tool.execution_complete", { toolCallId: "t", success: true }, 3000),
  );
  timing.record(
    event("assistant.message_start", { messageId: "child" }, 3500, "child"),
  );
  timing.finish(5000);
  for (const [tokens, agent] of [
    [40, ""],
    [10, ""],
    [Number.MAX_SAFE_INTEGER, ""],
    [15, "child"],
    [100, "unknown"],
    [-1, ""],
    [NaN, ""],
    [Infinity, ""],
    [1.5, ""],
  ] as const)
    timing.record(
      event(
        "assistant.usage",
        { model: "test", outputTokens: tokens },
        6000,
        agent,
      ),
    );
  assert.deepEqual(
    steps.map((step) => step.outputTokens),
    [undefined, undefined, 50, 15],
  );
});

test("subagents with the same tool call ID retain independent timings", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  for (const agent of ["", "child"])
    timing.record(
      event(
        "tool.execution_start",
        { toolCallId: "t", toolName: "bash" },
        2000,
        agent,
      ),
    );
  timing.record(
    event(
      "tool.execution_complete",
      { toolCallId: "t", success: true },
      4000,
      "child",
    ),
  );
  assert.equal(
    steps.find((step) => step.kind === "tool" && !step.agentId)?.end,
    undefined,
  );
  timing.finish(5000);
  assert.equal(steps.find((step) => step.agentId === "child")?.end, 4000);
  assert.ok(steps.every((step) => step.end !== undefined));
});

test("cancellation and recovery close active steps without negative durations", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  timing.record(
    event("tool.execution_start", { toolCallId: "t", toolName: "bash" }, 2000),
  );
  timing.finish(1500);
  assert.equal(steps.at(-1)?.end, 2000);
  timing.finish(3000);
  assert.equal(steps.at(-1)?.end, 2000);
  timing.record(
    event(
      "assistant.message_delta",
      { messageId: "m", deltaContent: "Recovered" },
      4000,
    ),
  );
  timing.record(event("session.idle", {}, 5000));
  assert.deepEqual(steps.at(-1), {
    kind: "generation",
    name: "Token generation",
    start: 4000,
    end: 5000,
  });
});

test("subagent idle only closes that agent while autopilot idle keeps work running", () => {
  const steps: StepTiming[] = [];
  const timing = new ExecutionTiming(steps, 1000);
  for (const agent of ["", "child", "sibling"])
    timing.record(
      event(
        "tool.execution_start",
        { toolCallId: "t", toolName: "bash" },
        2000,
        agent,
      ),
    );
  timing.record(event("session.idle", { mode: "autopilot" }, 3000));
  timing.record(event("session.idle", { mode: "autopilot" }, 3500, "child"));
  assert.ok(
    steps
      .filter((step) => step.kind === "tool")
      .every((step) => step.end === undefined),
  );
  timing.record(event("session.idle", {}, 4000, "child"));
  assert.equal(steps.find((step) => step.agentId === "child")?.end, 4000);
  assert.equal(
    steps.find((step) => step.agentId === "sibling")?.end,
    undefined,
  );
  assert.equal(
    steps.find((step) => step.kind === "tool" && !step.agentId)?.end,
    undefined,
  );
  timing.record(
    event("tool.execution_complete", { toolCallId: "t", success: true }, 5000),
  );
  timing.record(event("session.idle", {}, 6000));
  assert.ok(steps.every((step) => step.end !== undefined));
  assert.equal(steps.find((step) => step.agentId === "sibling")?.end, 6000);
});
