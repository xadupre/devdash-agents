import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};

export interface StepTiming {
  kind: "generation" | "tool";
  name: string;
  start: number;
  end?: number;
  agentId?: string;
  outputTokens?: number;
}

export class ExecutionTiming {
  private readonly generations = new Map<string, StepTiming>();
  private readonly tools = new Map<string, StepTiming>();

  constructor(
    readonly steps: StepTiming[],
    now = Date.now(),
  ) {
    this.generate("", now);
  }

  private generate(agentId: string, now: number): void {
    if (
      this.generations.has(agentId) ||
      [...this.tools.values()].some((step) => (step.agentId ?? "") === agentId)
    )
      return;
    const step: StepTiming = {
      kind: "generation",
      name: "Token generation",
      start: now,
      ...(agentId ? { agentId } : {}),
    };
    this.steps.push(step);
    this.generations.set(agentId, step);
  }

  private endGeneration(agentId: string, now: number): void {
    const step = this.generations.get(agentId);
    if (step) step.end = Math.max(step.start, now);
    this.generations.delete(agentId);
  }

  record(event: SessionEvent): void {
    const parsed = Date.parse(event.timestamp);
    const now = Number.isFinite(parsed) ? parsed : Date.now();
    const agentId = event.agentId ?? "";
    switch (event.type) {
      case "assistant.usage": {
        const tokens = event.data.outputTokens;
        if (
          typeof tokens !== "number" ||
          !Number.isSafeInteger(tokens) ||
          tokens < 0
        )
          break;
        for (let index = this.steps.length - 1; index >= 0; index--) {
          const step = this.steps[index]!;
          if (step.kind !== "generation" || (step.agentId ?? "") !== agentId)
            continue;
          const total = (step.outputTokens ?? 0) + tokens;
          if (Number.isSafeInteger(total)) step.outputTokens = total;
          break;
        }
        break;
      }
      case "tool.execution_start": {
        const key = `${agentId}:${event.data.toolCallId}`;
        if (this.tools.has(key)) return;
        this.endGeneration(agentId, now);
        const step: StepTiming = {
          kind: "tool",
          name: event.data.toolName,
          start: now,
          ...(agentId ? { agentId } : {}),
        };
        this.steps.push(step);
        this.tools.set(key, step);
        break;
      }
      case "tool.execution_complete": {
        const key = `${agentId}:${event.data.toolCallId}`;
        const step = this.tools.get(key);
        if (!step) return;
        step.end = Math.max(step.start, now);
        this.tools.delete(key);
        this.generate(agentId, step.end);
        break;
      }
      case "assistant.turn_start":
      case "assistant.message_start":
      case "assistant.message_delta":
      case "assistant.reasoning_delta":
        this.generate(agentId, now);
        break;
      case "assistant.message":
      case "assistant.turn_end":
        this.endGeneration(agentId, now);
        break;
      case "session.idle":
        if (event.data.mode !== "autopilot") this.finish(now, event.agentId);
        break;
      case "session.warning":
        if (event.data.warningType === "crash_recovery") this.finish(now);
        break;
    }
  }

  finish(now = Date.now(), agentId?: string): void {
    for (const active of [this.generations, this.tools]) {
      for (const [key, step] of active) {
        if (agentId === undefined || (step.agentId ?? "") === agentId) {
          step.end = Math.max(step.start, now);
          active.delete(key);
        }
      }
    }
  }
}
