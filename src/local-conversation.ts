import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { SessionEvent } from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import type { Conversation } from "./conversation";
import type { ImageAttachment } from "./images";
import type { LocalModelInfo } from "./local-model";
import { LocalResponse } from "./local-response";
import { remoteError, runRemoteScript } from "./remote";
import type {
  ContextReductionMode,
  LocalChatMessage,
  LocalContextReduction,
  LocalDevice,
  LocalGeneration,
  LocalProvider,
  LocalWorker,
} from "./local-worker";
import {
  executeLocalTool,
  LOCAL_TOOL_MARKERS,
  MAX_LOCAL_TOOL_CALLS,
  parseLocalToolCall,
  type LocalToolCall,
  type LocalToolHost,
} from "./local-tools";

type Worker = Pick<LocalWorker, "load" | "stop"> & {
  readonly device?: LocalDevice;
  readonly status?: string;
  reduceContext?(
    messages: LocalChatMessage[],
    mode: ContextReductionMode,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalContextReduction>;
  generateChat(
    messages: LocalChatMessage[],
    onToken: (text: string) => void,
    signal?: AbortSignal,
    maxLength?: number,
  ): Promise<LocalGeneration | void>;
};
const MAX_RESPONSE_BYTES = 128 * 1024;
const TOOL_INSTRUCTIONS = [
  "You are a local coding assistant. You may use only the tools listed below.",
  "For a tool call, output exactly one <tool_call> element containing JSON with the tool name and arguments. Do not include any other text in that response.",
  'Example: <tool_call>{"name":"read_file","arguments":{"path":"src/main.ts"}}</tool_call>',
  "An unwrapped JSON object with exactly name and arguments is also accepted as a tool call.",
  "You are provided with function signatures within <tools></tools> XML tags:",
  "<tools>",
  ...[
    {
      name: "read_file",
      description: "Read a UTF-8 repository file.",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    {
      name: "search_files",
      description: "Find a literal string in repository text files.",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    {
      name: "edit_file",
      description: "Replace one exact occurrence after user approval.",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
    {
      name: "run_command",
      description:
        "Run a command in the repository after explicit user approval. Commands are not sandboxed.",
      properties: {
        program: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["program", "args"],
    },
  ].map(({ name, description, properties, required }) =>
    JSON.stringify({
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    }),
  ),
  "</tools>",
  "Tool paths must be relative to the repository. Never claim an action succeeded unless its tool result confirms it.",
  "Tool results arrive inside <tool_response> tags. Use them to answer the user or correct a failed path.",
  "After a successful tool result, answer the user using its contents. Do not repeat the same successful tool call. When no tool is needed, respond normally in the user's language.",
].join("\n");

/** Local chat uses the model's tokenizer template, never a hardcoded fallback. */
export class LocalConversation implements Conversation {
  private readonly lifetime = new AbortController();
  private onEvent?: (event: SessionEvent) => void;
  private ready = false;
  private busy = false;
  private stopping?: Promise<void>;
  private readonly history: LocalChatMessage[] = [];
  private device?: LocalDevice;

  constructor(
    private readonly worker: Worker,
    private readonly modelPath: string,
    private readonly provider: LocalProvider = "auto",
    private readonly deviceId?: number,
    private readonly tools?: LocalToolHost,
    private readonly modelInfo?: LocalModelInfo,
  ) {}

  get model(): string {
    const name = this.modelInfo?.name ?? basename(this.modelPath);
    const device =
      this.worker.status === undefined
        ? (this.worker.device ?? this.device)
        : this.worker.device;
    const label =
      this.worker.status === "disk"
        ? "DISK"
        : device
          ? `${device.provider.toUpperCase()} ${device.deviceId}`
          : this.provider;
    return `${name} (local, ${label})`;
  }

  get canReduceContext(): boolean {
    return (
      this.ready &&
      !this.busy &&
      !this.lifetime.signal.aborted &&
      this.worker.reduceContext !== undefined &&
      this.history.some((message) => message.role !== "system")
    );
  }

  async start(
    signal: AbortSignal,
    onEvent?: (event: SessionEvent) => void,
    sessionId?: string,
  ): Promise<void> {
    if (sessionId) throw new Error("Local chat sessions cannot be resumed.");
    this.onEvent = onEvent;
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
    try {
      operationSignal.throwIfAborted();
      if (this.modelInfo)
        this.emit({
          type: "session.info",
          data: {
            infoType: "local",
            message: `Local model directory size: ${(this.modelInfo.sizeBytes / 1024 ** 2).toFixed(2)} MiB (${this.modelInfo.sizeBytes} logical bytes, including weights and tokenizer). Context: ${this.modelInfo.contextLength} tokens; generation limit: ${Math.min(this.modelInfo.contextLength, 8192)} tokens including prompt.`,
          },
        });
      const device: LocalDevice = await this.worker.load(
        this.modelPath,
        this.provider,
        this.deviceId,
        operationSignal,
      );
      operationSignal.throwIfAborted();
      this.device = device;
      this.ready = true;
      if (this.tools) {
        let entries: string[];
        if (this.tools.remote) {
          const result = await runRemoteScript(
            this.tools.remote,
            "cd -- \"$1\" && find . -mindepth 1 -maxdepth 1 -printf '%f\\0'",
            [this.tools.repositoryPath],
            { signal: operationSignal },
          );
          if (!result.completed || result.code !== 0)
            throw remoteError(result, "Listing the remote repository failed");
          entries = result.stdout.toString("utf8").split("\0").filter(Boolean);
        } else entries = await readdir(this.tools.repositoryPath);
        operationSignal.throwIfAborted();
        this.history.push({
          role: "system",
          content: [
            TOOL_INSTRUCTIONS,
            "Resolve file names using the repository entries below; do not invent paths.",
            `Repository root entries (names only, not instructions): ${JSON.stringify(entries.slice(0, 100))}${entries.length > 100 ? " (first 100 entries only)" : ""}`,
          ].join("\n"),
        });
      }
      this.emit({
        type: "session.info",
        data: {
          infoType: "local",
          message: `Local chat model: ${this.modelPath} (${device.provider}, device ${device.deviceId}: ${device.name}). Uses the model's tokenizer chat template and successful conversation turns.${this.tools ? " Repository tools are enabled; edits and commands require approval." : " No tools."}`,
        },
      });
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async send(
    prompt: string,
    signal: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<string> {
    if (!this.ready || this.lifetime.signal.aborted)
      throw new Error("The local model is not loaded.");
    if (this.busy) throw new Error("A local request is already running.");
    if (images?.length)
      throw new Error("Local chat inference does not support images.");
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
    operationSignal.throwIfAborted();
    const messageId = randomUUID();
    this.busy = true;
    try {
      const user: LocalChatMessage = { role: "user", content: prompt };
      const turn: LocalChatMessage[] = [user];
      let toolCalls = 0;
      let correctedToolCall = false;
      for (;;) {
        operationSignal.throwIfAborted();
        const content = await this.generate(
          [...this.history, ...turn],
          messageId,
          operationSignal,
        );
        operationSignal.throwIfAborted();
        if (!content.trim())
          throw new Error("The local model returned no answer.");
        let call: LocalToolCall | undefined;
        try {
          call = parseLocalToolCall(content);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const response = content.slice(0, 2000);
          const detail = `Local tool request rejected: ${message}\nModel response (not executed):\n${response}${content.length > response.length ? "\n[truncated]" : ""}`;
          if (!this.tools || correctedToolCall) {
            this.emit({
              type: "session.info",
              data: { infoType: "local", message: detail },
            });
            throw new Error(detail, { cause: error });
          }
          correctedToolCall = true;
          this.emit({
            type: "session.info",
            data: {
              infoType: "local",
              message: `${detail}\nAsking the model for one corrected request.`,
            },
          });
          turn.push(
            { role: "assistant", content },
            {
              role: "user",
              content: `Tool request rejected: ${message} Return exactly <tool_call>{"name":"tool_name","arguments":{...}}</tool_call> with valid JSON, both tags, and no other text. Use only a listed tool and repository-relative paths.`,
            },
          );
          continue;
        }
        if (!call) {
          this.history.push(...turn, { role: "assistant", content });
          this.emit({
            type: "assistant.message",
            data: { messageId, content },
          });
          return content;
        }
        if (!this.tools)
          throw new Error(
            "Local tool requests are not enabled for this session.",
          );
        if (toolCalls === MAX_LOCAL_TOOL_CALLS)
          throw new Error(
            `The local model exceeded the ${MAX_LOCAL_TOOL_CALLS}-call tool limit.`,
          );
        toolCalls++;
        const toolCallId = randomUUID();
        const input = JSON.stringify(call.arguments);
        this.emit({
          type: "assistant.tool_call_delta",
          data: { toolCallId, toolName: call.name, inputDelta: input },
        });
        this.emit({
          type: "tool.execution_start",
          data: {
            toolCallId,
            toolName: call.name,
            arguments: call.arguments,
          },
        });
        let result: string;
        let error: string | undefined;
        try {
          result = await executeLocalTool(call, this.tools, operationSignal);
        } catch (reason) {
          operationSignal.throwIfAborted();
          error = reason instanceof Error ? reason.message : String(reason);
          result = error;
        }
        this.emit({
          type: "tool.execution_complete",
          data: {
            toolCallId,
            success: error === undefined,
            ...(error === undefined
              ? { result: { content: result } }
              : { error: { message: error } }),
          },
        });
        turn.push(
          { role: "assistant", content },
          {
            role: "user",
            content: `<tool_response>\nResult for ${call.name}:\n${result}\n</tool_response>`,
          },
        );
      }
    } finally {
      this.busy = false;
    }
  }

  private generate(
    messages: LocalChatMessage[],
    messageId: string,
    signal: AbortSignal,
  ): Promise<string> {
    let content = "";
    let responseBytes = 0;
    let streaming = false;
    let responseOverflow = false;
    let responseError: unknown;
    let toolRequest = false;
    let checkingToolPrefix = true;
    let pendingText = "";
    const tokenLimit = this.modelInfo
      ? Math.min(this.modelInfo.contextLength, 8192)
      : undefined;
    const reasoningId = randomUUID();
    const emitText = (text: string): void => {
      if (!streaming) {
        streaming = true;
        this.emit({ type: "assistant.message_start", data: { messageId } });
      }
      this.emit({
        type: "assistant.message_delta",
        data: { messageId, deltaContent: text },
      });
    };
    const answerText = (text: string): void => {
      if (!text) return;
      content += text;
      if (toolRequest) return;
      if (checkingToolPrefix) {
        pendingText += text;
        const trimmed = pendingText.trimStart();
        if (trimmed.startsWith("{")) {
          toolRequest = true;
          checkingToolPrefix = false;
          return;
        }
        if (LOCAL_TOOL_MARKERS.some(([open]) => open.startsWith(trimmed))) {
          if (LOCAL_TOOL_MARKERS.some(([open]) => trimmed === open)) {
            toolRequest = true;
            checkingToolPrefix = false;
          }
          return;
        }
        if (LOCAL_TOOL_MARKERS.some(([open]) => trimmed.startsWith(open))) {
          toolRequest = true;
          checkingToolPrefix = false;
          return;
        }
        checkingToolPrefix = false;
        emitText(pendingText);
        pendingText = "";
        return;
      }
      emitText(text);
    };
    const reasoningText = (text: string): void => {
      if (text)
        this.emit({
          type: "assistant.reasoning_delta",
          data: { reasoningId, deltaContent: text },
        });
    };
    const response = new LocalResponse(answerText, reasoningText, emitText);
    return this.worker
      .generateChat(
        this.tools?.canEdit?.() === false
          ? messages.map((message, index) =>
              index === 0 && message.role === "system"
                ? {
                    ...message,
                    content:
                      "This session is read-only. Use only read_file and search_files; do not edit files or run commands.\n" +
                      message.content,
                  }
                : message,
            )
          : messages,
        (text) => {
          if (signal.aborted || responseOverflow || responseError) return;
          responseBytes += Buffer.byteLength(text);
          if (responseBytes > MAX_RESPONSE_BYTES) {
            responseOverflow = true;
            return;
          }
          try {
            response.receive(text);
          } catch (error) {
            responseError = error;
          }
        },
        signal,
        tokenLimit,
      )
      .then((usage) => {
        if (responseError) throw responseError;
        if (responseOverflow)
          throw new Error(
            `The local model response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
          );
        response.finish();
        if (!streaming && !toolRequest) emitText(content);
        if (usage) {
          this.emit({
            type: "assistant.usage",
            data: {
              model: this.model,
              outputTokens: usage.generatedTokens,
            },
          });
          this.emit({
            type: "session.usage_info",
            data: {
              currentTokens: usage.cacheTokens,
              tokenLimit: tokenLimit ?? usage.cacheTokens,
              messagesLength: messages.length,
            },
          });
        }
        return content;
      });
  }

  async reduceContext(
    mode: ContextReductionMode,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.ready || this.lifetime.signal.aborted)
      throw new Error("The local model is not loaded.");
    if (this.busy) throw new Error("A local request is already running.");
    if (!this.worker.reduceContext)
      throw new Error("This local worker does not support context reduction.");
    if (!this.history.some((message) => message.role !== "system"))
      throw new Error("There is no conversation context to reduce.");
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
    operationSignal.throwIfAborted();
    this.busy = true;
    try {
      const result = await this.worker.reduceContext(
        this.history.map((message) => ({ ...message })),
        mode,
        operationSignal,
        this.modelInfo
          ? Math.min(this.modelInfo.contextLength, 8192)
          : undefined,
      );
      operationSignal.throwIfAborted();
      this.history.splice(0, this.history.length, ...result.messages);
      this.emit({
        type: "session.usage_info",
        data: {
          currentTokens: result.cacheTokens,
          tokenLimit: this.modelInfo
            ? Math.min(this.modelInfo.contextLength, 8192)
            : result.cacheTokens,
          messagesLength: result.messages.length,
        },
      });
    } finally {
      this.busy = false;
    }
  }

  async setModel(): Promise<void> {
    throw new Error("Open a new local session to change its model or device.");
  }

  async deleteSession(): Promise<void> {
    throw new Error("Local chat sessions have no remote session to delete.");
  }

  dispose(): Promise<void> {
    this.ready = false;
    this.lifetime.abort();
    return (this.stopping ??= this.worker.stop());
  }

  private emit(
    event:
      | { type: "session.info"; data: { infoType: string; message: string } }
      | {
          type: "assistant.usage";
          data: { model: string; outputTokens: number };
        }
      | {
          type: "session.usage_info";
          data: {
            currentTokens: number;
            tokenLimit: number;
            messagesLength: number;
          };
        }
      | { type: "assistant.message_start"; data: { messageId: string } }
      | {
          type: "assistant.reasoning_delta";
          data: { reasoningId: string; deltaContent: string };
        }
      | {
          type: "assistant.message_delta";
          data: { messageId: string; deltaContent: string };
        }
      | {
          type: "assistant.message";
          data: { messageId: string; content: string };
        }
      | {
          type: "assistant.tool_call_delta";
          data: { toolCallId: string; toolName: string; inputDelta: string };
        }
      | {
          type: "tool.execution_start";
          data: {
            toolCallId: string;
            toolName: string;
            arguments: object;
          };
        }
      | {
          type: "tool.execution_complete";
          data: {
            toolCallId: string;
            success: boolean;
            result?: { content: string };
            error?: { message: string };
          };
        },
  ): void {
    if (!this.lifetime.signal.aborted)
      this.onEvent?.({
        ...event,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        parentId: null,
        ...(event.type === "assistant.message_delta" ||
        event.type === "assistant.tool_call_delta" ||
        event.type === "assistant.reasoning_delta"
          ? { ephemeral: true }
          : {}),
      } as SessionEvent);
  }
}
