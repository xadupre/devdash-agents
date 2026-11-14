import type { SavedConversation } from "./storage";

export function datasetMetrics(conversation: SavedConversation) {
  const messages = conversation.messages.slice(
    conversation.recordMessageStart ?? 0,
  );
  const intervals = messages
    .flatMap((message) => message.timings ?? [])
    .filter((step) => Number.isFinite(step.start))
    .map(
      (step) =>
        [step.start, Math.max(step.start, step.end ?? step.start)] as const,
    )
    .sort((a, b) => a[0] - b[0]);
  const fallbackIntervals: [number, number][] = [];
  let request: typeof messages = [];
  const addFallbackInterval = () => {
    if (request.some((message) => message.timings?.length)) {
      request = [];
      return;
    }
    const requestTimestamps = request
      .map((message) => Date.parse(message.timestamp ?? ""))
      .filter(Number.isFinite);
    if (requestTimestamps.length > 1) {
      fallbackIntervals.push([
        Math.min(...requestTimestamps),
        Math.max(...requestTimestamps),
      ]);
    }
    request = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      addFallbackInterval();
      if (
        message.title !== "Queued - after current work" &&
        !message.title?.startsWith("Not sent - ")
      ) {
        request.push(message);
      }
    } else if (request.length) request.push(message);
  }
  addFallbackInterval();
  intervals.push(...fallbackIntervals);
  intervals.sort((a, b) => a[0] - b[0]);
  const timestamps = messages
    .map((message) => Date.parse(message.timestamp ?? ""))
    .filter(Number.isFinite);
  for (const [start, end] of intervals) timestamps.push(start, end);
  let first: number | undefined;
  let last: number | undefined;
  for (const timestamp of timestamps) {
    first = first === undefined ? timestamp : Math.min(first, timestamp);
    last = last === undefined ? timestamp : Math.max(last, timestamp);
  }
  let durationMs = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of intervals) {
    durationMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  const model = conversation.assignment?.worker.model.source;
  return {
    models: [
      ...new Set([...(conversation.models ?? []), ...(model ? [model] : [])]),
    ],
    worker: conversation.assignment?.worker.name,
    promptCount: messages.filter(
      (message) =>
        message.role === "user" &&
        message.title !== "Queued - after current work" &&
        !message.title?.startsWith("Not sent - "),
    ).length,
    toolCallCount: messages.filter((message) => message.role === "tool").length,
    durationMs: intervals.length ? durationMs : undefined,
    date: first === undefined ? undefined : new Date(first).toISOString(),
    finalDiffSize: conversation.finalDiffSize,
  };
}
