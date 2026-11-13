import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CopilotClient,
  CopilotSession,
  SessionEvent,
} from "@github/copilot-sdk" with {
  "resolution-mode": "import",
};
import {
  copilotSessionConfig,
  createCopilotClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type CopilotOptions,
} from "./copilot";
import { parseImages, type ImageAttachment } from "./images";
import type { ContextReductionMode } from "./local-worker";

const MAX_CRASH_RESTARTS = 3;

export class CopilotRecoveryError extends Error {}

function isConnectionFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    ("code" in error &&
      typeof error.code === "number" &&
      [-32099, -32098, -32097, -32096].includes(error.code)) ||
    [
      "Session is disconnected",
      "Connection is closed.",
      "Connection is disposed.",
    ].includes(error.message) ||
    error.message.startsWith("Session disconnected while waiting for ") ||
    /^CLI server (exited( unexpectedly)? with code |connection (closed|failed))/.test(
      error.message,
    )
  );
}

export interface Conversation {
  readonly sessionId?: string;
  /** Model shown above the composer. */
  readonly model?: string;
  readonly canReduceContext?: boolean;
  start(
    signal: AbortSignal,
    onEvent?: (event: SessionEvent) => void,
    sessionId?: string,
  ): Promise<void>;
  send(
    prompt: string,
    signal: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<string>;
  setModel(model: string): Promise<void>;
  reduceContext?(
    mode: ContextReductionMode,
    signal: AbortSignal,
  ): Promise<void>;
  deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export class CopilotConversation implements Conversation {
  private client?: CopilotClient;
  private session?: CopilotSession;
  private readonly lifetime = new AbortController();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private busy = false;
  private savedSessionId?: string;
  private onEvent?: (event: SessionEvent) => void;
  private generation = 0;

  constructor(private readonly options: CopilotOptions) {}

  get sessionId(): string | undefined {
    return this.savedSessionId;
  }

  get model(): string {
    return this.options.model || "Copilot default model";
  }

  start(
    signal: AbortSignal,
    onEvent?: (event: SessionEvent) => void,
    sessionId?: string,
  ): Promise<void> {
    if (!this.starting) {
      this.savedSessionId = sessionId;
      this.onEvent = onEvent;
      this.starting = this.run(
        (operationSignal) => this.connect(operationSignal),
        signal,
      );
    }
    return this.starting;
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    const client = await createCopilotClient(this.options);
    signal.throwIfAborted();
    this.client = client;
    await client.start();
    signal.throwIfAborted();
    const config = {
      ...copilotSessionConfig(this.options),
      streaming: true,
      onEvent: (event: SessionEvent) => {
        if (!this.closed && this.generation === generation) {
          this.onEvent?.(event);
        }
      },
    };
    this.session = this.savedSessionId
      ? await client.resumeSession(this.savedSessionId, {
          ...config,
          allowTranscriptRecovery: false,
          continuePendingWork: false,
        })
      : await client.createSession({ ...config, name: "DevDash Agents" });
    this.savedSessionId = this.session.sessionId;
    signal.throwIfAborted();
  }

  async send(
    prompt: string,
    signal: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<string> {
    const attachments = images?.length
      ? parseImages(images).map((image) => {
          const comma = image.dataUrl.indexOf(",");
          return {
            type: "blob" as const,
            displayName: image.name,
            mimeType: image.dataUrl.slice(5, comma).split(";")[0]!,
            data: image.dataUrl.slice(comma + 1),
          };
        })
      : undefined;
    if (!this.session || this.closed) {
      throw new Error("Select the repository to start its Copilot session.");
    }
    if (this.busy) {
      throw new Error("A request is already running in this repository.");
    }
    this.busy = true;
    try {
      return await this.run(async (operationSignal, recovering, timeoutMs) => {
        if (recovering) await this.connect(operationSignal);
        operationSignal.throwIfAborted();
        const session = this.session;
        if (!session) throw new Error("The Copilot session is not open.");
        const response = await session.sendAndWait(
          {
            ...(attachments ? { attachments } : {}),
            prompt: recovering
              ? [
                  "The Copilot process disconnected while handling this request.",
                  "Complete the request below using the saved conversation and current state, not by starting over.",
                  "First inspect recorded tool results and the current repository state.",
                  "Do not blindly repeat commands, writes, commits or pushes whose completion is uncertain.",
                  "Ask the user before repeating an external or destructive action if its completion cannot be established safely.",
                  "Request to complete (may already be partially executed):",
                  prompt,
                ].join("\n")
              : prompt,
          },
          timeoutMs,
        );
        if (!response?.data.content.trim()) {
          throw new Error("Copilot returned no answer.");
        }
        return response.data.content;
      }, signal);
    } finally {
      this.busy = false;
    }
  }

  async setModel(model: string): Promise<void> {
    if (!this.session || this.closed) {
      throw new Error("The Copilot session is not open.");
    }
    await this.session.setModel(model);
    this.options.model = model;
  }

  deleteSession(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.run(
      async (operationSignal) => {
        if (!this.client) {
          const client = await createCopilotClient(this.options);
          operationSignal.throwIfAborted();
          this.client = client;
          await client.start();
        }
        operationSignal.throwIfAborted();
        if (await this.client.getSessionMetadata(sessionId)) {
          operationSignal.throwIfAborted();
          await this.client.deleteSession(sessionId);
        }
      },
      signal,
      false,
    );
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    return (this.stopping ??= this.client?.forceStop() ?? Promise.resolve());
  }

  private async run<T>(
    action: (
      signal: AbortSignal,
      recovering: boolean,
      timeoutMs: number,
    ) => Promise<T>,
    callerSignal: AbortSignal,
    allowRecovery = true,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("This Copilot session has ended.");
    }
    callerSignal.throwIfAborted();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      callerSignal,
      this.lifetime.signal,
      deadline.signal,
    ]);
    const timeout = setTimeout(
      () =>
        deadline.abort(
          new Error(`Copilot request timed out after ${timeoutMs}ms.`),
        ),
      timeoutMs,
    );
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      const recover = async (): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted();
          try {
            return await action(signal, attempt > 0, timeoutMs);
          } catch (error) {
            signal.throwIfAborted();
            if (!allowRecovery || !isConnectionFailure(error)) {
              if (attempt)
                throw new CopilotRecoveryError(
                  `Copilot could not resume after its process crashed: ${error instanceof Error ? error.message : String(error)}. Choose Open Copilot session to retry, or choose New session.`,
                  { cause: error },
                );
              throw error;
            }
            if (attempt === MAX_CRASH_RESTARTS)
              throw new CopilotRecoveryError(
                `Copilot recovery stopped after ${MAX_CRASH_RESTARTS} automatic restarts: ${error.message}. Select the repository to retry, or choose New session.`,
                { cause: error },
              );
            this.generation++;
            this.onEvent?.({
              id: randomUUID(),
              parentId: null,
              timestamp: new Date().toISOString(),
              type: "session.warning",
              data: {
                warningType: "crash_recovery",
                message: `Copilot disconnected: ${error.message}\nAutomatic recovery ${attempt + 1}/${MAX_CRASH_RESTARTS}. ${this.savedSessionId ? "Resuming the saved session." : "Restarting the process."}`,
              },
            });
            await this.client?.forceStop();
            signal.throwIfAborted();
            await delay(250 * 2 ** attempt, undefined, { signal });
          }
        }
      };
      return await Promise.race([recover(), cancelled]);
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      clearTimeout(timeout);
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}
