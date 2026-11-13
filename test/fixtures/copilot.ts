import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { testImage } from "../helpers";

interface Request {
  id?: number;
  method: string;
  params?: {
    sessionId?: string;
    model?: string;
    prompt?: string;
    result?: { kind: string };
  };
  result?: { answer: string; wasFreeform: boolean };
  error?: { message: string };
}

const scenario = readFileSync("scenario", "utf8");
writeFileSync("pid", String(process.pid));
if (scenario.startsWith("crash:")) appendFileSync("pids", `${process.pid}\n`);
let buffer = Buffer.alloc(0);
const prompts: string[] = [];
let pendingSend: number | undefined;
let pendingSessionId: string | undefined;
let eventSequence = 0;

function notify(
  sessionId: string | undefined,
  type: string,
  data: object,
  agentId?: string,
): void {
  transmit({
    jsonrpc: "2.0",
    method: "session.event",
    params: {
      sessionId,
      event: {
        id: `event-${++eventSequence}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        type,
        data,
        ...(agentId ? { agentId } : {}),
      },
    },
  });
}

function transmit(message: object): void {
  const body = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function reply(id: number, result: unknown, error?: string): void {
  transmit({
    jsonrpc: "2.0",
    id,
    ...(error ? { error: { code: -32000, message: error } } : { result }),
  });
}

function crashIfRequested(request: Request): boolean {
  if (
    (scenario !== `crash:${request.method}` &&
      !(
        scenario === "late-parallel-recovery" &&
        request.method === "session.sendAndWait" &&
        request.params?.prompt?.includes("Fail the main request") &&
        !request.params.prompt.includes("Keep the parallel request open")
      )) ||
    !existsSync("crashes-left")
  )
    return false;
  const remaining = Number(readFileSync("crashes-left", "utf8"));
  if (remaining <= 0) return false;
  writeFileSync("crashes-left", String(remaining - 1));
  if (request.method === "session.sendAndWait") {
    notify(request.params?.sessionId, "assistant.message_delta", {
      messageId: "interrupted-answer",
      deltaContent: "Partial answer before the crash",
    });
    notify(request.params?.sessionId, "tool.execution_start", {
      toolCallId: "interrupted-tool",
      toolName: "bash",
      arguments: { command: "printf checkpoint" },
    });
  }
  process.stdout.write("", () => process.exit(17));
  return true;
}

function handle(request: Request): void {
  appendFileSync("requests.jsonl", `${JSON.stringify(request)}\n`);
  if (
    (scenario.startsWith("question") ||
      scenario === "late-parallel-recovery") &&
    request.id === -1
  ) {
    if (pendingSend === undefined) {
      throw new Error("User answer without a pending request.");
    }
    if (
      scenario === "question-usage" ||
      scenario === "late-parallel-recovery"
    ) {
      notify(pendingSessionId, "assistant.usage", {
        model: "fixture",
        outputTokens: 7,
      });
    }
    reply(pendingSend, {
      response: {
        type: "assistant.message",
        data: {
          content:
            request.error?.message ??
            `Answer: ${request.result?.answer}; freeform: ${request.result?.wasFreeform}`,
        },
      },
    });
    pendingSend = undefined;
    return;
  }
  if (request.id === undefined || scenario === `hang:${request.method}`) {
    return;
  }
  if (request.method !== "session.sendAndWait" && crashIfRequested(request))
    return;
  switch (request.method) {
    case "connect":
      reply(request.id, { protocolVersion: 3 });
      break;
    case "session.create":
      if (
        scenario.startsWith("persist") ||
        scenario.startsWith("crash:") ||
        scenario === "late-parallel-recovery" ||
        scenario === "postmortem"
      ) {
        writeFileSync(`history-${request.params?.sessionId}.json`, "[]");
      }
      if (scenario === "events") {
        notify(request.params?.sessionId, "session.start", {
          context: { cwd: process.cwd() },
        });
      }
      reply(
        request.id,
        { sessionId: request.params?.sessionId },
        scenario === "unauthenticated"
          ? "Not authenticated. Run copilot login."
          : request.params?.model === "invalid-model"
            ? "Invalid model: invalid-model"
            : undefined,
      );
      break;
    case "session.resume": {
      const filename = `history-${request.params?.sessionId}.json`;
      if (scenario === "missing-resume" || !existsSync(filename)) {
        reply(request.id, undefined, "Saved session not found.");
        break;
      }
      const saved: string[] = JSON.parse(readFileSync(filename, "utf8"));
      prompts.push(...saved);
      reply(request.id, { sessionId: request.params?.sessionId });
      break;
    }
    case "session.list":
      reply(request.id, {
        sessions: [
          {
            sessionId: "older",
            startTime: "2026-01-01T00:00:00.000Z",
            modifiedTime: "2026-01-02T00:00:00.000Z",
            isRemote: false,
            context: { cwd: process.cwd(), branch: "main" },
          },
          {
            sessionId: "remote",
            startTime: "2026-01-01T00:00:00.000Z",
            modifiedTime: "2026-01-05T00:00:00.000Z",
            isRemote: true,
          },
          {
            sessionId: "newer",
            startTime: "2026-01-03T00:00:00.000Z",
            modifiedTime: "2026-01-04T00:00:00.000Z",
            summary: "Fix the build",
            isRemote: false,
          },
        ],
      });
      break;
    case "session.getMetadata": {
      const sessionId = request.params?.sessionId;
      reply(request.id, {
        session: existsSync(`history-${sessionId}.json`)
          ? {
              sessionId,
              startTime: new Date().toISOString(),
              modifiedTime: new Date().toISOString(),
            }
          : undefined,
      });
      break;
    }
    case "session.delete": {
      const sessionId = request.params?.sessionId;
      if (
        existsSync("fail-delete-id") &&
        readFileSync("fail-delete-id", "utf8") === sessionId
      ) {
        reply(request.id, { success: false, error: "Deletion denied" });
      } else {
        unlinkSync(`history-${sessionId}.json`);
        reply(request.id, { success: true });
      }
      break;
    }
    case "session.sendAndWait":
      if (scenario === "persist-usage") {
        for (const outputTokens of [
          10,
          20,
          0,
          undefined,
          -1,
          1.5,
          Number.MAX_SAFE_INTEGER,
        ]) {
          notify(request.params?.sessionId, "assistant.usage", {
            model: "fixture",
            inputTokens: 1000,
            outputTokens,
          });
        }
        notify(
          request.params?.sessionId,
          "assistant.usage",
          { model: "fixture", outputTokens: 7 },
          "child-agent",
        );
      }
      if (scenario === "postmortem") {
        const entries: unknown[] = JSON.parse(
          request.params?.prompt?.split("\n").at(-1) ?? "[]",
        );
        reply(request.id, {
          response: {
            type: "assistant.message",
            data: {
              content: JSON.stringify({
                rows: [
                  {
                    first: 1,
                    last: entries.length,
                    phase: "Implementation and delivery",
                    objective: "Complete the requested task",
                    production: "Code, tests and a commit",
                    filesAndCommits: "As recorded in the source conversation",
                    validation: "Reported test results; consult sources",
                    errors: "Recorded errors and corrections",
                  },
                ],
              }),
            },
          },
        });
        break;
      }
      if (scenario.startsWith("question")) {
        pendingSessionId = request.params?.sessionId;
        if (scenario === "question-usage") {
          notify(request.params?.sessionId, "assistant.usage", {
            model: "fixture",
            outputTokens: 20,
          });
        }
        pendingSend = request.id;
        transmit({
          jsonrpc: "2.0",
          id: -1,
          method: "userInput.request",
          params: {
            sessionId: request.params?.sessionId,
            question: "Which test suite should run?",
            choices: ["Targeted", "All"],
            allowFreeform: true,
          },
        });
        break;
      }
      if (
        scenario === "late-parallel-recovery" &&
        request.params?.prompt?.includes("Keep the parallel request open")
      ) {
        pendingSessionId = request.params?.sessionId;
        notify(request.params?.sessionId, "assistant.usage", {
          model: "fixture",
          outputTokens: 20,
        });
        pendingSend = request.id;
        transmit({
          jsonrpc: "2.0",
          id: -1,
          method: "userInput.request",
          params: {
            sessionId: request.params?.sessionId,
            question: "Which test suite should run?",
            choices: ["Targeted", "All"],
            allowFreeform: true,
          },
        });
        break;
      }
      if (
        scenario === "permission" ||
        scenario === "permission-error" ||
        scenario === "crash:permission"
      ) {
        if (scenario === "crash:permission") {
          prompts.push(request.params?.prompt ?? "");
          writeFileSync(
            `history-${request.params?.sessionId}.json`,
            JSON.stringify(prompts),
          );
        }
        pendingSend = request.id;
        transmit({
          jsonrpc: "2.0",
          method: "session.event",
          params: {
            sessionId: request.params?.sessionId,
            event: {
              id: "permission-event",
              parentId: null,
              timestamp: new Date().toISOString(),
              type: "permission.requested",
              data: {
                requestId: "permission-request",
                permissionRequest: { kind: "read", path: "README.md" },
              },
            },
          },
        });
        break;
      }
      prompts.push(request.params?.prompt ?? "");
      if (
        scenario.startsWith("persist") ||
        scenario.startsWith("crash:") ||
        scenario === "late-parallel-recovery"
      ) {
        writeFileSync(
          `history-${request.params?.sessionId}.json`,
          JSON.stringify(prompts),
        );
        if (scenario === "persist-hang") {
          break;
        }
      }
      if (crashIfRequested(request)) break;
      if (scenario === "images") {
        const image = {
          type: "image",
          mimeType: "image/png",
          data: testImage.dataUrl.split(",")[1],
        };
        const asset = {
          ...image,
          mimeType: "image/jpeg",
          assetId: "image-asset",
          byteLength: 67,
        };
        notify(request.params?.sessionId, "session.binary_asset", asset);
        notify(request.params?.sessionId, "tool.execution_complete", {
          toolCallId: "image-tool",
          success: true,
          result: {
            content: "Generated *image*, not Markdown",
            contents: [
              image,
              { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
            ],
            binaryResultsForLlm: [
              image,
              { ...image, mimeType: "image/gif" },
              {
                type: "image",
                assetId: asset.assetId,
                mimeType: asset.mimeType,
                byteLength: asset.byteLength,
              },
              {
                type: "image",
                assetId: "late-asset",
                mimeType: "image/webp",
                byteLength: asset.byteLength,
              },
              {
                type: "image",
                assetId: "invalid-asset",
                mimeType: "image/svg+xml",
                byteLength: 5,
              },
            ],
          },
        });
        notify(request.params?.sessionId, "session.binary_asset", {
          ...asset,
          assetId: "late-asset",
          mimeType: "image/webp",
        });
        notify(request.params?.sessionId, "session.binary_asset", {
          ...asset,
          assetId: "invalid-asset",
          mimeType: "image/svg+xml",
          data: "PHN2Zz4=",
        });
      }
      if (scenario === "events") {
        const sessionId = request.params?.sessionId;
        const messageId = `message-${prompts.length}`;
        notify(sessionId, "user.message", { content: request.params?.prompt });
        notify(sessionId, "assistant.reasoning_delta", {
          reasoningId: messageId,
          deltaContent: "Inspect ",
        });
        notify(sessionId, "assistant.reasoning_delta", {
          reasoningId: messageId,
          deltaContent: "the repository.",
        });
        notify(sessionId, "assistant.reasoning", {
          reasoningId: messageId,
          content: "Inspect the repository.",
        });
        for (const inputDelta of [
          '{"command":',
          '"gh pr list\\nprintf done"}',
        ]) {
          notify(sessionId, "assistant.tool_call_delta", {
            toolCallId: messageId,
            toolName: "bash",
            inputDelta,
          });
        }
        notify(sessionId, "tool.execution_progress", {
          toolCallId: messageId,
          progressMessage: "Preparing command",
        });
        notify(sessionId, "tool.execution_start", {
          toolCallId: messageId,
          toolName: "bash",
          arguments: { command: "gh pr list\nprintf done" },
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stdout",
          sequence: 0,
          text: "first\n",
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stderr",
          sequence: 1,
          text: "warning\n",
        });
        notify(sessionId, "tool.shell_output", {
          toolCallId: messageId,
          stream: "stdout",
          sequence: 2,
          text: "second\n",
        });
        notify(sessionId, "tool.execution_complete", {
          toolCallId: messageId,
          success: true,
          result: { content: "first\nsecond\nwarning" },
        });
        notify(sessionId, "tool.execution_complete", {
          toolCallId: "failed-command",
          success: false,
          error: { message: "Command failed" },
        });
        notify(sessionId, "assistant.message_start", { messageId });
        notify(sessionId, "assistant.message_delta", {
          messageId,
          deltaContent: "## Fixture ",
        });
        notify(sessionId, "assistant.message_delta", {
          messageId,
          deltaContent: "answer",
        });
        notify(sessionId, "assistant.message", {
          messageId,
          content: "## Fixture answer",
        });
        notify(
          sessionId,
          "assistant.message",
          { messageId, content: "Subagent answer" },
          "child-agent",
        );
      }
      reply(request.id, {
        response: {
          type: "assistant.message",
          data: {
            content:
              scenario === "empty"
                ? " "
                : scenario === "conversation" ||
                    scenario.startsWith("persist") ||
                    scenario.startsWith("crash:")
                  ? `## Fixture answer\n\n${prompts.join("\n\n")}`
                  : "## Fixture answer",
          },
        },
      });
      break;
    case "session.permissions.handlePendingPermissionRequest":
      reply(request.id, { success: true });
      if (pendingSend === undefined) {
        throw new Error("Permission decision without a pending request.");
      }
      if (scenario === "permission-error") {
        reply(pendingSend, undefined, "Main request failed");
        pendingSend = undefined;
        break;
      }
      reply(pendingSend, {
        response: {
          type: "assistant.message",
          data: {
            content:
              request.params?.result?.kind === "approve-once"
                ? "Repository access approved"
                : "Repository access denied",
          },
        },
      });
      pendingSend = undefined;
      break;
    case "models.list":
      reply(request.id, {
        models: [
          {
            id: "fixture",
            name: "Fixture model",
            policy: { state: "enabled", terms: "" },
          },
          {
            id: "blocked",
            name: "Blocked model",
            policy: { state: "disabled", terms: "" },
          },
          { id: "other", name: "" },
        ],
      });
      break;
    case "session.model.switchTo":
      reply(request.id, {});
      break;
    case "session.detach":
      reply(request.id, { success: true });
      break;
    case "runtime.shutdown":
      reply(request.id, {});
      process.stdin.pause();
      break;
    default:
      reply(request.id, undefined, `Unexpected request: ${request.method}`);
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const length = Number(
      /Content-Length: (\d+)/i.exec(buffer.toString("utf8", 0, headerEnd))?.[1],
    );
    if (!Number.isFinite(length)) {
      throw new Error("Missing Content-Length in SDK request.");
    }
    const end = headerEnd + 4 + length;
    if (buffer.length < end) {
      return;
    }
    const request: Request = JSON.parse(
      buffer.toString("utf8", headerEnd + 4, end),
    );
    buffer = buffer.subarray(end);
    handle(request);
  }
});
